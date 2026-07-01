# MedCode 多档模型路由接入方案

状态：修订稿
日期：2026-06-26
主责仓库：`codex-gateway`
相关仓库：`medevidence-app`

## 背景

当前 Desktop 基于 OpenCode 的 provider / model 抽象接入 MedCode。客户端调用的是 Gateway 的 OpenAI-compatible 入口：

```text
Desktop / OpenCode
  -> provider: medcode
  -> baseURL: https://gw.instmarket.com.au/v1
  -> model: medcode
  -> Codex Gateway
  -> upstream Codex SDK / gpt-5.5
```

用户只配置统一的 MedCode / MedEvidence key。Desktop 不接触 OpenAI、Codex、OpenRouter、DeepSeek、Z.AI 的真实 key，也不暴露真实上游模型。

本方案目标是在不改变这一产品心智的前提下，把 MedCode 扩展为四档 public model：

| 用户可见档位 | OpenCode provider/model | Gateway public model id | 第一版上游 |
| --- | --- | --- | --- |
| Max | `medcode/medcode` | `medcode` | 当前 Codex 路径，`gpt-5.5` |
| Expert | `medcode/expert` | `expert` | OpenRouter `z-ai/glm-5.2`，`reasoning.effort=high` |
| Pro | `medcode/pro` | `pro` | OpenRouter `z-ai/glm-5-turbo` |
| Standard | `medcode/standard` | `standard` | OpenRouter `deepseek/deepseek-v4-pro` |

`medcode` 继续作为现有默认 model id，兼容历史配置、测试和会话。

## Backward Compatibility 硬门槛

Gateway 侧改造必须对已安装客户端 backward-compatible。Gateway 先上线、客户端尚未升级或用户长期不升级时，现有调用路径必须照常工作：

```text
POST /v1/chat/completions
model: medcode
Authorization: Bearer <existing MedCode / MedEvidence key>
```

兼容性要求：

- `medcode` public model id 不改名、不删除、不改变默认语义，仍映射到现有 Codex / `gpt-5.5` 路径。
- Max 保持现有 400k public context 和 128k output，不把接入 Expert / Pro / Standard 变成 Max 降级。
- Gateway 默认配置只启用 `medcode`；OpenRouter key 缺失、OpenRouter adapter 未启用或 Expert / Pro / Standard disabled 时，Gateway 仍能启动并服务 `medcode`。
- 所有已发放且仍有效的 MedCode key 都自动具备当前 Gateway 已启用的四档模型（第一版为 `medcode` / `expert` / `pro` / `standard`）；本版不存在 per-model key entitlement。
- request event / token budget / entitlement migration 必须是 additive；旧数据可读，旧 admin/report 命令不因新 nullable 字段失败。
- `/v1/models` 至少继续返回 `medcode` 及现有 limit metadata。新增 `expert` / `pro` / `standard` 只在 Gateway registry enabled 后出现。
- 上线门槛必须包含旧客户端 smoke：旧配置、旧 key、`model=medcode`、普通聊天、streaming、strict tools、request event/token usage 记录全部通过。

如果以上任一项不能保证，本次 Gateway 改造不得发布到公共入口。

## Owner 边界

Gateway 团队 owns 模型路由和数据面：

- 哪些 public model 暴露给客户端。
- Max / Expert / Pro / Standard 分别映射到哪个上游 runtime 和模型。
- OpenRouter key、Z.AI/DeepSeek 官方 key、OpenAI/Codex 凭证如何管理。
- 鉴权、套餐权限、限流、token/cost 记录、失败降级、日志脱敏。
- `/v1/models` 和 `/v1/chat/completions` 的兼容行为。
- 多区域 Gateway、区域 endpoint 选择和后续数据汇总。

`medevidence-app` / OpenCode fork owns 用户体验：

- MedCode provider 下显示哪些 public model。
- 默认选择 Max 还是其他档位。
- model label、说明、是否允许切换。
- 与本地 provider auth / MedCode key 状态 UI 的集成。

明确不做：

- Desktop 不直接接 OpenRouter。
- Desktop 不保存 OpenRouter、DeepSeek、Z.AI 官方 key。
- Desktop 不根据真实上游模型名做业务判断。
- 同一个 MedCode provider 不拆成“部分请求走 Gateway、部分请求直连第三方”。

原因是直连第三方会绕过 Gateway 的安全、计费、审计、限流和脱敏边界，也会让排查路径分裂。

## 外部可用性快照

2026-06-26 通过 `GET https://openrouter.ai/api/v1/models` 验证，OpenRouter 当前提供：

| OpenRouter model id | context | top provider max completion | pricing prompt | pricing completion | 备注 |
| --- | ---: | ---: | ---: | ---: | --- |
| `z-ai/glm-5.2` | 1,048,576 | 32,768 | `$0.95 / 1M tokens` | `$3.00 / 1M tokens` | `text->text`，支持 `tools`、`tool_choice`、`structured_outputs`、`reasoning` |
| `deepseek/deepseek-v4-pro` | 1,048,576 | 384,000 | `$0.435 / 1M tokens` | `$0.87 / 1M tokens` | `text->text`，支持 1M 上下文 |

OpenRouter 使用 OpenAI-compatible endpoint：

```text
POST https://openrouter.ai/api/v1/chat/completions
Authorization: Bearer <OPENROUTER_API_KEY>
```

OpenRouter attribution headers 可选：

```text
HTTP-Referer: <site-url>
X-OpenRouter-Title: <app-title>
```

价格、context、top provider max completion、支持参数和可用性属于实时外部状态。上线前、故障排查和供应商切换前，都必须重新查询 OpenRouter Models API。

## Gateway 设计

### Public Model Registry

当前 Gateway 只接受一个 public model id：

```env
MEDCODE_PUBLIC_MODEL_ID=medcode
```

新增 public model registry。为了生产运维和回滚稳定，建议支持文件路径优先：

```env
MEDCODE_PUBLIC_MODELS_JSON_FILE=/var/lib/codex-gateway/public-models.json
```

同时支持单行 JSON env 作为开发和临时灰度入口：

```env
MEDCODE_PUBLIC_MODELS_JSON={"medcode":{"displayName":"Max","runtime":"codex","upstreamModel":"gpt-5.5"}}
```

缺省时保持当前行为：

```env
MEDCODE_PUBLIC_MODEL_ID=medcode
MEDCODE_UPSTREAM_MODEL=gpt-5.5
```

建议 registry shape：

```json
{
  "medcode": {
    "displayName": "Max",
    "runtime": "codex",
    "upstreamModel": "gpt-5.5",
    "contextWindow": 400000,
    "upstreamContextWindow": 400000,
    "maxOutputTokens": 128000,
    "enabled": true
  },
  "expert": {
    "displayName": "Expert",
    "runtime": "openrouter",
    "upstreamModel": "z-ai/glm-5.2",
    "contextWindow": 200000,
    "upstreamContextWindow": 1048576,
    "reasoning": { "effort": "high" },
    "enabled": false
  },
  "pro": {
    "displayName": "Pro",
    "runtime": "openrouter",
    "upstreamModel": "z-ai/glm-5-turbo",
    "contextWindow": 200000,
    "upstreamContextWindow": 1048576,
    "reasoning": { "effort": "none" },
    "enabled": false
  },
  "standard": {
    "displayName": "Standard",
    "runtime": "openrouter",
    "upstreamModel": "deepseek/deepseek-v4-pro",
    "contextWindow": 200000,
    "upstreamContextWindow": 1048576,
    "reasoning": { "effort": "none" },
    "enabled": false
  }
}
```

`contextWindow` 是 Gateway 对外返回、Desktop 应遵循、Gateway token budget 应执行的 public/enforced context window。`upstreamContextWindow` 只是 Gateway 内部记录的上游物理能力，不进入 Desktop 配置，也不应驱动 Desktop compaction。两者差异是有意的：Max 保持现有 400k public context，避免把接入 Pro / Standard 变成 Max 的降级迁移；Pro / Standard 第一版按 200k 控制上下文。OpenRouter 1M 能力只作为后续放量依据。等 Gateway token budget、费用上限、延迟和稳定性验证后，再考虑提高 Pro / Standard 的 public/enforced context window。

`maxOutputTokens` 是 Gateway 暴露给客户端的 public output 预算信号，不是 OpenRouter 上游单次 completion 能力保证。第一版默认策略是：Max 保持 128k；Pro / Standard 不设置额外 32k 低上限，缺省继承 Max 的 128k output 信号，并且不超过自身 `contextWindow`。这样避免 Pro / Standard 在 public metadata 上倒挂超过 Max，也避免 `output=contextWindow` 让客户端预留输出空间时没有输入预算。OpenRouter 当前真实 top provider max completion 仍需在上线前重新查询；若未来要按真实上游 completion limit 精确声明，需要单独产品确认，因为这会让 Pro 重新显示 32,768。

当前生产默认 `MEDCODE_PUBLIC_MODEL_CONTEXT_WINDOW=400000`，消费者文档也按 400k 描述 Max。把 Max 从 400k 降到 200k 是独立的产品 / 成本迁移决策，不是本次补充 OpenRouter 模型的必要条件；如果未来决定下调，需要单独更新消费者文档、Desktop 配置和迁移说明。

### Runtime Router

新增的是一个 **model runtime dispatcher**，不是把现有 `UpstreamAccountRouter` 改几个参数。

当前 `UpstreamAccountRouter` 是 Codex 同质 upstream account pool：

- `GATEWAY_UPSTREAM_ACCOUNTS_JSON` 只接受 `provider: "openai-codex"`。
- pool config 需要 `codexHome`，并用 `auth.json` 存在性判断启动健康状态。
- `accountFromPoolConfig()` 的 `credentialRef` 是 `CODEX_HOME:<account_id>`。
- 选择策略是 least-inflight / soft-affinity，用于多个 Codex 登录态之间负载均衡，不是 public model -> runtime 的分发器。

因此 OpenRouter runtime 必须走一条绕开 Codex account pool 的路径：

```text
public model registry
  -> model runtime dispatcher
     -> codex runtime: existing UpstreamAccountRouter + CodexProviderAdapter
     -> openrouter runtime: configured OpenAI-compatible adapter instance
```

`POST /v1/chat/completions` 应先解析 public model，再选择 runtime：

1. 解析 request body。
2. 用 `parsed.model` 查 public model registry。
3. 模型不存在或未启用时返回 `404 model_not_found`，或明确的维护错误。
4. 检查 credential / entitlement 是否允许该 public model。
5. 按 public model 的 token policy 估算 prompt，并执行 token budget / rate limit。
6. 按 runtime 路由：
   - `codex`：走现有 Codex account pool 和 `CodexProviderAdapter`。
   - `openrouter`：走 registry 绑定的 OpenAI-compatible adapter 实例，不进入 `GATEWAY_UPSTREAM_ACCOUNTS_JSON`，不依赖 `CODEX_HOME` / `auth.json`。
7. 写入 request observation。

这里不能简单复用当前 `/v1/chat/completions` 的顺序。当前代码在模型校验后会立即选择 Codex upstream account，并且 token budget 从 request context 读取 `upstreamAccount/provider`。新增 OpenRouter runtime 时，需要先确定 public model，再写入正确 runtime context。

推荐把 OpenRouter 作为 Gateway 内部 runtime，而不是 Desktop provider 或 Codex upstream account：

```text
public model: pro
  -> runtime: openrouter
  -> runtime instance id: openrouter-main
  -> upstream model: z-ai/glm-5.2
```

这里的 `openrouter-main` 是 Gateway 内部 runtime instance id，用于限流、日志和 request attribution；它不是 `upstream_accounts` 表中的 Codex 登录态，也不应参与 Codex account cooldown / reauth 逻辑。

第一版建议引入独立 `ChatRuntimeContext`，而不是把所有路径继续伪装成 `UpstreamAccountRouter` 的返回值：

```text
ChatRuntimeContext
  - publicModelId: medcode | pro | standard
  - runtime: codex | openrouter
  - runtimeInstanceId: sub_openai_codex_dev | codex-pro-1 | openrouter-main
  - provider: openai-codex | openrouter
  - upstreamModel: gpt-5.5 | z-ai/glm-5.2 | deepseek/deepseek-v4-pro
  - limits: contextWindow / maxOutputTokens / token policy
  - adapter: ProviderAdapter
  - adapterInputUpstreamAccount: actual Codex account | virtual OpenRouter account
  - attributionAccount: same id/provider as adapterInputUpstreamAccount
```

实现决策：首个 PR 不重构 `ProviderAdapter.message()`、`collectProviderMessage()` 或 strict tools 的输入接口。当前这些路径都要求 `upstreamAccount: UpstreamAccount`，因此 OpenRouter runtime 也构造一个**内存态、不落库**的 virtual `UpstreamAccount` 传入 adapter：

```ts
const openRouterVirtualAccount: UpstreamAccount = {
  id: "openrouter-main",
  provider: "openrouter",
  label: "OpenRouter Main",
  credentialRef: "ENV:MEDCODE_OPENROUTER_API_KEY",
  state: "active",
  lastUsedAt: null,
  cooldownUntil: null
};
```

这个 virtual account 只用于兼容 adapter 输入、session attribution、token budget 和 observation 仍依赖 `upstreamAccount.id/provider` 的代码路径；它不进入 `upstream_accounts` 表，不带 `CODEX_HOME` credentialRef，不用 `auth.json` 做健康检查，也不参与 Codex reauth / cooldown / sticky session。OpenRouter adapter 从自身构造器配置读取 base URL、api key env、upstream model、reasoning policy 和 timeout，不能从 `credentialRef` 推导 Codex login state。

后续如果要完全去掉这个兼容层，再单独重构 `ProviderAdapter` / `MessageInput` / strict tools 为 runtime-aware 接口。该重构不放入首个 PR，避免把模型接入和核心 adapter contract 迁移绑在一起。

### ProviderKind 和 Upstream Runtime 标识

当前 `ProviderKind` 是封闭联合，尚无 `openrouter`。OpenRouter 接入需要明确两层标识：

- `provider`: 粗粒度供应商标识，进入 token ledger 和 `request_events.provider`。建议新增 `ProviderKind = "openrouter"`，不要复用 `openai-api` 或 `deepseek`，因为第一版上游是 OpenRouter 聚合商，计费、错误、限流和可用性边界都属于 OpenRouter。
- `upstream_runtime`: Gateway 内部 runtime 类型，如 `codex` / `openrouter`，用于区分路由路径。
- `upstream_model`: 真实上游模型，如 `gpt-5.5` / `z-ai/glm-5.2` / `deepseek/deepseek-v4-pro`，只在 Gateway 内部 admin/ops 可见。
- `public_model_id`: 客户端可见模型，如 `medcode` / `pro` / `standard`。

这四个字段不要混用。第一版实现建议：

```text
request_events.provider         = openai-codex | openrouter
request_events.upstream_runtime = codex | openrouter
request_events.upstream_model   = gpt-5.5 | z-ai/glm-5.2 | deepseek/deepseek-v4-pro
request_events.public_model_id  = medcode | pro | standard
```

因此答案不是“新增一个真正的 OpenRouter upstream account pool”，而是“新增 `ProviderKind=openrouter`，并在独立 runtime context 内提供 virtual attribution account”。这样 token budget ledger、`request_events.provider` 和现有 observation hook 有稳定的 provider/account 归因，但模型路由、凭证健康、并发控制和失败降级不被绑死在 Codex account pool 语义上。

### OpenRouter Adapter

新增通用 OpenAI-compatible text adapter：

```text
OpenAICompatibleProviderAdapter
  - baseURL: https://openrouter.ai/api/v1
  - apiKeyEnv: MEDCODE_OPENROUTER_API_KEY
  - upstreamModel: z-ai/glm-5.2
  - reasoning: { effort: "none" }
  - stream: true
  - map non-stream response -> Gateway collected message
  - map SSE chunks -> Gateway StreamEvent
  - map usage -> request_events token fields
  - map upstream errors -> GatewayError
  - support AbortSignal for client abort
```

当前 `MessageInput` 只包含 `upstreamAccount/session/subject/scope/message/signal/onProviderError`，没有 `model`、`reasoning`、`tools` 字段。因此第一版不应尝试在每次 `message()` 调用时动态传模型参数。public model registry 必须映射到专属 adapter/runtime 实例：

```text
medcode  -> CodexProviderAdapter(model=gpt-5.5) + Codex account pool
expert   -> OpenAICompatibleProviderAdapter(upstreamModel=z-ai/glm-5.2, reasoning effort high)
pro      -> OpenAICompatibleProviderAdapter(upstreamModel=z-ai/glm-5-turbo, reasoning disabled)
standard -> OpenAICompatibleProviderAdapter(upstreamModel=deepseek/deepseek-v4-pro, reasoning disabled)
```

也就是说，`OpenAICompatibleProviderAdapter` 的 `upstreamModel`、reasoning 策略、base URL、timeout、attribution headers 都是构造器配置，而不是 `MessageInput` 参数。后续如果要做同一个 adapter 实例内的动态模型切换，需要先扩展 `MessageInput` 或引入新的 runtime call input；第一版不做。

建议 env：

```env
MEDCODE_OPENROUTER_API_KEY=
MEDCODE_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
MEDCODE_OPENROUTER_SITE_URL=https://instmarket.com.au
MEDCODE_OPENROUTER_APP_TITLE=MedCode
MEDCODE_OPENROUTER_TIMEOUT_MS=180000
```

OpenRouter key 只进入 Gateway 部署密钥，不进入 repo、Desktop、诊断事件或 admin audit。

2026-06-26 adapter-spike 发现：`z-ai/glm-5.2` 和 `deepseek/deepseek-v4-pro` 默认都会启用 reasoning，小 `max_tokens` 下可能先消耗 completion tokens 并返回 reasoning 截断提示，而不是业务答案。Gateway adapter 必须显式控制 OpenRouter reasoning 参数，不能依赖模型默认值。

实测摘要，未记录 key 或完整用户内容：

| 上游模型 | 请求 reasoning | `message.reasoning` | `completion_tokens_details.reasoning_tokens` | 结果 |
| --- | --- | --- | --- | --- |
| `z-ai/glm-5.2` | 未设置 | 有 | 136 | reasoning 默认开启 |
| `z-ai/glm-5.2` | `{ "enabled": false }` | 无 | 0 | 当前可关闭 |
| `z-ai/glm-5.2` | `{ "effort": "none" }` | 无 | 0 | 当前可关闭 |
| `deepseek/deepseek-v4-pro` | 未设置 | 有 | 29 | reasoning 默认开启 |
| `deepseek/deepseek-v4-pro` | `{ "enabled": false }` | 无 | 0 | 当前可关闭 |
| `deepseek/deepseek-v4-pro` | `{ "effort": "none" }` | 无 | 0 | 当前可关闭 |

OpenRouter 文档把 `reasoning.effort: "none"` 描述为关闭 reasoning 的方式；`enabled:false` 虽然 2026-06-26 实测可用，但不作为第一版上线契约。第一版策略：

- Expert 默认显式发送 `reasoning: { "effort": "high" }`。
- Pro / Standard 默认显式发送 `reasoning: { "effort": "none" }`。
- adapter smoke / CI 必须分别断言 Expert 携带 high reasoning、Pro / Standard 不产生 reasoning tokens；如果 OpenRouter 后续拒绝 `effort:"none"` / `effort:"high"` 或行为变化，应禁用对应 public model 并重新评估。

### Identity Guard 和 Prompt 注入

Codex 路径目前主要依赖客户端 / MedEvidence 层把 system prompt 拼入消息内容；`CodexProviderAdapter` 的 thread options 没有单独传 instructions。OpenRouter 路径没有 `CODEX_HOME` 或 Codex 登录态可承载身份约束，因此 Gateway 必须显式注入 MedCode identity guard。

第一版注入点必须限定在 OpenRouter runtime / OpenRouter adapter 内，不能无条件修改共享的
`chatMessagesToPrompt()` 或 `chatMessagesToStrictToolPrompt()` 输出。原因是 Max / `model=medcode`
兼容路径依赖这些 prompt builder；如果在共享 builder 里追加 guard，会让所有旧客户端的
Codex / `gpt-5.5` prompt 字节发生变化，违反 backward compatibility 硬门槛。

建议实现：

- Codex / `medcode` runtime：继续使用现有 prompt builder，prompt 字节保持不变。
- OpenRouter 普通聊天：OpenRouter adapter 在发送上游请求时注入 Gateway-owned identity guard，例如作为 OpenAI-compatible `system` message。
- OpenRouter strict tools：同一个 OpenRouter adapter 注入 identity guard；strict JSON envelope prompt 本身不因 Codex 路径改变。
- tool-result follow-up：只要 public model 路由到 OpenRouter，同样通过 OpenRouter adapter 注入 guard。

OpenRouter adapter 不应指望上游模型“自然知道自己是 MedCode”。必须新增 E2E / unit smoke：

- 询问“你是什么模型 / 你的供应商是谁 / 是否通过 OpenRouter 调用”时，不泄漏真实上游。
- strict tools required/named/none 三条路径均不泄漏真实上游。
- client diagnostic metadata 只出现 public model id。

### `/v1/models`

`GET /v1/models` 返回 enabled public models：

```json
{
  "object": "list",
  "data": [
    {
      "id": "medcode",
      "object": "model",
      "created": 0,
      "owned_by": "medcode",
      "context_window": 400000,
      "max_context_window": 400000,
      "max_output_tokens": 128000
    },
    {
      "id": "pro",
      "object": "model",
      "created": 0,
      "owned_by": "medcode",
      "context_window": 200000,
      "max_context_window": 200000,
      "max_output_tokens": 128000
    },
    {
      "id": "standard",
      "object": "model",
      "created": 0,
      "owned_by": "medcode",
      "context_window": 200000,
      "max_context_window": 200000,
      "max_output_tokens": 128000
    }
  ]
}
```

`GET /v1/models/:id` 也只按 public id 返回同一套 public limit metadata。不要返回 `gpt-5.5`、`z-ai/glm-5.2` 或 `deepseek/deepseek-v4-pro`。

`context_window` 和 `max_context_window` 都是 public/enforced metadata，不是上游物理 context。第一版不要在 `/v1/models` 中暴露 OpenRouter 1M context，否则 Desktop 可能把 1M 当作 compaction / 截断预算。OpenRouter 的 `upstreamContextWindow=1048576` 只留在 Gateway 内部 registry、admin diagnostics 和灰度评估中。

### Entitlement / Plan

现有 `feature_policy.capabilities` 是字符串数组，当前只支持：

```json
{
  "capabilities": ["chat", "tools", "image_generation"]
}
```

不要把 `capabilities` 改成对象。第一版不做 per-model key entitlement；所有有效 MedCode key
都可使用 Gateway 当前启用的 MedCode public models。`medcode_models` 如已出现在历史 plan /
entitlement snapshot 中，只作为兼容元数据保留，不能用于拒绝 chat 模型：

```json
{
  "capabilities": ["chat", "tools"],
  "medcode_models": {
    "allowed": ["standard", "pro", "medcode"]
  }
}
```

当前 `validateFeaturePolicy()` 会重建返回对象，只保留已解析字段；未知字段不会自然透传。
如果保留 `medcode_models` 兼容字段，仍需同步修改：

- `FeaturePolicy` TypeScript interface。
- `validateFeaturePolicy()` parser。
- `publicFeaturePolicy()` serializer。
- plan create / billing admin / admin CLI 的 feature policy 文件解析和输出。
- entitlement snapshot row mapper，确保 `feature_policy_snapshot_json` 中的 `medcode_models` 不被丢弃。

第一版模型可用性规则：

- `/v1/models` 是客户端判断可用 public model 的唯一来源。
- Gateway 不按 key / plan / entitlement 对 `medcode`、`expert`、`pro`、`standard` 做差异化授权。
- `medcode_models.allowed` 如果存在，不作为 chat model 拒绝依据；公开 serializer 输出时也必须补齐 `medcode`、`expert`、`pro`、`standard`，避免客户端 UI 误禁用模型。
- 不需要对已发放 key 做 `medcode_models` backfill；backfill 只能作为报表/展示清理，不能成为模型可用性的必要条件。

兼容规则：

- `medcode` public model id 在第一版永远不被 `medcode_models` 门禁拒绝；它继续映射到现有 Codex / `gpt-5.5`。
- 有效 key 不因 `medcode_models` 缺失或内容不含某个模型而被拒绝。
- legacy 用户没有 entitlement history 时，除非显式开启 `GATEWAY_REQUIRE_ENTITLEMENT=1`，兼容期也允许当前 Gateway 已启用的 MedCode public models。
- 已进入 entitlement 体系但没有 active entitlement 时，继续返回 `plan_expired` 或 `plan_inactive`。
- `plan_capability_required` 不用于 Max / Expert / Pro / Standard 的模型档位限制；它只保留给其他能力类门禁。

`GET /gateway/credentials/current` 仍用于验证 key 有效性，不发起模型调用。为了改善 UI，它可以在 active entitlement 可用时返回允许的 public models：

```json
{
  "entitlement": {
    "feature_policy": {
      "capabilities": ["chat", "tools"],
      "medcode_models": {
        "allowed": ["standard", "expert", "pro", "medcode"]
      }
    }
  }
}
```

如果未来产品决定让某些低价档不再包含 Codex / `gpt-5.5` 的 Max 路径，那是独立的计费/权限变更，
需要显式迁移、用户告知和客户端发布配合；不能搭本次 Gateway additive 兼容部署一起发生。

客户端不需要据此禁用 Max / Expert / Pro / Standard；模型可用性读取 `/v1/models`，且不能把该接口当作某个模型的 live probe。

entitlement 解析仍要避免重复查询。当前 `beginTokenBudget()` 内部会调用
`entitlementAccessForSubject()`，并在那里处理 active / expired / inactive / legacy 和
`forbidden_scope`。推荐把 entitlement 解析抽成一个共享步骤：

```text
resolveChatEntitlementAccess(subject, credential, scope)
  -> active entitlement / plan status
  -> scope decision
  -> effective token policy
```

然后：

- runtime dispatcher 在调用上游前使用同一个 resolved access 判断 scope / plan 状态 / token policy。
- token budget hook 接收 resolved access / effective token policy，不再重复查询 entitlement。
- `forbidden_scope`、`plan_expired`、`plan_inactive` 的行为矩阵集中在一个 helper 和一组单测里。

首个 PR 不需要把 `publicModelId` 传入 entitlement / token budget 门禁；模型选择由 public registry 和 runtime dispatcher 处理，entitlement 只维护 scope / plan 状态 / token policy。

### Token Budget 和成本控制

Expert / Pro / Standard 第一版必须有实际拦截能力，而不仅是记录用量。

上线门槛：

- `maxPromptTokensPerRequest` 对 Expert / Pro / Standard 生效。
- `maxTotalTokensPerRequest` 或 reserve policy 生效。
- 每日 / 每月 token budget 对 active entitlement 生效。
- 缺少 provider usage 时按 `missingUsageCharge` 落账。
- public smoke 覆盖 token budget 拦截和 request event 归因。

在这些门槛验证前，不应把 Expert / Pro / Standard 的 context window 开到 1M。

### Observability

新增字段用于 Gateway 内部观测和 admin CLI：

- `request_events.public_model_id`
- `request_events.upstream_runtime`
- `request_events.upstream_model`

这些字段当前都不存在。实现时需要同步修改：

- SQLite migration：`request_events` 新增三列。
- `packages/store-sqlite/src/columns.ts`：补 SELECT 列集合。
- `packages/store-sqlite/src/request-events.ts`：补 insert / list / report 聚合。
- `packages/store-sqlite/src/row-mappers.ts`：补 row mapper。
- `packages/core/src/types.ts`：补 `RequestEventRecord` 字段，并新增 `ProviderKind = "openrouter"`。
- `apps/gateway/src/http/observation.ts`：从 runtime dispatcher 写入 public model / upstream runtime / upstream model。
- `apps/admin-cli` serializers / events / report-usage：补展示和过滤维度。
- quota dashboard / realtime token usage 如展示 request events，也要补新字段。

普通客户端诊断和 UI 只记录 public model id：`medcode`、`expert`、`pro`、`standard`。不上传真实上游模型、OpenRouter provider routing、OpenRouter key 或供应商账号信息。

Admin CLI / usage report 需要能按以下维度聚合：

- public model id
- upstream runtime
- upstream model
- credential / user
- token usage
- error code
- latency / first byte

### Tool Calling

第一版不依赖 OpenRouter / DeepSeek / GLM 的 native tool-call 一致性。

Expert / Pro / Standard 继续使用现有 Gateway strict client-defined tools：

```text
client tools[] -> Gateway strict prompt -> upstream model returns JSON envelope
  -> Gateway validates schema
  -> Gateway emits OpenAI-shaped tool_calls
```

这样避免不同上游的 native tool-call streaming delta、reasoning 混流、provider fallback 行为进入 Desktop。第一版 Expert 已验证 native tool-call + high reasoning 路径；Pro / Standard 在 strict tools 路径关闭 reasoning，Gateway 只解析纯 JSON envelope。

后续如果验证 native tool-call 或 reasoning 稳定，再考虑对 OpenRouter runtime 开 native pass-through 或 reasoning 模式。届时需要新增 adapter 单测，覆盖 reasoning 内容剥离、JSON envelope 解析、流式增量和 usage 归因。

## Desktop / App 设计

Desktop 继续只配置 MedCode provider：

```text
Settings > Providers > MedCode
  - 粘贴统一 key
  - Test 验证 /gateway/credentials/current
```

模型选择器展示同一 provider 下的四档：

```text
MedCode
  Max
  Expert
  Pro
  Standard
```

建议配置：

```jsonc
{
  "provider": {
    "medcode": {
      "name": "MedCode",
      "npm": "@ai-sdk/openai-compatible",
      "api": "https://gw.instmarket.com.au/v1",
      "env": ["MEDEVIDENCE_KEY"],
      "models": {
        "medcode": {
          "name": "Max",
          "tool_call": true,
          "reasoning": false,
          "attachment": true,
          "temperature": true,
          "limit": { "context": 400000, "output": 128000 },
          "modalities": { "input": ["text", "pdf"], "output": ["text"] },
          "status": "beta"
        },
        "expert": {
          "name": "Expert",
          "tool_call": true,
          "reasoning": "high",
          "attachment": false,
          "temperature": true,
          "limit": { "context": 200000, "output": 128000 },
          "modalities": { "input": ["text"], "output": ["text"] },
          "status": "beta"
        },
        "pro": {
          "name": "Pro",
          "tool_call": true,
          "reasoning": false,
          "attachment": false,
          "temperature": true,
          "limit": { "context": 200000, "output": 128000 },
          "modalities": { "input": ["text"], "output": ["text"] },
          "status": "beta"
        },
        "standard": {
          "name": "Standard",
          "tool_call": true,
          "reasoning": false,
          "attachment": false,
          "temperature": true,
          "limit": { "context": 200000, "output": 128000 },
          "modalities": { "input": ["text"], "output": ["text"] },
          "status": "beta"
        }
      }
    }
  },
  "model": "medcode/medcode"
}
```

说明：

- `Max` 使用现有 `medcode` id，减少迁移风险。
- 当前单模型 UI 如果显示为 `MedCode`，发布三档后同一个 public id `medcode` 的显示名会变成 `Max`。这是预期的产品命名迁移，不是历史 session 或模型 id 迁移。
- `Expert` / `Pro` / `Standard` 第一版先标记 text-only。
- `Expert` 第一版标记 high reasoning；`Pro` / `Standard` 第一版标记 `reasoning: false`。
- 不在普通 UI 中显示 `gpt-5.5`、`GLM-5.2`、`DeepSeek V4 Pro`。
- Desktop 不需要按 key 禁用 Max / Expert / Pro / Standard；模型列表以 `/v1/models` 为准。

### Client Team Checklist

客户端团队不需要研究 OpenRouter、DeepSeek、Z.AI、上游价格、上游 key、provider routing 或模型 fallback。这些属于 Gateway owner 边界。客户端只消费 Gateway 暴露的 public contract：

```text
provider: medcode
baseURL: https://gw.instmarket.com.au/v1
credential env: MEDEVIDENCE_KEY
public models: medcode / expert / pro / standard
```

客户端需要完成：

1. 保持 MedCode 是唯一用户可见 provider，不新增 OpenRouter / DeepSeek / Z.AI provider。
2. 保持默认模型为 `medcode/medcode`。
3. 在 MedCode provider 下展示四档模型：
   - `medcode` -> `Max`
   - `expert` -> `Expert`
   - `pro` -> `Pro`
   - `standard` -> `Standard`
4. 按本节配置设置 Desktop 侧能力声明：
   - `Max` `limit.context` 是 `400000`，保持现有行为。
   - `Expert` / `Pro` / `Standard` `limit.context` 是 `200000`。
   - `Max` output `128000`。
   - `Expert` / `Pro` / `Standard` 不单独设置 32k output 上限，按 Gateway `/v1/models` 返回的 `max_output_tokens` 配置；当前默认与 Max 持平为 `128000`。
   - 客户端需专门验证 `limit.output=128000`、`limit.context=200000` 时的 compaction / 截断预算计算，确保不会错误地把输出预留吞掉全部输入空间。
   - 第一版 `Expert` 设 high reasoning，`Pro` / `Standard` 设 `reasoning: false`。
   - `Expert` / `Pro` / `Standard` 第一版 text-only，不声明 PDF / file input。
5. Provider Test 只调用 `/gateway/credentials/current` 验证 key，不对每个模型发 live probe。
6. 不要使用 `feature_policy.medcode_models.allowed` 禁用 Max / Expert / Pro / Standard；模型可用性以 `/v1/models` 当前返回的 MedCode public models 为准。
7. 模型调用错误按 Gateway 结构化错误处理：
   - `model_not_found`：模型未启用或客户端配置早于 Gateway。
   - `plan_capability_required`：当前套餐不含请求的非模型能力。
   - `plan_expired` / `plan_inactive`：订阅不可用。
   - `rate_limited`：限流。
   - `upstream_timeout` / `upstream_unavailable`：上游暂时不可用。
8. client message / diagnostic event 只记录 public model id：`medcode`、`expert`、`pro`、`standard`。不要记录或上传真实上游模型名、OpenRouter provider routing、OpenRouter key 或供应商账号信息。
9. E2E 覆盖：
   - 默认 `medcode/medcode` 仍可用。
   - 选择 `expert` / `pro` / `standard` 后普通对话可用。
   - 选择 `expert` / `pro` / `standard` 后医学问题仍能触发 `medevidence` 工具。
   - 当前模型显示名从 `MedCode` 变成 `Max` 属预期迁移。
   - 普通 UI 和诊断中没有上游模型名泄漏。

客户端团队需要自行验证的仅限 OpenCode fork / Desktop 本地行为：

- `opencode.jsonc` 中 `limit.context` 是否确实驱动 Desktop compaction / 截断。
- 现有历史 session 在 `medcode` 显示名从 `MedCode` 变成 `Max` 后是否只影响 UI 文案，不影响 session 读取。
- 模型选择器如何只依据 `/v1/models` 做兼容展示。
- 展示 Gateway 结构化错误的 UI 文案。

这些是客户端本地集成验证，不是上游模型或 OpenRouter 接入研究。

## 网络延迟和多区域 Gateway

第一版所有模型调用都应经过 Gateway 数据面：

```text
Desktop -> MedCode Gateway -> Codex / OpenRouter / other upstream
```

不要为了降低大陆用户延迟而让 Desktop 直连 OpenRouter。延迟问题通过 Gateway 部署形态解决：

1. 短期：所有 Pro / Standard 先走现有 Gateway，记录 p50/p95 latency、first byte、429/5xx、tool-call 成功率。
2. 中期：增加香港、新加坡、日本或澳洲区域 Gateway。统一 key resolver 或配置服务返回合适的 `endpoint_base_url`。
3. 长期：多区域 Gateway + 统一 entitlement / usage 汇总。

## 测试计划

### Gateway 单测

- registry parse 成功 / 失败 / fallback。
- registry file 和 env 优先级。
- 旧客户端兼容 smoke：未启用 Expert / Pro / Standard 时，旧 key + `model=medcode` 的普通聊天、streaming、strict tools 仍走 Codex / `gpt-5.5`。
- `/v1/models` 只返回 enabled public models。
- `/v1/models` 返回现有兼容字段 `context_window`、`max_context_window`、`max_output_tokens`；Max 为 400k，Expert / Pro / Standard 为 200k public context。
- `/v1/models/unknown` 返回 `model_not_found`。
- `/v1/chat/completions` 按 public model 进入 model runtime dispatcher。
- OpenRouter runtime 不依赖 Codex account pool、`CODEX_HOME` 或 `auth.json`。
- OpenRouter runtime 使用不落库 virtual `UpstreamAccount` 调用 `ProviderAdapter.message()`、`collectProviderMessage()` 和 strict tools，不触发 Codex reauth / cooldown / sticky session 逻辑。
- `GATEWAY_UPSTREAM_ACCOUNTS_JSON` 仍只管理 Codex 登录态；OpenRouter 不进入该 pool。
- `ProviderKind` 支持 `openrouter`，token ledger 和 request events 归因正确。
- public model registry 为 `expert` / `pro` / `standard` 构造独立 adapter/runtime 实例，不通过 `MessageInput` 动态传 model。
- Max / Expert / Pro / Standard 不做 per-model entitlement 拒绝。
- entitlement access 只查询一次，scope / plan 状态 / token policy 决策一致。
- active entitlement 的 `medcode_models.allowed` 即使不包含某个 public model，该模型也继续可用。
- 旧 entitlement 缺少 `medcode_models` 时允许当前 Gateway 已启用的 MedCode public models。
- request_events 写入 public model、runtime、upstream model。
- `feature_policy.medcode_models` parser / serializer / entitlement snapshot 不丢字段。
- OpenRouter adapter / runtime prompt 注入 identity guard，且 Codex / `medcode` prompt 字节不变。
- identity probing 不泄漏 OpenRouter / GLM / DeepSeek / upstream routing。
- OpenRouter adapter：
  - non-stream 文本响应。
  - streaming SSE 文本增量。
  - upstream usage 映射。
  - 401 / 429 / 5xx 错误归一化。
  - client abort 取消 upstream fetch。
  - Expert GLM 5.2 发送 `reasoning: { "effort": "high" }` 后稳定返回业务输出。
  - Pro turbo / Standard DeepSeek 发送 `reasoning: { "effort": "none" }` 后，不会返回 reasoning 截断提示，且 `reasoning_tokens=0`。

### Staging smoke

使用临时 Gateway key 和 OpenRouter key：

1. `GET /gateway/health`。
2. `GET /gateway/credentials/current`。
3. `GET /v1/models`，确认 enabled public models。
4. `POST /v1/chat/completions model=expert`，固定词返回。
5. `POST /v1/chat/completions model=pro`，固定词返回。
6. `POST /v1/chat/completions model=standard`，固定词返回。
7. streaming smoke，确认 `data: [DONE]`。
8. native / strict tools smoke，确认返回 `tool_calls`，再用 `role=tool` follow-up。
9. entitlement smoke，低档 key 调 Max 返回结构化权限错误。
10. token budget smoke，超限请求被拦截。
11. request_events 检查 public model、runtime、upstream model、token usage。
12. identity guard smoke，确认普通对话和 strict tools 路径不泄漏真实上游。

### Desktop E2E

- Provider 设置页仍只出现 MedCode。
- 模型选择器显示 Max / Expert / Pro / Standard。
- 默认模型仍是 `medcode/medcode`。
- Provider Test 只验证 credential，不调用具体模型。
- 选择 Expert / Pro / Standard 后能完成普通对话。
- 选择 Expert / Pro / Standard 后医学问题仍能触发 `medevidence` 工具。
- 普通 UI 和客户端诊断不泄漏 OpenRouter 或真实上游模型名。

## 灰度步骤

1. Gateway 实现 registry + OpenRouter adapter，但默认只启用 `medcode`。
2. 本地用 OpenRouter key 做 adapter 级 smoke。
3. Staging 仅对内部测试 key 开启 `standard`。
4. Staging 再开启 `pro`。
5. Staging 再开启 `expert`。
6. 观察 24-48 小时：
   - 成本 / token usage
   - latency / first byte
   - 429 / provider errors
   - strict tool-call 成功率
   - identity guard 命中
7. Desktop beta 包展示四档模型。
8. 扩大到真实试用 key。

## 回滚方案

最小回滚：

```env
MEDCODE_PUBLIC_MODELS_JSON=
MEDCODE_PUBLIC_MODELS_JSON_FILE=
```

或将 registry 改回只包含：

```json
{
  "medcode": {
    "displayName": "Max",
    "runtime": "codex",
    "upstreamModel": "gpt-5.5",
    "enabled": true
  }
}
```

如果 Desktop 已发布四档模型，Gateway 不应删除 public model id。必要时把 `expert` / `pro` / `standard` 临时标为维护中，或临时路由到 `medcode`，避免用户看到不可解释的 `model_not_found`。

## 风险和审核点

1. 数据流向和合规
   Expert / Pro / Standard 会把用户 prompt 发往 OpenRouter，再由 OpenRouter 路由到 Z.AI / DeepSeek 或其托管 provider。需要确认是否符合用户告知和数据处理边界。

2. 成本上限
   1M context 容易诱发高成本请求。第一版必须限制 public context，并验证 token budget enforcement。

3. OpenRouter 可用性
   OpenRouter 是聚合商，模型可用性、provider routing、价格可能变化。上线前和每次故障排查都应查询 Models API。

4. 工具调用稳定性
   先走 Gateway strict tools，避免不同上游 native tool-call 格式差异进入 Desktop。

5. 附件能力
   OpenRouter 当前 `z-ai/glm-5.2`、`z-ai/glm-5-turbo` 和 `deepseek/deepseek-v4-pro` 目录显示为 text-to-text。Expert / Pro / Standard 不应声明 PDF / file 输入，除非 Gateway 先做附件文本化。

6. 产品命名冲突
   我们的 Max / Expert / Pro / Standard 是 MedCode 档位；Z.AI 自己也有 Coding Plan Lite / Pro / Max。对外文案需要避免混淆。

7. 身份保护
   MedCode system prompt 仍需要求模型不要披露上游供应商、真实模型、routing、账号、部署等内部细节。OpenRouter 模型可能更容易自报真实身份，需要加强 identity guard E2E。

## 建议首个实施切片

首个 PR 只做 Gateway，不改 Desktop 发布面：

1. 新增 public model registry，默认只启用 `medcode`，Max 保持 400k public context。
2. 新增 model runtime dispatcher 和 `ChatRuntimeContext`，Codex 继续走 `UpstreamAccountRouter`，OpenRouter 走独立 runtime context + 不落库 virtual `UpstreamAccount`。
3. 新增 `ProviderKind="openrouter"`，并让 token budget / observation 能消费 runtime context 的 provider/account attribution。
4. 新增 OpenRouter / OpenAI-compatible adapter，按 public model 构造独立 adapter 实例，默认发送 `reasoning: { "effort": "none" }`。
5. 新增 OpenRouter prompt builder identity guard。
6. 保留 entitlement `feature_policy.medcode_models` schema、parser、serializer、entitlement snapshot 和 admin / billing 输出作为兼容元数据；不把它用于 chat model 授权。
7. 抽出 entitlement access helper，统一处理 scope、plan 状态和 token policy，避免重复查 entitlement。
8. 新增 request event 模型归因字段和 SQLite migration，并同步 admin CLI / report-usage / observation。
9. 增加 Gateway 单测和 adapter smoke，特别覆盖旧客户端 `model=medcode` 兼容路径。
10. 更新消费者文档：`docs/consumer-technical-guide.md`、`docs/client-api-key-validation-guide.md` 不再写死“model 必须是 medcode”，改为“当前默认/兼容 model 是 medcode；Gateway 开启后还可使用 `/v1/models` 返回的 public model id”。

第二个 PR 再改 Desktop 配置和 UI，让用户可见三档模型。

## 参考资料

- OpenRouter Quickstart: https://openrouter.ai/docs/quickstart
- OpenRouter Models API: https://openrouter.ai/docs/api/api-reference/models/get-models
- OpenRouter Reasoning Tokens: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
- OpenRouter GLM 5.2: https://openrouter.ai/z-ai/glm-5.2
- OpenRouter DeepSeek V4 Pro: https://openrouter.ai/deepseek/deepseek-v4-pro
- Z.AI GLM-5.2 overview: https://docs.z.ai/guides/llm/glm-5.2
- DeepSeek API first call: https://api-docs.deepseek.com/
