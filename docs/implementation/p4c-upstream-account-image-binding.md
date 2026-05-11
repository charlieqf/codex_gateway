# P4c 上游账号 OpenAI 生图 Key 绑定设计

| Field | Value |
| --- | --- |
| 状态 | Draft |
| 日期 | 2026-05-11 |
| 范畴 | 把单一 OpenAI 生图 API key 扩展为按上游账号绑定的多 key |
| 关联 | `docs/implementation/p4-upstream-account-pool.md`、`docs/MedCode Gateway 生图能力开发方案.md` |

## 1. 背景

当前生图实现是单 key：

- `apps/gateway/src/image-generation.ts` 中 `OpenAIImageGenerationProvider` 单实例。
- 启动从 `MEDCODE_IMAGE_OPENAI_API_KEY` 读 key，由 `apps/gateway/src/index.ts:2243` `createDefaultImageGenerationProvider` 构造。
- 路由 `POST /v1/images/generations` 用唯一一个 provider 完成所有用户的生图调用。

P4 把 Codex 登录态扩展为 2-3 个上游账号，每个账号是一个独立的 ChatGPT 登录身份（独立邮箱）。现实部署上，每个这样的邮箱都会在 `platform.openai.com` 创建对应的 OpenAI API key 用于生图。同一个网关同一时间应该可以并行使用这些 key 提升生图吞吐和容错。

OpenAI Platform 的 rate limit / 余额是按"持有 key 的实体（邮箱身份在 platform 那边对应的 organization）"算的，同一身份再多建 key 也不增加配额。所以扩容单位天然是"账号"，不是"key 数量"。

**重要事实：绑定是配置层归属，不是运行时耦合**。`platform.openai.com` 上用同一邮箱创建的 API key，运行时只用 `Authorization: Bearer sk-...` 做认证，**和该邮箱在 chatgpt.com 的登录态（`codexHome` / `auth.json`）完全无关**。换句话说：

- `codexHome` 失效（reauth_required）不会让该账号的 `imageApiKey` 失效，反之亦然。
- 把 `imageApiKey` 写在哪个账号下，理论上是运维归属信息（"这个 key 是从这个邮箱建的"），不是运行时依赖。
- 网关并不强制要求 image key 必须由同邮箱创建——这只是部署现实。

这条事实直接合理化了 §7.3 把 codex-side / image-side 的 cooldown、state、inflight 全部独立追踪的设计。

**账号档位可能不同**：当前现实部署是一个 ChatGPT Pro + 一个 ChatGPT Plus。Plus 的 messages 限流比 Pro 紧；Plus 邮箱在 platform 那边的 API tier 也可能更低。这影响两件事：

- Codex 侧两个账号的 `weight` / `maxConcurrent` 实际上不应相同，应该按档位区分。
- Image 侧的限流来自 OpenAI Platform org（与 ChatGPT 档位独立），不一定按 Pro/Plus 等比缩放。

第一版仍然让 codex-side 与 image-side 共享同一对 `weight` / `maxConcurrent` 配置（见 §7.5），如果实际负载证明这不够用，再拆成两套。

本文档编号 `P4c` 是 implementation 文档序号，对应路线图 `Phase 4c`。前置依赖：P4 上游 Codex 账号池已合入。

## 2. 目标

1. 上游账号配置新增 `imageApiKeyEnv?: string`，指向 `process.env` 里的 OpenAI API key 变量名。该字段是配置层归属信息，运行时不依赖该账号的 `codexHome`。
2. Gateway 启动时为每个有 `imageApiKeyEnv` 的账号创建一个独立的 `OpenAIImageGenerationProvider` 实例。
3. `POST /v1/images/generations` 通过 P4 `UpstreamAccountRouter` 的新方法 `selectForImage` 选一个 image-capable 账号。
4. 同一账号的 Codex 调用与生图调用拥有**独立**的 cooldown、state 与 inflight 计数。一侧不可用不影响另一侧。
5. `request_events.upstream_account_id` 同样记录生图请求实际落到的账号。
6. 默认保持现有单 key 配置兼容：未启用账号池或所有账号都未声明 `imageApiKeyEnv` 时，继续走 `MEDCODE_IMAGE_OPENAI_API_KEY`。

## 3. 非目标

- 不支持单个上游账号挂多个 image key。同一邮箱 / 同一 Platform 身份建多 key 不能扩容，不在数据模型里开口子。
- 不实现生图请求的 sticky。生图天然 stateless，每个请求独立选路。
- 不引入 image key 的轮换 CLI / 热替换。第一版通过修改 env 重启完成。
- 不把真实 API key 写入 JSON、DB、日志或 CLI 输出。
- 不新增生图专属用量记账表；继续走现有 `request_events` 摘要。
- 不修改 `POST /v1/images/generations` 的公开请求/响应合同。
- 不实现跨进程共享 image cooldown / inflight 状态。

## 4. 当前实现基础

可复用：

- `OpenAIImageGenerationProvider` 已支持构造时传入 `apiKey` / `baseUrl` / `timeoutMs`。
- 错误归一化已覆盖 429 → `rate_limited`、5xx → `upstream_unavailable`、超时 → `upstream_timeout`、400 安全策略 → `content_policy_violation`、400 其他 → `invalid_request`、401/403 → 503/upstream_unavailable。
- P4c 需要在对客户端归一化之前保留内部 `ImageProviderOutcome`，至少包含归一化错误码与 upstream HTTP status。尤其是 401/403 不能只折叠成 `upstream_unavailable`，否则 router 无法把该账号 image-side 标记为 `key_invalid`。
- `POST /v1/images/generations` 路由（`apps/gateway/src/index.ts:880`）已经做 plan entitlement 校验和 `resolveImageUpstreamModel`。
- `request_events.upstream_account_id` 已存在。

缺口：

- 单一 provider 实例，单一 key。
- Router 只在 P4 设计里覆盖 Codex 调用，没有 image-side 选路。
- 没有 image-side cooldown / inflight 概念。
- 没有"该账号 image key 是否健康"的检查点。

## 5. 配置设计

### 5.1 兼容路径

完全不引入新字段时行为不变：

- 未设 `GATEWAY_UPSTREAM_ACCOUNTS_JSON`：单账号 fallback（P4 §5.1）+ 单 image key（`MEDCODE_IMAGE_OPENAI_API_KEY`）。
- 已启用账号池但**所有账号**都没有 `imageApiKeyEnv`：image 路由继续使用 `MEDCODE_IMAGE_OPENAI_API_KEY` 单 provider。

进入账号池 image binding 模式的条件：账号池中**至少一个**账号声明了 `imageApiKeyEnv`。其中至少一个对应 env 非空时，存在可用的 image-capable 账号并走 router；如果所有已声明的 env 都缺失或为空，则视为 image binding 已配置但当前不可用，返回 `upstream_unavailable`，**不**静默回退到顶层 `MEDCODE_IMAGE_OPENAI_API_KEY`。这样可以避免部署侧误配多 key 时悄悄使用旧单 key。

混合模式：账号 A 有 `imageApiKeyEnv` 且 env 非空、账号 B 没有 → B 在 image 路径不可选；Codex 路径不受影响。

### 5.2 账号池扩展字段

P4 §5.2 JSON schema 的 `accounts[]` 条目增加字段；文件仍保持 P4 定义的顶层对象形态：

```json
{
  "accounts": [
    {
      "id": "account-a",
      "label": "ChatGPT Pro (email A)",
      "provider": "openai-codex",
      "codexHome": "/var/lib/codex-gateway/codex-home-a",
      "imageApiKeyEnv": "MEDCODE_IMAGE_OPENAI_API_KEY_A",
      "imageBaseUrlEnv": "MEDCODE_IMAGE_OPENAI_BASE_URL_A",
      "imageTimeoutMs": 180000,
      "enabled": true,
      "initialState": "active",
      "weight": 2,
      "maxConcurrent": 1
    },
    {
      "id": "account-b",
      "label": "ChatGPT Plus (email B)",
      "provider": "openai-codex",
      "codexHome": "/var/lib/codex-gateway/codex-home-b",
      "imageApiKeyEnv": "MEDCODE_IMAGE_OPENAI_API_KEY_B",
      "enabled": true,
      "initialState": "active",
      "weight": 1,
      "maxConcurrent": 1
    }
  ],
  "selection": {
    "strategy": "least_inflight",
    "softAffinity": "credential"
  },
  "cooldown": {
    "rateLimitSeconds": 120,
    "reauthSeconds": 900,
    "serviceErrorSeconds": 30
  }
}
```

`account-a` 是 Pro，`account-b` 是 Plus。两者 ChatGPT messages 限流不同，所以 codex-side `weight` 拉开差距（Pro=2, Plus=1）让 HRW soft affinity 更倾向 Pro 接 Codex 请求。同一 `weight` / `maxConcurrent` 字段也同时作用于 image-side，第一版接受这种"共享配置"妥协（见 §7.5）。

规则:

- `imageApiKeyEnv` 是 env 变量**名**，不是 key 真值。Parser 必须拒绝任何长度 > 64 或以 `sk-` 开头的字面值，避免误把 key 真值写进 JSON。
- 启动时若 `imageApiKeyEnv` 在 `process.env` 中不存在或为空字符串，该账号 image-side 进入 runtime `missing`，从 image 候选集排除；Codex-side 不受影响（因为运行时独立，见 §1）。
- `imageApiKeyEnv` 字段表达的是"这个 key 在运维上归属于这个上游账号"，不强制 key 必须由该账号同邮箱创建。网关也不验证两者邮箱一致性。
- `imageBaseUrlEnv` 可选，未设回落 `MEDCODE_IMAGE_OPENAI_BASE_URL` 再回落默认 `https://api.openai.com`。
- `imageTimeoutMs` 可选，未设回落 `MEDCODE_IMAGE_TIMEOUT_MS` 再回落默认 `180000`。
- `weight` / `maxConcurrent` 复用 P4 设计且在第一版中**同时**作用于 codex-side 与 image-side 选路。这只是 PR 范围控制的妥协（见 §7.5）。

### 5.3 Secret 管理

- env 真值由部署侧工具注入（`scripts/inject-image-openai-key.ps1` 可扩展为 inject 多个变量）。
- API key 实体永远不进 JSON、DB、`/gateway/status`、admin CLI 输出、错误响应 body。
- DB `upstream_accounts.image_api_key_env` 只存 env 变量**名**（非 secret）。
- 启动日志可以打印 "image key configured for account=account-a via MEDCODE_IMAGE_OPENAI_API_KEY_A"，但**不得**打印 key 值或值的前缀。

## 6. 数据模型变化

`upstream_accounts` 增加一列：

```sql
ALTER TABLE upstream_accounts ADD COLUMN image_api_key_env TEXT;
```

- 仅记录 env 变量名，便于审计哪个账号应当持有 image key。
- 该列是配置元数据，不是运行时状态。P4c bootstrap upsert 应在每次启动时把它更新为当前 config 的 `imageApiKeyEnv`，未配置时写 `NULL`，这样移除字段回滚后 DB 不会保留过期归属。
- 不引入 `image_state` / `image_cooldown_until` 等运行时列；image-side 健康沿用 P4 设计在内存中追踪，第一版不持久化。
- `request_events.upstream_account_id` 已支持记录生图请求归属，无需 schema 变更。

P4 §5.2 中提到的账号 runtime state 原则在 P4c 中仅作用于账号本身的 `state`，以及未来如果实现持久化时的 `last_used_at / cooldown_until`。image-side 状态在第一版只在内存。

## 7. Router 行为

### 7.1 接口扩展

P4 `UpstreamAccountRouter` 增加：

```ts
interface UpstreamAccountRouter {
  // P4 已有
  selectForNewSession(...): ...;
  selectForStateless(...): ...;
  resolveForExistingSession(...): ...;

  // P4c 新增
  selectForImage(input: { affinityKey?: string }): UpstreamAccountRuntime | GatewayError;
  recordImageOutcome(accountId: string, outcome: ImageProviderOutcome): void;
}
```

`ImageProviderOutcome` 是内部结果，不等同于对外 `GatewayError`。它必须能区分 401/403、429、5xx/network、timeout、content policy 400、其它 invalid_request，客户端响应仍走现有公开错误合同。

Codex-side 方法与 image-side 方法共享 P4 §8 selection core（HRW + least_inflight），只是过滤维度不同。

### 7.2 Image 候选过滤

`selectForImage` 按顺序过滤候选账号：

1. config `enabled !== false`
2. DB/runtime `state === "active"`（账号整体未被运维 disable）
3. `imageApiKeyEnv` 在 config 中已声明且对应 env 在启动时已成功读取到非空字符串
4. image-side runtime state ∈ `{ active }`（不含 `key_invalid` / `unhealthy`）
5. image-side `cooldownUntil` ≤ now
6. image-side `inflight < maxConcurrent`

通过过滤后用 §8 selection core 选一个。

如全部账号被过滤掉：
- 如果 dominant reason 是 cooldown / inflight cap → `rate_limited`。
- 如果 dominant reason 是 `key_invalid` / 无 image key → `upstream_unavailable`。

### 7.3 Inflight / Cooldown 分离

`UpstreamAccountRuntime` 内部状态：

```ts
interface UpstreamAccountRuntime {
  account: UpstreamAccount;
  codexProvider: ProviderAdapter;
  imageProvider: OpenAIImageGenerationProvider | null;

  codex: {
    inflight: number;
    cooldownUntil: Date | null;
    state: "active" | "reauth_required" | "unhealthy";
  };
  image: {
    inflight: number;
    cooldownUntil: Date | null;
    state: "active" | "key_invalid" | "unhealthy" | "missing";
  };
}
```

- `maxConcurrent=1` 意味着 Codex 侧最多 1 inflight **且** image 侧最多 1 inflight。即同一账号可同时跑 1 个 Codex 请求 + 1 个生图请求。两条路径互不阻塞。
- 这个选择基于 OpenAI Platform 与 ChatGPT 订阅在限流上独立的事实：image 429 是 Platform RPM/TPM 限制（per-org），Codex 限流是 ChatGPT 订阅 messages 上限（per-account, 还分 Pro / Plus 档位）。同账号同时打两条路径不会互相吃配额。
- 同样地，codex-side `state=reauth_required` 不会让 image-side 不可用；image-side `state=key_invalid` 不会让 Codex 不可用。

### 7.4 单 key 兼容路径下的 Router 行为

当所有账号都没有 `imageApiKeyEnv` 但仍处于 P4 账号池模式时，`selectForImage` 直接返回 `upstream_unavailable`（"`POST /v1/images/generations` not configured for account pool"），由 image 路由侧 fallback 到 P4c §9.2 单 key path。

如果至少一个账号声明了 `imageApiKeyEnv` 但所有对应 env 缺失或为空，`selectForImage` 仍返回 `upstream_unavailable`，且 route 不 fallback 到单 key path（与 §5.1 一致）。

简化实现：image 路由先看是否已配置账号池 image binding 字段。已配置则走 router 或返回账号池 image 不可用；未配置才走单 key 兼容路径。Router 不感知单 key fallback。

### 7.5 Codex 与 Image 共享 weight / maxConcurrent 的局限

第一版让 codex-side 与 image-side 共享同一对 `weight` / `maxConcurrent`。这是 PR 范围控制的妥协，**不**是设计上的最终答案。

潜在不精确：

- 现实部署 account-a 是 ChatGPT Pro、account-b 是 ChatGPT Plus，Codex-side `weight=2:1` 是合理的（Pro 限流松）。但 image-side 的限流来自 OpenAI Platform org，不一定按 Pro/Plus 同比例缩放——`weight=2:1` 应用到 image 选路可能并不最优。
- `maxConcurrent` 同理：Codex 侧 = 1 是 ChatGPT 防触发限流的经验值；image 侧 OpenAI API tier 1 通常支持 5 RPM 起，理论可以更高。

第一版接受这种共享配置的代价。如果观察到 image-side 负载分布明显失衡，作为 follow-up 把 `weight` / `maxConcurrent` 拆成 `codex.weight` / `image.weight` 等独立字段。`§17` 把这条列为开放问题。

## 8. 错误处理与 Cooldown 映射

| Upstream outcome | Image cooldown | Image state | Client outcome | 备注 |
| --- | --- | --- | --- | --- |
| success | clear transient | active | normal | 也更新 `lastUsedAt` |
| 429 `rate_limited` | `rateLimitSeconds` | active | `rate_limited` | retry-after 走现有逻辑 |
| 5xx / network | `serviceErrorSeconds` | active | `upstream_unavailable` |  |
| 408 / abort timeout | `serviceErrorSeconds` | active | `upstream_timeout` |  |
| 401 / 403 | `reauthSeconds`（长） | `key_invalid` | `upstream_unavailable` | 不外泄 401/403 状态码 |
| 400 内容审核 | **不冷却** | active | `content_policy_violation` | 用户输入问题，不影响 key 健康 |
| 400 invalid_request | **不冷却** | active | `invalid_request` |  |

两条 "**不冷却**" 是这一节的核心：把用户输入引起的错误和 key/服务侧错误隔开，避免 prompt-spam 把某个账号打成 cooldown。

`key_invalid` 是进程内终止状态：cooldown 用于抑制重复尝试和日志/告警节流，cooldown 过期不会自动把账号恢复成 `active`。修复 key env 后通过重启 Gateway 重新构造 provider 并清空 image-side runtime state。

对 `key_invalid` 同时写入 `reauthSeconds` cooldown 是为了给日志节流 / 告警去重保留一个时间窗口；候选过滤层只看 `state=key_invalid` 就排除账号，不依赖 `cooldownUntil`。

`recordImageOutcome` 实现这张表。Codex 调用的 cooldown 走 P4 表，不互通。

## 9. 路由 Wiring

### 9.1 多 key 模式

`POST /v1/images/generations`（`apps/gateway/src/index.ts:880`）改造：

1. 现有 `parseImageGenerationRequest` + `entitlementAccessForSubject` + `resolveImageUpstreamModel` 检查不变。
2. 选路：`const selected = router.selectForImage({ affinityKey: credential.id });`
3. 失败：返回相应错误。
4. `selected.image.inflight++`，记录 `request.gatewayContext.upstreamAccount = selected.account`。
5. 调 `selected.imageProvider.generate({ request, upstreamModel, signal })`。
6. `finally` 中 `selected.image.inflight--` 并 `router.recordImageOutcome(selected.account.id, outcome)`。
7. observation 写 `request_events.upstream_account_id = selected.account.id`。

### 9.2 单 key 兼容路径

路由层判断：

```ts
if (accountPoolImageBindingDeclared) {
  // §9.1；如果 image-capable account count 为 0，返回 upstream_unavailable
} else if (imageGenerationProvider) {
  // 现有单 key 路径，行为不变
} else {
  // 返回 "Image generation service is not configured."
}
```

多 key 路径把实际选中的账号写到 `request_events.upstream_account_id`。单 key 兼容路径只有在未启用账号池、走 P4 单账号 fallback 时才写那一行默认 `upstream_accounts.id`；如果账号池已启用但没有任何账号声明 `imageApiKeyEnv`，legacy `MEDCODE_IMAGE_OPENAI_API_KEY` 不归属于某个具体账号，`request_events.upstream_account_id` 应保持 `null`。需要按账号聚合 image 用量时，部署侧应给对应账号显式配置 `imageApiKeyEnv`。

## 10. Retry / Failover

P4 §7.4 / §7.5 的 "客户端可见业务输出边界之前可 retry" 原则同样适用，但生图是非流式单次响应，边界即"是否已开始写 HTTP response body"。

规则：

- 选中账号首次 provider 调用在 `parseOpenAIImageResult` 之前返回 `rate_limited` / `upstream_unavailable` / `upstream_timeout` / `key_invalid`：可切到下一个 image-capable 账号 retry。
- 这里的 `key_invalid` 来自内部 `ImageProviderOutcome` 对 401/403 的识别；客户端仍只看到归一化后的 `upstream_unavailable`。
- `content_policy_violation` / `invalid_request`：**不切账号**。用户输入问题，立即返回。
- 一旦开始写 response body：不切账号，按当前 attempt 返回。
- 第一版 retry 上限 1（即至多两个账号尝试）。
- `image.inflight` 在每次 attempt 各自 increment / decrement。
- 每次 attempt 都必须设置当前 `request.gatewayContext.upstreamAccount`。`request_events.upstream_account_id` 记录最终产生响应的账号；如果所有 attempt 都失败，则记录最后一个被选中并返回给客户端的失败账号。所有 attempt 的账号和错误码只进结构化日志，不进 `request_events` 摘要。

## 11. 观察与报告

- `request_events.upstream_account_id` 继续承担请求级账号归属。
- admin CLI `events` / `report-usage` 自动按账号聚合，无需新命令。
- 不引入 image 专属表。
- attempt-level 信息（首选账号 / retry 账号 / 各自错误码）按 §10 retry 规则通过结构化日志写出，`request_id` 关联。第一版不入 DB。

## 12. Admin And Operations

### 12.1 配置示例

```env
MEDCODE_IMAGE_GENERATION_ENABLED=1
MEDCODE_IMAGE_OPENAI_API_KEY_A=sk-...
MEDCODE_IMAGE_OPENAI_API_KEY_B=sk-...
GATEWAY_UPSTREAM_ACCOUNTS_JSON=/var/lib/codex-gateway/upstream-accounts.json
```

JSON 见 §5.2。

### 12.2 Key 轮换

1. 在 `platform.openai.com` 创建新 key `sk-NEW`（用对应邮箱登录方便归属，但不强制——见 §1）。
2. 更新部署 env: `MEDCODE_IMAGE_OPENAI_API_KEY_A=sk-NEW`。
3. 重启 Gateway。第一版不支持 hot reload。
4. 在 `platform.openai.com` revoke 旧 key。

### 12.3 Key 失效响应

- 大量 401/403 → 账号 image-side 进入 `key_invalid`，cooldown reauthSeconds。
- 运维 alert 通过日志关键字（如 `image_key_invalid account_id=...`）触发。
- 修复 env 后重启重置 cooldown / state。

### 12.4 Disable Image On Single Account

只想暂时停用一个账号的 image 能力（保留 Codex）：

- 把对应 env unset 或置空。
- 重启。image 路径自动排除该账号；Codex 路径不受影响。

不引入 config 层 `imageDisabled: true`，保持单一开关来源（env 缺失 = image 不可用）。

## 13. Public API Compatibility

- `POST /v1/images/generations` 请求 / 响应形态不变。
- 错误码集合不变。
- 不暴露 `imageApiKeyEnv` / `upstream_account.id`。
- `GET /gateway/status` 在 P4c 第一版**不**新增 image-side 健康字段；运维健康查 admin 通道或日志。

## 14. Implementation Plan

依赖：P4（上游 Codex 账号池）已合入。

### PR 1: Schema + Config

- DB migration 加 `upstream_accounts.image_api_key_env`。
- Bootstrap upsert 更新 `image_api_key_env` 为当前 config 的 env 变量名或 `NULL`，但继续保留 P4 对 `state` 的不覆盖规则。
- 实现方式二选一：改造 `upsertUpstreamAccount` SQL，让 `ON CONFLICT DO UPDATE` 也覆盖 `image_api_key_env`，且保留 `state` / `last_used_at` / `cooldown_until` 不被覆盖；或者新增 `setUpstreamAccountImageBinding(id, envName | null)`，bootstrap 时单独调用。
- P4 config parser 扩展接受 `imageApiKeyEnv` / `imageBaseUrlEnv` / `imageTimeoutMs`。
- Parser 拒绝可能是 key 真值的 `imageApiKeyEnv`（长度或前缀判定）。
- 启动时按 §5.1 规则决定单 key / 多 key / 混合 / 全部不可用四种状态。
- 启动日志只记账号 id + env 变量名。
- 单元测试。

### PR 2: Router + Provider 池

- `UpstreamAccountRouter.selectForImage` + `recordImageOutcome`。
- `UpstreamAccountRuntime.image` 状态机。
- 启动时为每个有 image key 的账号构造一个 `OpenAIImageGenerationProvider`。
- 错误 outcome → cooldown 映射表（§8）。
- 单元测试覆盖每一行映射 + `content_policy_violation` 不冷却。

### PR 3: 路由接入

- `POST /v1/images/generations` 切换到 router。
- 单 key 兼容路径分支。
- observation 写正确账号 id。
- Gateway 测试：分布、cooldown 排除、key 失效、内容审核不冷却、单 key fallback。

### PR 4: Retry + Smoke

- 首字节前 retry 一次另一个 image-capable 账号。
- 不在 content / invalid_request 错误上 retry。
- Operations runbook 更新（轮换、disable image-only）。
- VM smoke：两 key 都产生过请求；其中一个 env 置空后流量集中到另一个。

## 15. Test Plan

Unit tests:

- `imageApiKeyEnv` 缺失或 env 为空字符串时账号 image-side `state=missing`，不可被 `selectForImage` 选中。
- Config parser 拒绝 `imageApiKeyEnv` 看起来像 key 真值（如以 `sk-` 开头）。
- 所有账号都未声明 `imageApiKeyEnv` 时进入单 key 兼容路径（router 不参与）。
- 至少一个账号声明 `imageApiKeyEnv` 且至少一个 env 非空时进入账号池 image binding 路径。
- 至少一个账号声明 `imageApiKeyEnv` 但所有对应 env 都缺失或为空时，不回退单 key，返回 `upstream_unavailable`。
- HRW soft affinity 在 image 候选集变化时只导致有限 credential 漂移。
- `key_invalid` 排除该账号，cooldown 过期后仍不可选，修复 env 并重启后才恢复。
- 429 触发短 cooldown；5xx 触发短 cooldown；超时触发短 cooldown。
- 401/403 触发长 cooldown 且 `state=key_invalid`。
- `content_policy_violation` 与 `invalid_request` 不触发 cooldown。
- Image cooldown 与 Codex cooldown 互不影响：同一账号 image 处于 cooldown 时 Codex 仍可被 `selectForCodex` 选中。
- `maxConcurrent=1` 下同账号可同时存在 1 Codex inflight + 1 image inflight。

Gateway tests:

- `POST /v1/images/generations` 选中账号写入 `request_events.upstream_account_id`。
- 不同 credential 的连续请求落到不同账号（HRW 验证）。
- 选中账号首次失败可切另一个；写 body 后不切。
- `content_policy_violation` 不触发 retry。
- 单 key 兼容路径不调用 router，行为不变。
- image-only 失败不影响该账号 Codex 路径选路。

Smoke tests:

- 两 env 都注入。生成 ≥ 4 次图像，`events` 表 `account-a` / `account-b` 都出现。
- 把 `MEDCODE_IMAGE_OPENAI_API_KEY_A` 置空字符串重启。所有图像请求落到 `account-b`，`events` 表只出现一个 account id。同时验证 Codex 路径仍然两个账号都可选（account-a 的 codex-side 不受 image env 缺失影响）。
- 还原 env 重启，分布恢复。
- 关闭 `MEDCODE_IMAGE_GENERATION_ENABLED`，验证生图路由返回 `upstream_unavailable` 且 Codex 路径不受影响。

## 16. Rollout Plan

1. P4 合入并稳定运行至少一个 trial day。
2. 在 `platform.openai.com` 用邮箱 A、B 各创建一个 key（复用已存在的也行）。
3. 部署 env `MEDCODE_IMAGE_OPENAI_API_KEY_A` / `_B` 注入。
4. 更新 `upstream-accounts.json` 给两个账号都加 `imageApiKeyEnv`。
5. 重启 Gateway。启动日志确认 image-capable account count ≥ 1。
6. 临时 API key smoke：触发 ≥ 4 次生图，`events` 表两个 account_id 都出现。
7. 24h 监控：429 / 401 频率、平均时延、retry 次数。

Rollback:

- 移除全部账号的 `imageApiKeyEnv` 字段 → 回退单 key 兼容路径；账号池仍启用时，legacy image 请求的 `request_events.upstream_account_id` 可为 `null`。
- 或临时 unset 新加的 `MEDCODE_IMAGE_OPENAI_API_KEY_B` 让 `account-b` image-side 进入 `missing`；流量自然回退到 `account-a`。

## 17. Open Questions

- 第一版要不要在某个内部 admin 通道（CLI 或受保护 HTTP）暴露每账号 image-side 健康？
- Key 连续失效（如 1 小时内多次 401/403）是否触发 webhook / 告警通道？
- 单 key 兼容路径在所有账号都设 `imageApiKeyEnv` 之后是否可以彻底废弃 `MEDCODE_IMAGE_OPENAI_API_KEY` 顶层 env？建议保留一个版本周期再淘汰。
- HRW affinity key 默认用 `credential.id` 还是 `subject.id`？（同 P4 §16，需要一起决定）
- 何时把 `weight` / `maxConcurrent` 拆成 codex-side / image-side 独立配置？需要先观察 Pro/Plus 混合部署的实际 image 限流分布再定。
- 现实上 image API key 与 codex 账号并非必须同邮箱创建。配置层是否需要允许"独立 image key 列表"作为额外字段（不和某个 codex 账号绑定）？第一版不支持，但值得留意未来需求。
