# MedCode public model 用量统计增强实施方案

| 字段 | 内容 |
| --- | --- |
| 状态 | Draft |
| 日期 | 2026-06-30 |
| 范围 | `max` / `expert` / `pro` / `standard` public model 的用量统计与运营观测 |
| 非目标 | 不做模型级 plan 授权，不做新的 token quota 拦截，不改变用户调用行为 |

## 1. 结论

本阶段只做统计增强，不做准入拦截。

产品和权限原则：

- 所有 active plan 都可以自由使用所有 enabled public model。
- plan 只决定有效期、scope、capabilities 和既有通用额度，不决定某个 public model 是否可用。
- public model 是否可用只由 Gateway 的 public model registry 控制。
- 不新增 `Pro plan -> Pro model`、`Expert plan -> Expert model` 这类绑定。
- `feature_policy.medcode_models.allowed` 仅作为兼容元数据保留，不作为 chat model 授权依据。

统计原则：

- 每次请求都记录 public model 维度：`max` / `expert` / `pro` / `standard`。
- 内部运营报表可以看到 runtime、真实 upstream model、reasoning effort。
- 面向收费/客户端的外部查询只暴露 public model id 和汇总指标，不暴露真实 upstream model、OpenRouter 路由或内部账号。
- token usage 继续记录原始 token，不把 raw token 直接当作跨模型等价的用户额度。
- 本阶段不启用新的 token 上限或模型用量拦截。

## 2. 当前基础

已经具备的能力：

- `request_events` 已有 `public_model_id`、`upstream_runtime`、`upstream_model` 字段。
- `report-usage` 已能输出 request/token 聚合字段，并在当前实现中带出 public model/runtime/upstream model。
- `token_reservations` 是 token 账务事实表，`report-usage` 的 token 列优先从这里聚合。
- public model registry 已能表达 `max`、`expert`、`pro`、`standard` 及其 runtime、upstream model、reasoning 配置。

当前不足：

- `token_reservations` 没有自己的模型快照字段，token 聚合需要 join `request_events` 才能拿到模型维度；如果 finalize 已成功但 observation 写 `request_events` 前进程崩溃，token 账务不丢，但模型归因会降级。
- request event 没有记录 reasoning effort 和 reasoning tokens，不利于评估 `none` / `high` 的稳定性和成本差异。
- `report-usage` 虽然带模型字段，但缺少清晰的 `按模型汇总`、`按用户+模型汇总` 和模型过滤入口。
- quota dashboard 仍以用户/plan/token window 为主，没有模型维度的全局健康视图。
- Billing Admin `/usage` 需要明确哪些模型字段可以对外返回，哪些只供内部 CLI/ops 使用。

## 3. 非目标

本方案明确不做：

- 不把 model allowlist 写入 plan policy。
- 不按 public model 配置用户级授权。
- 不新增 per-model token limit、credit limit 或 429 拦截。
- 不修改 active plan 的用户可用模型集合。
- 不把上游模型名、OpenRouter provider、Codex account id 暴露给客户端或普通收费侧页面。
- 不引入价格表或真实金额结算。

后续如果要做成本控制，优先考虑平台级模型安全阈值，例如全局并发、模型开关、超时和熔断，而不是把 plan 复杂化。

## 4. 数据模型增强

### 4.1 request_events

保留已有字段：

```text
public_model_id
upstream_runtime
upstream_model
```

新增可空字段：

- `reasoning_effort TEXT`
- `reasoning_tokens INTEGER`

迁移必须沿用 `packages/store-sqlite/src/migrations.ts` 的编号迁移模式：当前主库已到 version 16，本方案落地时使用下一个可用版本（当前应为 17），并对每个新增列使用 `columnExists` 守卫。不要使用裸 `ALTER TABLE ... ADD COLUMN` 作为可重复执行的示例。

字段含义：

| 字段 | 含义 |
| --- | --- |
| `reasoning_effort` | Gateway 实际发给上游的 reasoning effort 快照，如 `none`、`low`、`medium`、`high`；无该概念时为 `NULL` |
| `reasoning_tokens` | provider usage 中的 reasoning token 数；上游不返回时为 `NULL` |

注意：`reasoning_effort` 是内部观测字段，不进入 OpenAI-compatible response。

### 4.2 token_reservations

为 token 账务事实表增加模型快照，避免依赖 `request_events` join 才能按模型归因：

新增可空字段和索引：

- `public_model_id TEXT`
- `upstream_runtime TEXT`
- `upstream_model TEXT`
- `reasoning_effort TEXT`
- `final_reasoning_tokens INTEGER`
- `idx_token_reservations_public_model_created`

迁移实现示例：

```ts
applyMigration(
  db,
  17,
  () => {
    if (!columnExists(db, "request_events", "reasoning_effort")) {
      db.exec("ALTER TABLE request_events ADD COLUMN reasoning_effort TEXT");
    }
    if (!columnExists(db, "request_events", "reasoning_tokens")) {
      db.exec("ALTER TABLE request_events ADD COLUMN reasoning_tokens INTEGER");
    }

    if (!columnExists(db, "token_reservations", "public_model_id")) {
      db.exec("ALTER TABLE token_reservations ADD COLUMN public_model_id TEXT");
    }
    if (!columnExists(db, "token_reservations", "upstream_runtime")) {
      db.exec("ALTER TABLE token_reservations ADD COLUMN upstream_runtime TEXT");
    }
    if (!columnExists(db, "token_reservations", "upstream_model")) {
      db.exec("ALTER TABLE token_reservations ADD COLUMN upstream_model TEXT");
    }
    if (!columnExists(db, "token_reservations", "reasoning_effort")) {
      db.exec("ALTER TABLE token_reservations ADD COLUMN reasoning_effort TEXT");
    }
    if (!columnExists(db, "token_reservations", "final_reasoning_tokens")) {
      db.exec("ALTER TABLE token_reservations ADD COLUMN final_reasoning_tokens INTEGER");
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_token_reservations_public_model_created
        ON token_reservations(public_model_id, created_at);
    `);
  },
  logger
);
```

写入规则：

- `beginTokenBudget` / `beginSoftWrite` 时从 `ChatRuntimeContext` 快照 public model、runtime、upstream model、reasoning effort。
- `finalizeTokenBudget` / `finalizeSoftWrite` 时写入 provider usage 的 `reasoningTokens`，没有则为 `NULL`。
- 这些字段只做统计，不参与 acquire/reject 判断。

兼容规则：

- 历史行字段为 `NULL`。
- 统计时把 `NULL public_model_id` 归入 `unknown` 或 `legacy`，但不要回填猜测值。
- 非空 `public_model_id` 在查询/展示前必须用当前 public model registry 做 alias 归一：`registry.get(storedId)?.id ?? storedId`。
- 当前 `medcode` 是 `max` 的 legacy alias。改名前已经写入的 `public_model_id=medcode` 必须在 `report-usage`、quota dashboard、Billing `/usage` 展示层归入 `max` 桶；不要让同一时间窗同时出现 `max` 和 `medcode` 两个顶档模型桶。
- `--model max` / `public_model_id=max` filter 也应匹配 canonical id 及其 aliases，例如 `max` 和 `medcode`；实现上可以在 SQL 中使用 alias 集合过滤，或先查细粒度行再在 TypeScript 层归并。
- schema migration 必须 additive，可重复执行。

### 4.3 core 类型

扩展 `TokenUsage`：

```ts
interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
}
```

如果已有类型包含 `reasoningTokens`，只需要把它贯通到 request event 和 reservation final fields。

扩展 token budget 输入：

```ts
interface ModelUsageAttribution {
  publicModelId: string | null;
  upstreamRuntime: string | null;
  upstreamModel: string | null;
  reasoningEffort: string | null;
}
```

`AcquireInput` 和 `SoftWriteBeginInput` 增加上述 attribution，供 SQLite 快照使用。

## 5. 网关写入链路

### 5.1 runtime context

`ChatRuntimeContext` 已经包含：

- `publicModelId`
- `runtime`
- `runtimeInstanceId`
- `providerKind`
- `upstreamModel`

补充 helper：

```ts
function reasoningEffortForModel(model: PublicModelConfig): string | null
```

逻辑：

- `model.reasoning.effort` 是字符串时记录该值。
- 无 reasoning 配置时为 `NULL`。
- 只接受已知枚举值；未知值记录 `custom` 或 `NULL`，同时 logger warn。
- `publicModelId` 使用 registry 解析后的 canonical `model.id`，不要使用客户端传入的 alias。也就是说，新写入数据中 `model=medcode` 和 `model=max` 都应记录为 `public_model_id=max`。

### 5.2 observation

`recordObservation` 写 `request_events` 时同步写入：

- `public_model_id`
- `upstream_runtime`
- `upstream_model`
- `reasoning_effort`
- `reasoning_tokens`

请求失败也要记录模型维度，只要请求已经成功解析 public model。

模型解析失败的 `model_not_found`：

- `public_model_id` 记录客户端传入值可以考虑单独字段，但本阶段不新增；保持为 `NULL`。
- `error_code=model_not_found` 足够用于排查客户端配置错误。

### 5.3 token reservation

所有有 provider 调用的 chat 请求都应该走 reservation 或 soft-write ledger：

- 有 token policy：`acquire -> finalize`
- 无 token policy：`beginSoftWrite -> finalizeSoftWrite`

两条路径都写模型快照字段。这样即使不启用 token quota，仍然可以用 `token_reservations` 做稳定的 token 统计源。

实现和测试需要显式断言无 token policy 的请求确实写入 `kind=soft_write` 的 ledger 行，并携带同一份 public model / runtime / upstream model / reasoning effort 快照；否则在不启用 quota 的 key 上会留下统计盲区。

## 6. 报表增强

### 6.1 Admin CLI `events`

保持现有逐请求输出，并新增：

```json
{
  "public_model_id": "expert",
  "upstream_runtime": "openrouter",
  "upstream_model": "z-ai/glm-5.2",
  "reasoning_effort": "high",
  "reasoning_tokens": 1234
}
```

`events` 是内部运维命令，可以展示 upstream model。

示例中的 `upstream_model` 只表达字段形态；实现和测试以当前 public model registry 的实际值为准，不在报表代码里写死具体上游模型名。

### 6.2 Admin CLI `report-usage`

新增过滤参数：

```text
--model <public_model_id>
--runtime <codex|openrouter>
--provider <provider>
```

新增汇总模式：

```text
--group-by model
--group-by user-model
--group-by entitlement-model
```

输出字段保留已有字段，并增加：

```json
{
  "public_model_id": "expert",
  "model_display_name": "Expert",
  "upstream_runtime": "openrouter",
  "upstream_model": "z-ai/glm-5.2",
  "reasoning_effort": "high",
  "requests": 120,
  "ok": 112,
  "errors": 8,
  "rate_limited": 0,
  "avg_duration_ms": 18342,
  "avg_first_byte_ms": 2140,
  "prompt_tokens": 5200000,
  "completion_tokens": 940000,
  "reasoning_tokens": 310000,
  "total_tokens": 6140000,
  "usage_missing": 3
}
```

聚合口径：

- request count、ok/error、duration 来自 `request_events`。
- token 列优先来自 `token_reservations`。
- 如果 `token_reservations.public_model_id` 为 `NULL`，再尝试 join `request_events` 兼容旧数据。
- 所有 group/filter key 在输出前先做 registry alias 归一；历史 `medcode` 行归入 canonical `max`。
- `usage_missing` 统计 `final_usage_source != 'provider'` 或 request event `usage_source != 'provider'` 的次数。

### 6.3 Billing Admin `/usage`

增强查询参数：

```text
GET /gateway/admin/billing/v1/usage?...&group_by=model
GET /gateway/admin/billing/v1/usage?...&public_model_id=expert
```

实现注意：Billing Admin `/usage` 不是 `RequestUsageReportInput` 这条 Admin CLI 查询链路。它使用 `packages/core/src/billing.ts` 中独立的 `BillingUsageReportInput` / `BillingUsageGroupBy` / `BillingUsageReportRow`，并经过 `apps/gateway/src/billing-admin.ts` 的 query 解析与响应 shaping。新增 `group_by=model` 和 `public_model_id` filter 时，需要同时扩展 billing 类型、SQLite billing report 实现、Gateway Billing route 解析和响应结构；可以复用同一套 alias 归一逻辑，但不要只改 request usage store API。

对收费/会员中心默认只返回 public 字段：

```json
{
  "public_model_id": "expert",
  "model_display_name": "Expert",
  "requests": 120,
  "ok": 112,
  "errors": 8,
  "prompt_tokens": 5200000,
  "completion_tokens": 940000,
  "total_tokens": 6140000
}
```

默认不返回：

- `upstream_model`
- `upstream_runtime`
- `upstream_account_id`
- `reasoning_effort`

如内部运营确实需要，可以只在 admin CLI 暴露，避免 API 被外部系统误用后形成泄露面。

### 6.4 Quota Dashboard

`/gateway/admin/quota-dashboard` 当前是用户 / plan / token quota 运营页。模型统计增强后，该页面应继续保持“运营监控工具”的定位：第一屏先回答当前服务是否健康、哪些模型正在被使用、是否有异常；向下再回答哪些用户造成了这些使用量。不要把页面改成套餐销售页或模型权限管理页。

页面增强目标：

- 在现有用户 quota 视图之前增加模型维度的全局视图。
- 保留现有用户表、token window、每日 token 趋势和 warning 行为。
- 所有模型相关控件只影响展示和筛选，不触发 plan 授权或限额配置。
- 内部页面可以显示 upstream runtime / upstream model，但需要明确标为内部字段；后续如给收费侧复用，应隐藏这些字段。

#### 6.4.1 页面信息架构

增强后的页面从上到下分为六块：

1. **Header / Controls**
   - 标题、生成时间、数据窗口、实时监控入口。
   - 全局筛选：时间窗口、public model、用户状态、异常状态。

2. **Summary Strip**
   - 沿用现有汇总卡：用户数、active entitlements、legacy、无 quota、quota 用尽。
   - 新增模型汇总卡：活跃模型数、7d 模型请求数、7d 模型 token、7d 模型错误率。

3. **Model Mix**
   - 显示各 public model 在 24h / 7d / 30d 的请求、token、用户数占比。
   - 用于快速判断流量是否集中到 `expert` / `max`。

4. **Model Health**
   - 显示各 public model 的成功率、错误率、rate limited、平均耗时、平均 first byte。
   - 用于发现某个模型慢、失败多、usage 缺失多。

5. **Daily Token Usage**
   - 沿用现有每日 token 图。
   - 增加按模型切换/堆叠展示能力。

6. **User Table**
   - 沿用现有用户 quota 表。
   - 增加“模型使用分布”和“主要模型”列。
   - 点击用户行可展开用户的模型 breakdown。

#### 6.4.2 顶部筛选与交互

顶部使用紧凑的工具条，控件保持可扫描：

| 控件 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| 时间窗口 | segmented control | `7d` | 可选 `24h` / `7d` / `30d`，影响 Model Mix、Model Health、User Table 的模型统计 |
| 模型 | chip multi-select | all | `max` / `expert` / `pro` / `standard`，只过滤展示 |
| 用户状态 | tabs 或 segmented control | active | `active` / `all`，沿用现有 `include_inactive` |
| 异常筛选 | checkbox group | off | `errors` / `rate limited` / `quota exhausted` / `usage missing` |
| 搜索 | text input | empty | 按用户显示名、subject id、credential prefix 搜索 |
| 刷新 | icon button | manual | 重新拉取 JSON；不自动刷新主页面，实时视图仍走现有 realtime 页面 |

交互规则：

- 任一筛选变化后，页面不重新请求服务端；优先在已加载 JSON 上本地过滤。
- 点击 Model Mix 或 Model Health 中的某个模型，相当于切换模型筛选。
- 再次点击已选模型取消筛选。
- 筛选状态需要同步到 URL query，例如 `?window=7d&models=expert,pro&status=active`，方便运营分享同一视图。
- 数据刷新后保留当前筛选状态。

#### 6.4.3 Summary Strip

保留现有卡片：

- Users
- Active Entitlements
- Legacy
- Users Without Quota
- Exhausted Users

新增卡片：

| 卡片 | 口径 |
| --- | --- |
| Active Models | 当前窗口内 `requests > 0` 的 public model 数 |
| Model Requests | 当前窗口内所有模型请求总数 |
| Model Tokens | 当前窗口内所有模型 `total_tokens` |
| Model Error Rate | 当前窗口内 `errors / requests` |

显示规则：

- error rate >= 10% 显示 warning 色。
- `usage_missing > 0` 时，在 Model Tokens 卡片下方显示小号提示：`missing usage: N`。
- 不显示真实成本，不显示价格。

#### 6.4.4 Model Mix 区块

布局：

- 左侧：按模型的水平条形图，展示请求占比和 token 占比。
- 右侧：模型汇总表。

表格列：

| 列 | 含义 |
| --- | --- |
| Model | public model id + display name |
| Requests | 当前窗口请求数 |
| Users | 当前窗口内使用过该模型的用户数 |
| Total tokens | `prompt + completion` |
| Prompt | prompt tokens |
| Completion | completion tokens |
| Reasoning | reasoning tokens；无数据时 `-` |
| Share | token 占比 |

交互：

- 点击表头可按 requests、users、total tokens、share 排序。
- 点击模型行应用模型筛选。
- hover 条形图显示请求数、token 数和用户数。

空状态：

- 当前筛选无模型流量时显示 `No model usage in this window.`。
- 不显示“配置错误”类文案，避免把无流量误导成服务异常。

#### 6.4.5 Model Health 区块

布局：

- 一行一个 public model，适合四档模型固定展示。
- 即使某个模型当前窗口无请求，也保留一行，状态显示 `idle`。

表格列：

| 列 | 含义 |
| --- | --- |
| Model | public model id + display name |
| Runtime | `codex` / `openrouter`，内部字段 |
| Upstream | 真实 upstream model，内部字段 |
| Effort | reasoning effort，如 `none` / `high` |
| OK rate | `ok / requests` |
| Errors | error count + error rate |
| Rate limited | rate limited count |
| Avg duration | 平均总耗时 |
| Avg first byte | 平均首字节耗时 |
| Usage missing | provider usage 缺失次数 |

状态规则：

- `requests = 0`：状态 `idle`。
- `error_rate >= 10%` 或 `usage_missing > 0`：状态 `watch`。
- `error_rate >= 25%` 或 `avg_first_byte_ms` 超过内部阈值：状态 `degraded`。
- 第一版阈值只用于页面标色和排序，不触发自动熔断。

交互：

- 点击 `Errors` 数字可过滤用户表到该模型 + error 用户。
- 点击 `Usage missing` 可过滤用户表到 usage missing 用户。
- Upstream 字段默认显示；后续如复用到外部页面，应通过 `internal: false` 数据模式隐藏。

#### 6.4.6 Daily Token Usage 区块

沿用现有每日 token 用量图，增加两个视图模式：

| 模式 | 作用 |
| --- | --- |
| Total | 当前行为：全用户 token 总量趋势 |
| By model | 按 public model 堆叠或分组显示 token 趋势 |

交互：

- 模型筛选会影响图表。
- hover 某天显示每个模型的 token、request、error count。
- 点击某天把用户表筛到该日窗口。

实现建议：

- 第一版可以使用现有 div/CSS bar chart，不引入图表依赖。
- 模型颜色固定，不随筛选变化：
  - `max`: neutral dark
  - `expert`: blue
  - `pro`: green
  - `standard`: amber
- 颜色只是区分，不表达套餐等级或优劣。

#### 6.4.7 User Table 增强

现有用户表保留以下列：

- 用户
- Plan / Entitlement
- Quota
- 今日请求 / token
- 7d 请求 / token
- warnings

新增列：

| 列 | 含义 |
| --- | --- |
| Primary model | 当前窗口 token 最多的 public model |
| Model mix | 四个模型的紧凑占比条 |
| Expert/Max tokens | `expert + max` token 合计，用于快速发现高成本/高风险使用 |
| Model errors | 当前窗口模型错误数 |

行展开内容：

- 用户按模型 breakdown 表：
  - model
  - requests
  - ok
  - errors
  - rate limited
  - prompt tokens
  - completion tokens
  - reasoning tokens
  - total tokens
  - avg duration
  - avg first byte
- 最近 5 条异常请求：
  - request id
  - public model
  - error code
  - started at
  - duration
  - usage source

排序规则：

- 默认仍按 7d total tokens / requests 排序，保持当前运营习惯。
- 增加排序项：
  - expert/max tokens desc
  - model errors desc
  - usage missing desc
  - primary model

筛选规则：

- 选择某个模型后，用户表只计算该模型的使用量，但 quota 列仍显示全局用户 quota。
- 用户 warning 不因为模型筛选而隐藏，避免运营漏看 quota/entitlement 问题。

#### 6.4.8 JSON 数据合同

`/gateway/admin/quota-dashboard.json` 增加：

```ts
interface DashboardData {
  model_window: {
    kind: "24h" | "7d" | "30d";
    since: string;
    until: string;
  };
  model_summary: {
    active_models: number;
    requests: number;
    ok: number;
    errors: number;
    rate_limited: number;
    total_tokens: number;
    reasoning_tokens: number;
    usage_missing: number;
  };
  models: DashboardModelUsage[];
}

interface DashboardModelUsage {
  public_model_id: string;
  display_name: string;
  upstream_runtime: string | null;
  upstream_model: string | null;
  reasoning_effort: string | null;
  requests: number;
  users: number;
  ok: number;
  errors: number;
  rate_limited: number;
  avg_duration_ms: number | null;
  avg_first_byte_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  usage_missing: number;
  daily: Array<{
    date: string;
    requests: number;
    total_tokens: number;
    errors: number;
  }>;
}
```

`DashboardUser` 增加：

```ts
interface DashboardUser {
  primary_model_id: string | null;
  model_usage: DashboardUserModelUsage[];
  model_errors: number;
  expert_max_tokens: number;
}

interface DashboardUserModelUsage {
  public_model_id: string;
  requests: number;
  ok: number;
  errors: number;
  rate_limited: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  avg_duration_ms: number | null;
  avg_first_byte_ms: number | null;
  usage_missing: number;
}
```

兼容规则：

- 新字段只新增，不重命名现有字段。
- 前端 JS 对缺失 `models` / `model_usage` 的旧 JSON 必须降级为空数组。
- `upstream_model` 是内部字段；如未来支持外部模式，服务端应提供 `include_internal_model_fields=false`。

#### 6.4.9 响应式和可读性要求

桌面：

- Summary Strip 使用紧凑卡片，不做大号营销式 hero。
- Model Mix 和 Model Health 上下排列或两列排列，取决于宽度；表格优先保证可读。
- User Table 保持密集运营表格，横向滚动可接受，但关键列（用户、quota、primary model）应靠左。

移动或窄屏：

- 顶部筛选换行，chip 可以横向滚动。
- Model Mix 优先显示表格，图表可折叠。
- User Table 切换为每用户折叠块，默认只显示用户、quota 状态、primary model、7d token。

文案：

- 页面内不要解释“如何使用模型”或“模型档位差异”；这是运营页，不是用户文档。
- `Expert/Max tokens` 一类内部运营指标只描述事实，不暗示用户违规。
- 所有 upstream 字段标注 `internal`，避免截图给外部时误解。

#### 6.4.10 安全边界

- 页面不得显示 API key、完整 credential、Bearer token、ChatGPT auth、OpenRouter key。
- credential 只能显示 prefix。
- request id 可以显示完整值，用于内部排查。
- upstream model 仅在当前 admin 页面显示；Billing `/usage` 和客户端接口默认不返回。
- 不新增任何可写操作；本页面仍是只读 dashboard。

#### 6.4.11 第一版最小切片

如果一次实现全部 UI 太大，第一版按下面切：

1. `/gateway/admin/quota-dashboard.json` 增加 `models` 和 `users[].model_usage`。
2. 页面顶部增加时间窗口和模型筛选。
3. 增加 Model Mix 表格。
4. 用户表增加 `Primary model` 和 `Model mix` 两列。
5. 暂缓 Model Health 的阈值标色、行展开异常请求和 By model daily chart。

这样可以先满足“看清四档模型使用分布”，后续再补健康诊断深度。

## 7. 查询实现建议

### 7.1 store API

扩展 `RequestUsageReportInput`：

```ts
interface RequestUsageReportInput {
  since: Date;
  until?: Date;
  credentialId?: string;
  subjectId?: string;
  publicModelId?: string;
  upstreamRuntime?: string;
  provider?: ProviderKind;
  groupBy?: "default" | "entitlement" | "model" | "user-model" | "entitlement-model";
}
```

扩展 `RequestUsageReportRow`：

```ts
interface RequestUsageReportRow {
  publicModelId: string | null;
  upstreamRuntime: string | null;
  upstreamModel: string | null;
  reasoningEffort?: string | null;
  reasoningTokens?: number;
  usageMissing?: number;
}
```

注意：本节只描述 Admin CLI / request usage store API。Billing Admin `/usage` 使用独立的 `BillingUsageReportInput`、`BillingUsageGroupBy` 和 `reportBillingUsage` 合同；新增模型维度时需要在两套接口上分别扩展，不能只把 `groupBy: "model"` 加到 `RequestUsageReportInput`。

### 7.2 SQL 口径

request 聚合：

- source: `request_events`
- dimensions: date、subject、credential、entitlement、public model、runtime、provider
- metrics: requests、ok、errors、rate_limited、duration、first_byte、limit_kind

token 聚合：

- source: `token_reservations`
- dimensions: `day_window_start`、subject、credential、entitlement、public model、runtime、provider
- metrics: final prompt/completion/total/cached/reasoning tokens、source 分布

合并规则：

- 以维度 key 合并 request 聚合和 token 聚合。
- 维度 key 中的 public model 先做 alias 归一，`medcode` 与 `max` 合并为 `max`。
- token-only 行允许存在，表示 request observation 丢失但 ledger 存在；也可能来自既有日期桶错位：token 聚合按 `day_window_start`，request 聚合按 `started_at`，跨 UTC 日边界时会落到不同 `date` key。
- request-only 行允许存在，表示历史数据或无 token ledger 路径。

### 7.3 模型字典

报表展示分两步处理。

第一步，先做 canonical public model id 归一：

- 对非空 `storedId` 使用 `registry.get(storedId)?.id ?? storedId`。
- 当前 registry 中 `medcode` 是 `max` 的 alias，因此历史 `storedId=medcode` 必须归一为 `max`。
- filter 也按 canonical id 展开 aliases：`--model max` 应查询 `public_model_id IN ('max', 'medcode')`，或在应用层读取细粒度行后归并。
- 对 `NULL` 仍按 `unknown` / `legacy` 处理，不猜测归入某个模型。

第二步，display name 从当前 public model registry 读取：

- `max` -> `Max`
- `expert` -> `Expert`
- `pro` -> `Pro`
- `standard` -> `Standard`

历史模型如果当前 registry 已删除、改名且没有保留 alias：

- `model_display_name` 使用归一后的 `public_model_id` 原值。
- 不尝试回填历史 display name。

## 8. 验证计划

### 8.1 单元测试

新增覆盖：

- schema migration 在已有 DB 上 additive 成功，且重复调用不会因为已存在列报错。
- `request_events` 可写入 `reasoning_effort` / `reasoning_tokens`。
- `token_reservations` 可写入模型快照字段。
- `reportRequestUsage({ groupBy: "model" })` 能按 `public_model_id` 汇总。
- `reportRequestUsage({ publicModelId: "expert" })` 只返回 Expert 数据。
- 历史 `public_model_id=medcode` 和新 `public_model_id=max` 在 `groupBy: "model"` 下合并成单个 `max` 桶；`publicModelId: "max"` filter 同时匹配 `max` 和 `medcode`。
- token ledger 有模型字段时，不依赖 `request_events` 也能按模型汇总 token。
- 历史 `NULL public_model_id` 行被归入 `unknown` 或保持 `null`，不会导致 JSON 输出失败。
- `feature_policy.medcode_models.allowed` 不参与 chat model 授权。
- Billing usage 的 `BillingUsageGroupBy` / `BillingUsageReportInput` 独立覆盖 `group_by=model` 和 `public_model_id` filter，不只覆盖 request usage store API。

### 8.2 Gateway route 测试

覆盖：

- `model=expert` 成功请求写入 `public_model_id=expert`、`reasoning_effort=high`。
- `model=pro` 成功请求写入 `public_model_id=pro`、`reasoning_effort=none`。
- `model=standard` 成功请求写入 `public_model_id=standard`。
- `model=max` 或 alias `medcode` 成功请求都写入 canonical `public_model_id=max`。
- streaming、non-streaming、strict tools 都能写入模型维度。
- provider usage 带 reasoning tokens 时写入 `reasoning_tokens`。
- 无 token policy 的请求写入 `token_reservations.kind=soft_write`，并带上模型快照字段。
- active entitlement 不含 `medcode_models.allowed` 或 allowed 不包含某模型时，请求仍可用，只要 public model registry enabled。

### 8.3 CLI 测试

覆盖：

- `events` 输出模型字段和 reasoning 字段。
- `report-usage --group-by model --days 7` 输出按模型汇总 JSON。
- `report-usage --model expert --days 7` 只包含 Expert。
- `report-usage --group-by user-model` 能定位用户模型使用分布。
- stdout 保持纯 JSON，没有 migration/logger 噪声。

### 8.4 手动 smoke

用临时 key 顺序调用：

```text
model=max
model=expert
model=pro
model=standard
```

然后检查：

```text
events --limit 20
report-usage --days 1 --group-by model
report-usage --days 1 --group-by user-model
```

验收点：

- 四个 public model 都能出现在统计里。
- 请求成功/失败都能正确归因。
- 没有因为模型或 plan 产生新的 403/429。
- 临时 key 清理后无残留 active credentials。

## 9. 实施阶段

### Phase A：模型快照字段

- SQLite migration：`request_events` 和 `token_reservations` 增加模型/effort/reasoning token 字段。
- core/store row mapper 更新。
- Gateway observation 和 token-budget hook 贯通字段。
- 单元测试覆盖 migration 和写入。

### Phase B：report-usage 增强

- 扩展 `RequestUsageReportInput.groupBy` 和 filters。
- 实现 `model`、`user-model`、`entitlement-model` 聚合。
- 实现 public model alias 归一，确保历史 `medcode` 行并入 `max`。
- Admin CLI 增加参数和 JSON 输出。
- 覆盖 CLI 测试。

### Phase C：Dashboard 和 Billing Usage

- quota dashboard 按 6.4 的页面设计增加 Header filters、Summary Strip 模型卡片、Model Mix、Model Health、Daily Token Usage by model、User Model Usage。
- 第一版最小切片至少包含 JSON 数据、模型筛选、Model Mix 表格、用户表 Primary model / Model mix 列。
- Billing Admin `/usage` 在独立 billing 类型/路由/SQLite 实现链路中支持 `group_by=model` 和 `public_model_id` filter。
- Billing API 默认只返回 public model 字段，不返回 upstream 内部字段。

### Phase D：文档和运行手册

- 更新 `docs/operations/internal-trial-runbook.md` 的日常检查命令。
- 更新 system status，说明统计增强已上线但没有模型级 plan 限制。
- 更新消费者文档，说明所有 enabled public models 对 active plan 可用，具体可用模型以 `/v1/models` 为准。

## 10. 验收标准

- [ ] 所有 active plan 可以继续调用所有 enabled public model。
- [ ] 不新增任何基于 public model 的 403/429。
- [ ] `events` 能看到每个请求的 public model、runtime、upstream model、reasoning effort。
- [ ] `report-usage --group-by model` 能按 `max` / `expert` / `pro` / `standard` 汇总请求和 token，且历史 `medcode` 行归并到 `max`。
- [ ] `report-usage --group-by user-model` 能定位每个用户的模型使用分布。
- [ ] token 聚合优先从 `token_reservations` 读取，并能在缺少 request event 时保留模型归因。
- [ ] Billing `/usage` 通过独立 billing report 链路支持模型维度，只暴露 public model 维度，不泄露 upstream model。
- [ ] quota dashboard JSON 包含 `models`、`model_summary`、`users[].model_usage`，且旧 JSON 缺字段时前端可降级。
- [ ] quota dashboard 顶部支持时间窗口、模型、用户状态、异常状态和搜索筛选。
- [ ] quota dashboard 显示 Model Mix、Model Health、Daily Token Usage by model 和 User Model Usage。
- [ ] quota dashboard 用户表包含 `Primary model`、`Model mix`、`Expert/Max tokens`、`Model errors`。
- [ ] quota dashboard 不新增任何写操作，不显示 API key 或 secret；upstream model 字段只作为内部字段展示。
- [ ] 旧数据、NULL 模型字段、历史 `medcode` alias、历史无 token ledger 行，以及 request/token 日期桶错位行都能被报表兼容处理。
- [ ] public OpenAI smoke、strict tools smoke、native tools smoke 通过。

## 11. 后续可选项

本方案上线并观察 1-2 周后，再决定是否需要：

- p50 / p95 latency 聚合。
- provider usage missing rate 告警。
- 每个 public model 的全局并发观察和手动开关面板。
- 内部估算成本报表。
- image generation usage 与 text model usage 的统一运营视图。

这些都应保持统计/运营属性，不自动变成 plan 授权规则。
