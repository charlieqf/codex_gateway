# MedCode GoldenCode 4 平台 sticky 均衡实施方案

| 字段 | 内容 |
| --- | --- |
| 状态 | Draft |
| 日期 | 2026-07-02 |
| 范围 | 新增 `goldencode` public model，通过百度、腾讯、阿里、OpenRouter 4 个 GLM-5.2 上游提供 sticky 均衡服务 |
| 非目标 | 不改变现有 7 个 public model 行为；不新增 per-model key entitlement；不向客户端暴露真实上游平台、模型或 key |

## 1. 结论

可以新增 `GoldenCode`，但不能只靠现有 public model registry 的单一
`runtime -> upstreamModel` 配置完成。当前 Gateway 每个 public model 只能映射到一个
runtime；`GoldenCode` 需要新增一层 public model pool 调度。

当前已公开的 7 个模型保持不变：

| Public model id | Display | Runtime | Upstream model |
| --- | --- | --- | --- |
| `max` | Max | `codex` | `gpt-5.5` |
| `specialist` | Specialist | `qianfan` | `glm-5.2` |
| `consultant` | Consultant | `tencent` | `glm-5.2` |
| `expert` | Expert | `openrouter` | `z-ai/glm-5.2` |
| `advisor` | Advisor | `aliyun` | `glm-5.2` |
| `pro` | Pro | `openrouter` | `z-ai/glm-5-turbo` |
| `standard` | Standard | `openrouter` | `deepseek/deepseek-v4-pro` |

`GoldenCode` 上线后会成为第 8 个 public model：

```text
client model: goldencode
display name: GoldenCode
public context: 200k
max output: 128k
reasoning_effort: none / low / medium / high
default reasoning_effort: medium
```

## 2. 产品语义

客户端只看到一个模型：

```text
provider: MedCode
model: GoldenCode
model id: goldencode
```

Gateway 背后从 4 个平台中选择一个实际上游：

| Pool member id | Runtime | Upstream model | 当前对应模型 |
| --- | --- | --- | --- |
| `goldencode-qianfan` | `qianfan` | `glm-5.2` | Specialist |
| `goldencode-tencent` | `tencent` | `glm-5.2` | Consultant |
| `goldencode-aliyun` | `aliyun` | `glm-5.2` | Advisor |
| `goldencode-openrouter` | `openrouter` | `z-ai/glm-5.2` | Expert |

外部 contract：

- `/v1/models` 返回 `goldencode`，不返回 pool member。
- `/v1/chat/completions` 的 `model=goldencode` 可以走任意一个健康 member。
- 响应里的 `model` 仍是客户端请求的 `goldencode`。
- 客户端诊断和 UI 只记录 `goldencode`。
- 内部 `request_events` 记录实际 `upstream_runtime`、`upstream_model` 和
  `upstream_account_id=goldencode-*`，用于运维与横向统计。

## 3. Sticky 均衡策略

### 3.1 Sticky key

推荐优先级：

1. `x-medcode-client-session-id`
2. credential id
3. subject id

原因：

- 用户在同一个客户端会话里连续对话时，尽量固定到同一平台，减少模型风格漂移。
- 客户端未发送 session id 时，旧客户端仍能工作，只是 sticky 粒度退化为 key 或用户。
- 不要求客户端保存或知道真实上游平台。

客户端团队需要确认：OpenAI-compatible 调用是否稳定发送
`x-medcode-client-session-id`。没有这个 header 不影响可用性，但无法保证“同一会话”
严格粘到同一平台。

这条回退链必须属于 GoldenCode pool 自己的 selection 配置，不能复用 Codex
upstream account pool 的 `selection.softAffinity`。Codex upstream pool 的
`credential/subject/none` 是服务端 Codex 登录态选择策略；GoldenCode 的 sticky
粒度是 public model pool 语义，两者不应耦合。

### 3.2 选择算法

第一版默认使用等权 rendezvous hashing，也就是 HRW sticky：

```text
selected = highest_hash(sticky_key, healthy_pool_members)
```

特点：

- 同一 sticky key 在健康成员集合不变时稳定落到同一 member。
- 不需要数据库写入 sticky 映射。
- 多个用户/会话自然分散到 4 个平台。
- 某个平台被摘除或 cooldown 后，只影响原本落到该平台的 sticky key。

如果没有 sticky key，则回退为 least-inflight，避免所有无 header 请求固定到同一个成员。

第一版不暴露 member `weight` 配置。现有 `UpstreamAccountRouter` 的 HRW 选择不使用
`weight`，只有无 sticky key 的 least-inflight 回退会按 `inflight / weight` 评分。
如果未来需要运维通过权重控制 sticky 流量比例，必须显式实现 weighted HRW，并单独加测试；
否则不要在 GoldenCode 配置里放 `weight` 字段，避免形成 dead config。

### 3.3 失败与重试

第一版要复用现有 `/v1/chat/completions` 的泛化 attempt/retry 循环，但不能复用当前
外部 runtime 的运行时状态实现。当前 `openrouter` / `qianfan` / `aliyun` /
`tencent` 单模型路径没有 member 级 inflight、cooldown、outcome 记录，也没有
`beginRetry()`。GoldenCode 必须新增一个 pool member router。

推荐实现方式：

- 复用 `UpstreamAccountRouter` 的构造器和租约能力，或从中抽出泛化的 member router。
- 不复用 `GATEWAY_UPSTREAM_ACCOUNTS_JSON` 的 parser；该 parser 当前只接受
  `openai-codex` provider 和 `codexHome`。GoldenCode member 应由 public model pool
  配置展开成虚拟 runtime inputs。
- 每个 GoldenCode member 用虚拟 `UpstreamAccount` 表达：
  `goldencode-qianfan` / `goldencode-tencent` / `goldencode-aliyun` /
  `goldencode-openrouter`。
- 每个虚拟 account 绑定一个已经构造好的 `OpenAICompatibleProviderAdapter`。
- pool router 负责 HRW、least-inflight、inflight 计数、cooldown、`excludeAccountIds`
  和 `recordOutcome()`。
- 第一版 member 状态可以只保存在进程内；不做 Codex auth 文件检查，不要求写入
  `upstream_accounts` 表。若后续要让 cooldown 跨重启保留，再设计持久化。
- `ChatRuntimeContext.beginRetry()` 由 pool router 提供；这样 streaming 和 non-streaming
  的现有 retry 循环可以继续复用。

目标失败语义：

- 请求开始且还没有向客户端写出响应前，遇到上游限流、超时、服务不可用，可以重试另一个 member。
- 已经开始 streaming 写响应后，不跨平台重试，避免产生混合输出。
- 单次请求最多 2 次 attempt。
- 对 `rate_limited`、`service_unavailable`、`upstream_unavailable`、`upstream_timeout`
  做 member 级 cooldown。
- `invalid_request`、schema validation、用户输入错误不触发换平台重试。

## 4. 配置设计

建议扩展 `MEDCODE_PUBLIC_MODELS_JSON`，新增 pool 型模型：

```json
{
  "goldencode": {
    "displayName": "GoldenCode",
    "runtime": "pool",
    "contextWindow": 200000,
    "maxContextWindow": 200000,
    "upstreamContextWindow": 1048576,
    "maxOutputTokens": 128000,
    "reasoning": { "effort": "medium" },
    "pool": {
      "selection": {
        "strategy": "hrw_sticky",
        "stickyKeyOrder": ["client_session", "credential", "subject"]
      },
      "requireAllMembers": true,
      "members": [
        {
          "id": "goldencode-qianfan",
          "runtime": "qianfan",
          "upstreamModel": "glm-5.2"
        },
        {
          "id": "goldencode-tencent",
          "runtime": "tencent",
          "upstreamModel": "glm-5.2"
        },
        {
          "id": "goldencode-aliyun",
          "runtime": "aliyun",
          "upstreamModel": "glm-5.2"
        },
        {
          "id": "goldencode-openrouter",
          "runtime": "openrouter",
          "upstreamModel": "z-ai/glm-5.2"
        }
      ]
    }
  }
}
```

运维原则：

- API key 值只放在 live env 或安全密钥管理位置，不写入仓库、文档或日志。
- `requireAllMembers=true` 时，缺少任一平台 API key 或 adapter 初始化失败，`goldencode`
  不在 `/v1/models` 暴露，避免名义上 4 平台实际只有 2-3 平台。
- availability 必须逐个检查 pool member adapter 是否构造成功，不能只依赖
  `openRouterAvailable` / `qianfanAvailable` / `aliyunAvailable` / `tencentAvailable`
  这类 runtime 级布尔值。某个 runtime 可能只被 pool 使用，没有独立 public model。
- 某个平台运行时短暂失败时，不下线 `goldencode`，只对 member cooldown 并继续服务。
- 阿里继续使用套餐专属 OpenAI-compatible URL：
  `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。

## 5. 代码改动点

### 5.1 Public model registry

文件：`apps/gateway/src/services/public-model-registry.ts`

改动：

- `ChatRuntimeKind` 增加 `pool`。
- `PublicModelConfig` 增加可选 `pool` 字段。
- 新增 `PublicModelPoolMemberConfig`：

```ts
interface PublicModelPoolMemberConfig {
  id: string;
  runtime: "openrouter" | "qianfan" | "aliyun" | "tencent";
  upstreamModel: string;
  maxConcurrent?: number;
  reasoning?: Record<string, unknown>;
  enabled?: boolean;
}
```

- `parsePublicModelConfig` 对 `runtime="pool"` 解析 `pool.members`。
- `enabled` 默认 `true`，和现有 public model 解析保持一致。
- 第一版不解析 `weight`；如后续实现 weighted HRW，再把 `weight?: number` 加回接口。
- `listAvailable` 对 pool 模型按 `requireAllMembers` 或至少一个 member adapter 可用判断。
- `openAIModelObject` 仍只输出 public model 级 metadata。

### 5.2 Adapter 构造

文件：`apps/gateway/src/index.ts`

当前 adapter 构造只按 `model.runtime === runtime` 创建独立实例。需要把 pool member 也展开为 adapter 实例：

```text
public model goldencode
  member goldencode-qianfan -> Qianfan adapter
  member goldencode-tencent -> Tencent adapter
  member goldencode-aliyun -> Aliyun adapter
  member goldencode-openrouter -> OpenRouter adapter
```

实现方式建议：

- 保留现有 `createOpenRouterAdapters` / `createQianfanAdapters` /
  `createAliyunAdapters` / `createTencentAdapters` 对普通模型的行为。
- 新增 pool member adapter 构造路径，key 使用 member id。
- 每个 member 构造自己的 `OpenAICompatibleProviderAdapter`，固定
  `upstreamModel`、base URL、reasoning parameter style 和 timeout。
- Aliyun/Tencent 继续使用 `reasoning_effort` 字段风格。
- OpenRouter/Qianfan 继续使用 `reasoning` object 风格。
- pool availability 直接来自 member adapter map：
  - `requireAllMembers=true`：所有 enabled member 都必须有 adapter。
  - `requireAllMembers=false`：至少一个 enabled member 有 adapter。
  - 不通过 runtime 级 `openRouterAvailable` / `qianfanAvailable` 等布尔间接判断。

### 5.3 Chat runtime dispatcher

文件：`apps/gateway/src/services/chat-runtime-dispatcher.ts`

新增跨 provider pool 分支，但 selector 本身应由 member router 承担：

- `begin()` 遇到 `model.runtime === "pool"` 时进入 pool runtime。
- pool runtime 持有一个 `UpstreamAccountRouter` 或抽出的泛化 member router 实例。
- router 输入包括 enabled member 的虚拟 `UpstreamAccount`、对应 adapter、
  `maxConcurrent`、cooldown 配置和 sticky key。
- 输出仍是 `ChatRuntimeContext`，确保后续 strict tools、native tools、streaming、
  non-streaming 都复用现有路径。
- `publicModelId` 固定为 `goldencode`。
- `runtime` 写实际 runtime：`qianfan` / `tencent` / `aliyun` / `openrouter`。
- `runtimeInstanceId` 和 `attributionAccount.id` 写 member id，如
  `goldencode-aliyun`。
- `upstreamModel` 写 member upstream model。
- `release()` 释放 member lease，降低 inflight。
- `recordSuccess()` 调用 router `recordOutcome(memberId, "success")`。
- `recordError()` 把 retryable provider error 映射为 `rate_limited` 或 `service_error`，
  并调用 router `recordOutcome()` 进入 cooldown。
- `beginRetry()` 排除已失败 member，选择下一个健康 member。

当前外部 runtime 单模型分支仍可保持 no-op；GoldenCode 不能沿用该 no-op 分支，否则
§3.3 的 cooldown 和 retry 语义不会生效。

### 5.4 Sticky key 注入

文件：`apps/gateway/src/index.ts`

当前 `requestAffinityKey()` 只按 Codex upstream account pool 的
`credential/subject/none` 策略生成 key。GoldenCode pool 不能复用这个策略，
需要自己的链式 sticky key 解析。

GoldenCode pool 需要优先读取：

```text
request.gatewayClientSessionId
```

建议新增：

```ts
function chatRuntimeAffinityKey(request, publicModel) {
  if (publicModel.runtime !== "pool") {
    return requestAffinityKey(request, upstreamRouter.softAffinity);
  }
  const { credential, subject } = getGatewayContext(request);
  return firstNonEmpty([
    request.gatewayClientSessionId ? `client-session:${request.gatewayClientSessionId}` : null,
    credential.id ? `credential:${credential.id}` : null,
    `subject:${subject.id}`
  ]);
}
```

旧客户端没有 session header 时，回退到 credential，再回退到 subject。这个回退链来自
GoldenCode pool 配置，不受 Codex upstream pool `softAffinity` 影响。

### 5.5 Reasoning effort

文件：`apps/gateway/src/index.ts`

`goldencode` 应进入非 Max 模型支持集合：

```text
none / low / medium / high
```

默认值建议为 `medium`。请求级 `reasoning_effort` 覆盖默认值，并由 adapter 转换为对应平台要求的字段：

- OpenRouter/Qianfan：`reasoning: { "effort": "<value>" }`
- Aliyun/Tencent：`reasoning_effort: "<value>"`

不支持值继续返回：

```text
400 invalid_request
```

实现上不要长期依赖 `standardReasoningModelIds` 这种硬编码 id set。第一版可以临时把
`goldencode` 加入 set，但推荐改为 registry 驱动：

- Max/Codex 模型使用 `minimal / low / medium / high / xhigh`。
- 配置了 `reasoning` 或 runtime 为 OpenAI-compatible 的非 Max 模型使用
  `none / low / medium / high`。
- 未来新增 public model 时不需要再改 Gateway 代码常量。

### 5.6 观测、流量与成本统计

不新增数据库字段也能完成第一版，因为现有观测已经有：

```text
public_model_id
upstream_runtime
upstream_model
upstream_account_id
reasoning_effort
upstream_attempts
```

要求：

- `public_model_id=goldencode`
- `upstream_runtime` 为实际选中的 runtime
- `upstream_model` 为实际上游模型
- `upstream_account_id=goldencode-*`
- attempt summary 记录 primary/retry 的实际 member
- 用量看板按 public model 汇总时显示 `goldencode`
- 内部排障视图可以进一步按 `upstream_runtime` 拆分 GoldenCode 流量

#### 5.6.1 流量拆分统计

GoldenCode 必须同时支持两种统计视角：

1. 对外和产品视角：把 `goldencode` 当作一个 public model。
2. 内部运营视角：在 `goldencode` 内继续按 4 个 pool member 拆分。

第一版可直接复用现有 `request_events`、`token_reservations` 和
`report-usage` 聚合能力。每个 GoldenCode 请求必须写入以下组合维度：

| 维度 | 示例 | 用途 |
| --- | --- | --- |
| `public_model_id` | `goldencode` | 对外模型、用户用量、总量趋势 |
| `upstream_account_id` | `goldencode-qianfan` | pool member 级流量、sticky 命中、故障定位 |
| `upstream_runtime` | `qianfan` / `tencent` / `aliyun` / `openrouter` | 平台级流量、错误率、成本分摊 |
| `upstream_model` | `glm-5.2` / `z-ai/glm-5.2` | 实际模型版本统计 |
| `reasoning_effort` | `none` / `low` / `medium` / `high` | 不同 reasoning 档位的速度、质量和成本分析 |

内部 CLI/ops 报表应至少能回答：

- `goldencode` 总请求数、成功率、错误率、限流率。
- 4 个平台各自的请求数、token 数、平均耗时、平均首字节耗时。
- 4 个平台各自的 provider usage 缺失数，避免成本估算被空 usage 污染。
- 每个 `reasoning_effort` 在 4 个平台上的 token 和延迟差异。
- sticky 选择是否均衡：按 `upstream_account_id` 看请求占比，按
  `client_session_id` 抽样确认同一会话是否落到同一 member。

示例查询能力：

```text
report-usage --model goldencode --group-by model
report-usage --model goldencode --runtime qianfan
report-usage --model goldencode --runtime tencent
report-usage --model goldencode --runtime aliyun
report-usage --model goldencode --runtime openrouter
```

Billing `/usage` 默认仍只返回 public model 级用量，不向客户端或付款侧暴露
`upstream_runtime`、`upstream_account_id`、`upstream_model`。这些字段只在内部 CLI、
运营看板和排障视图中使用。

#### 5.6.2 成本拆分统计

当前 Gateway 已记录 token usage，但还没有正式的上游成本账本。GoldenCode 第一版成本能力按两层处理：

1. 成本估算：用于内部运营、平台对比、异常预警。
2. 成本账本：用于严肃财务核算或用户侧结算，第一版不默认启用。

成本估算需要新增配置型价格表，不把价格写死在报表代码中：

```json
{
  "goldencode-qianfan": {
    "currency": "CNY",
    "promptPerMillion": 0,
    "completionPerMillion": 0,
    "reasoningPerMillion": 0,
    "cachedPromptPerMillion": 0
  },
  "goldencode-tencent": {
    "currency": "CNY",
    "promptPerMillion": 0,
    "completionPerMillion": 0,
    "reasoningPerMillion": 0,
    "cachedPromptPerMillion": 0
  },
  "goldencode-aliyun": {
    "currency": "CNY",
    "promptPerMillion": 0,
    "completionPerMillion": 0,
    "reasoningPerMillion": 0,
    "cachedPromptPerMillion": 0
  },
  "goldencode-openrouter": {
    "currency": "USD",
    "promptPerMillion": 0,
    "completionPerMillion": 0,
    "reasoningPerMillion": 0,
    "cachedPromptPerMillion": 0
  }
}
```

上面的 `0` 是占位值；实际价格必须来自对应平台套餐或账单口径，部署配置时填写，不能从代码推断。

估算公式：

```text
estimated_cost =
  prompt_tokens * promptPerMillion / 1_000_000
  + completion_tokens * completionPerMillion / 1_000_000
  + reasoning_tokens * reasoningPerMillion / 1_000_000
  + cached_prompt_tokens * cachedPromptPerMillion / 1_000_000
```

估算报表应支持：

- 按 `public_model_id=goldencode` 汇总总成本。
- 按 `upstream_account_id` / `upstream_runtime` 拆分 4 平台成本。
- 同时展示 tokens、请求数、成功率和 estimated cost，避免只按金额判断平台质量。
- 标记 usage 缺失或软估算行；这类行可以计入流量，但成本需要单独列为
  `cost_estimation_incomplete`。
- 不同币种不要直接相加。第一版可以分币种展示；如需统一币种，必须配置汇率快照。

如果后续要把成本用于财务核算或用户结算，必须新增持久化成本快照，避免价格配置变化后历史成本被重新计算。建议字段：

```text
estimated_cost_minor
cost_currency
pricing_snapshot_json
cost_source
```

这些字段可以落在 `request_events` 或独立 `request_cost_events` 表中。第一版如只做内部估算看板，可以先不加数据库字段，但文档和 UI 必须明确这是 estimated cost，不是结算账单。

## 6. 兼容性要求

必须保持：

- 现有 7 个 public model id 不删除、不改名、不改变默认 upstream。
- `medcode` alias 到 Max 的旧客户端路径继续可用。
- 旧客户端不传 `reasoning_effort` 时行为不变。
- 旧客户端不传 `x-medcode-client-session-id` 时请求仍成功。
- active plan 不因 `goldencode` 增加而出现新的模型级 403。
- `GET /gateway/credentials/current` 不触发模型调用，且继续用于 key 校验。

当前策略仍是：所有 active plan 可以调用当前 Gateway enabled public models。
如果未来需要发行“只能调用 GoldenCode 的 cgu_live key”，那是新的 per-model
entitlement 需求，不属于本方案第一版。

## 7. 测试计划

### 7.1 单元测试

新增或扩展：

- `public-model-registry.test.ts`
  - 能解析 `runtime="pool"`。
  - pool member id 不能重复。
  - member runtime 必须是 OpenAI-compatible runtime。
  - member `enabled` 缺省时默认为 `true`。
  - 第一版不接受或不使用 member `weight`；如保留字段，必须测试它不会被误认为
    sticky 流量权重。
  - `requireAllMembers=true` 时缺少任一 member adapter，`goldencode` 不暴露。
  - 只有 pool member、没有独立 public model 的 runtime 也能正确参与 availability 判断。
  - `openAIModelObject(goldencode)` 只返回 public model metadata。

- `chat-runtime-dispatcher` 覆盖
  - 同一 `x-medcode-client-session-id` 多次选择同一 member。
  - 不同 session id 在 4 个 member 间有分布。
  - 没有 session id 时，按 credential -> subject 链式回退。
  - GoldenCode sticky 不受 Codex upstream pool `softAffinity` 配置影响。
  - member lease 会增加/释放 inflight。
  - retryable error 会记录 member outcome 并进入 cooldown。
  - member cooldown 后，原 sticky key 重新 HRW 到其他健康 member。
  - cooldown 结束后，原 sticky key 可能切回原 member。
  - 失败后 `beginRetry()` 排除失败 member。
  - `ChatRuntimeContext` 写入 public model、runtime、upstream model、member id。

- `index.test.ts`
  - `/v1/models` 在 4 个平台 key 均配置时返回 8 个模型。
  - `model=goldencode` non-stream 成功。
  - `model=goldencode` streaming 成功。
  - strict tools 路径成功。
  - `reasoning_effort=none/low/medium/high` 成功。
  - `reasoning_effort=minimal/xhigh` 返回 `invalid_request`。
  - `goldencode` 默认 reasoning effort 使用 registry 配置值。
  - 没有把 `goldencode` 加入硬编码 set 时，registry 驱动的 reasoning 判断仍能通过。
  - 旧 `model=medcode`、`max`、`specialist`、`expert`、`advisor`、
    `consultant`、`pro`、`standard` 行为不变。

- usage/report 覆盖
  - GoldenCode 请求写入 `public_model_id=goldencode`。
  - 4 个 pool member 分别写入不同 `upstream_account_id` 和 `upstream_runtime`。
  - `report-usage --model goldencode` 能汇总 GoldenCode 总用量。
  - `report-usage --model goldencode --runtime qianfan/tencent/aliyun/openrouter`
    能拆分 4 平台请求和 token。
  - `group-by model` 只暴露 public model 维度，不把 4 个 member 当作 4 个外部模型。
  - 成本估算在价格表存在时按 member 分币种汇总；usage 缺失时标记
    `cost_estimation_incomplete`，不静默产生成本数。

### 7.2 本地验证

```powershell
npm run build
npm test
git diff --check
```

### 7.3 线上 smoke

部署后用临时 key 验证：

1. `GET /gateway/health`
2. `GET /v1/models` 包含 `goldencode`，并保留现有 7 个模型。
3. `model=goldencode`，固定同一个 `x-medcode-client-session-id` 连续请求 3 次，
   检查 `request_events` 落到同一 `goldencode-*` member。
4. 使用 8-16 个不同 session id 发请求，检查 4 个 member 都有流量。
5. `reasoning_effort=none/low/medium/high` 各跑一次。
6. `reasoning_effort=minimal` 验证 400 `invalid_request`。
7. strict tools smoke。
8. streaming smoke。
9. 查询 `events`，确认：
   - `public_model_id=goldencode`
   - `upstream_runtime` 为实际平台
   - `upstream_account_id=goldencode-*`
   - token usage 正常记录
10. 查询 `report-usage`，确认：
   - `--model goldencode` 显示 GoldenCode 总量。
   - `--model goldencode --runtime qianfan/tencent/aliyun/openrouter` 可拆分 4 平台。
   - 内部成本估算报表能按 `goldencode-*` member 展示 tokens、请求数、estimated cost
     和 usage 缺失数。
11. 确认临时 smoke key/user 已撤销，`/tmp` 无残留脚本。

## 8. 部署步骤

1. 本地实现并跑通 build/test。
2. 提交并 push。
3. 在 VM 创建新的 clean release checkout。
4. 更新 live env：
   - 保留现有 7 个模型配置。
   - 增加 `goldencode` pool 配置。
   - 确认百度、腾讯、阿里、OpenRouter API key env 均存在。
   - 不打印、不提交、不在日志中输出 API key 值。
5. VM 执行：

```bash
npm ci
npm run build
npm test
```

6. 备份 live SQLite。
7. 仅 rebuild/recreate Gateway container。
8. 验证容器仍只暴露：

```text
127.0.0.1:18787->8787
```

9. 跑 public OpenAI smoke、strict tools smoke、GoldenCode pool smoke。
10. 检查 active smoke keys 为 0。

## 9. 回滚方案

优先配置回滚：

- 将 `goldencode.enabled=false`，或恢复部署前的
  `MEDCODE_PUBLIC_MODELS_JSON` env 备份。
- recreate Gateway container。
- 现有 7 个模型不受影响。

代码回滚仅在 pool 代码影响现有模型时使用。上线前必须有旧模型 smoke，确保第一回滚路径是隐藏
`goldencode`，不是回滚整个 Gateway。

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 4 个平台同名 GLM-5.2 行为不完全一致 | 同一用户跨会话体验有差异 | 同一 client session sticky；内部按 runtime 观测质量 |
| 客户端未发送 session id | sticky 粒度变粗 | 回退 credential/subject；要求客户端确认 header |
| 某平台短时限流或超时 | GoldenCode 局部失败 | member cooldown；未写响应前重试其他 member |
| member cooldown 触发 HRW 重排 | 同一 client session 可能临时切到其他平台 | 明确接受可用性优先；attempt summary 和 request_events 记录切换；后续可加“cooldown 结束后延迟切回”策略 |
| cooldown 结束后 HRW 切回原 member | 同一会话可能再次换回原平台，产生风格漂移 | 第一版接受；在风险看板监控同一 `client_session_id` 的 member 切换次数 |
| 误以为 `weight` 能控制 sticky 流量 | 运维调整无效，流量分布不符合预期 | 第一版不暴露 `weight`；如要权重，先实现 weighted HRW 并测试 |
| 平台工具调用兼容性差异 | strict tools 成功率不同 | strict tools 与 native tools 分路径 smoke；按 runtime 看错误率 |
| 上下文/输出限制差异 | 长上下文请求表现不同 | public context 统一 200k；保留 length-empty guard |
| 上游身份泄漏 | 用户看到真实平台或模型 | 保持 identity guard；客户端只显示 public model |
| 多进程部署后 in-memory inflight 不共享 | 均衡精度下降 | 当前 live 单容器单进程可接受；多进程前补共享状态 |

## 11. 待确认项

1. `GoldenCode` 默认 reasoning effort 是否采用 `medium`。
2. 客户端是否稳定发送 `x-medcode-client-session-id`。
3. 是否要求第一版 `requireAllMembers=true`，即 4 个平台全部可用才暴露
   `goldencode`。
4. cgu_live key 是否仍沿用“active plan 可用全部 enabled models”的规则。若要
   GoldenCode-only key，需要另开 per-model entitlement 方案。
5. 第一版是否明确采用等权 HRW；如果需要按平台权重分流，需要先实现 weighted HRW。
6. member cooldown 结束后是否允许 sticky key 立即切回原平台；如不允许，需要新增
   “延迟切回”或“会话级临时绑定”策略。
