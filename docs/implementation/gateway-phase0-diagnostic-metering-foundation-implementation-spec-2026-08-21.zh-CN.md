# Gateway Phase 0：诊断与计量基础实施规格 v1

| 项目 | 内容 |
| --- | --- |
| 规格 ID | `gateway-phase0-diagnostic-metering-foundation-v1` |
| 文档版本 | `1.0` |
| 文档状态 | `implementation_ready` |
| 实现状态 | `not_implemented` |
| 部署状态 | `not_deployed` |
| 日期 | 2026-08-21 |
| 唯一生产权威 | R760 Gateway |
| 唯一公共 Origin | `https://goldencode.instmarket.com.au:1443` |
| 实现基线 | `feature/internal-phone-auth-v1@c528f4a8609dc88c56fc883426e54dd91ba73308`；实现前必须保留工作区中并行的 Phone Auth、客户端消息页及其他用户改动 |
| 目标 | 在不改变请求执行、重试、限流或计费行为的前提下，建立可用于后续故障转移的结构化失败分类，并把 Gateway 请求、上游尝试、故障重试、合同恢复、准确 Token 和估算 Token 分开统计 |

本文使用“必须”“不得”表示强制要求，使用“建议”表示不影响合同的实现选择。

本文是本轮 **Gateway Phase 0：诊断与计量基础** 的权威实施规格。它可以直接用于拆分代码任务、编写测试、生成发布候选和执行验收，但不表示代码已经实现、合并或部署。

## 1. 决策摘要

本阶段先实现两项基础能力：

1. 修正 Gateway 内部错误分类，使 `fetch failed`、DNS、连接、TLS、超时、HTTP 错误、流中断、客户端取消等事实不再全部折叠为无法区分的 `upstream_unavailable`。
2. 分开统计 Gateway 请求、真正开始的模型调用请求、上游尝试、故障重试、合同恢复、Provider 准确 Token、Gateway 估算 Token和缺失用量。

本阶段必须保持以下外部行为不变：

- 不增加 xAI 或其他 provider 的自动重试；
- 不切换 Mihomo 或任何代理出口；
- 不修改现有 RPM、RPD、并发和 Token 限额；
- 不修改计费、token reservation 或 entitlement 的准入结果；
- 不修改 `/v1/chat/completions` 的公开错误码、HTTP 状态码和客户端重试合同；
- 不要求 beta.38 或其他旧客户端升级；
- 不根据同一 `message_id` 下的多个请求猜测“客户端自动重试”。

一句话原则是：

> Phase 0 只记录事实并澄清统计口径，不根据这些事实改变请求行为。

## 2. 规格效力与相关文档

### 2.1 本规格负责的内容

本规格冻结以下实现决策：

- provider 失败事实的内部类型和分类规则；
- 错误分类从 adapter 到 stream、request observation、SQLite、CLI 和管理页的传递方式；
- 上游尝试目的 `purpose` 的枚举和计数规则；
- 请求、模型调用、尝试、故障重试和合同恢复的统计定义；
- 准确 Token、估算 Token、预检估算和缺失用量的展示定义；
- SQLite additive migration、历史数据兼容、测试、上线和回滚要求。

### 2.2 保持有效的既有合同

以下既有合同继续有效，本规格不替代它们：

- `docs/implementation/gateway-rate-limit-error-contract-2026-07-15.zh-CN.md` 继续负责公开限流合同；
- `docs/implementation/openai-sse-termination-error-contract-2026-07-18.zh-CN.md` 继续负责 SSE 完成与非正常终止判定；
- `docs/implementation/medcode-public-model-usage-statistics.zh-CN.md` 继续负责模型和 token ledger 的归因基础；
- `docs/operations/r760-control-plane-authority.md` 继续负责 R760 权威、Azure 兼容合并和生产写入边界；
- `docs/outbox/medevidence-desktop-retry-image-replay-request-observability-optimization-recommendations-2026-08-21.zh-CN.md` 只负责 Desktop 建议，不是本次 Gateway 实现合同。

发生冲突时，本规格只在“内部 provider 失败分类、上游尝试目的、管理页计量口径”范围内优先；公开客户端错误合同和真实 token ledger 仍以对应既有合同为准。

## 3. 当前实现事实与缺口

### 3.1 已有能力

当前代码已经具备以下基础：

- `request_events` 每个 `request_id` 保存一个 Gateway 请求终态；
- `upstream_attempt_count` 和 `upstream_attempts_json` 已存在；
- `UpstreamAttemptSummary` 已能保存 provider、runtime、model、HTTP 状态、上游 request ID、耗时、工具调用和每次尝试 Token；
- `request_events` 已有 `prompt_tokens`、`completion_tokens`、`total_tokens`、`estimated_tokens`、`gateway_estimated_prompt_tokens` 和 `usage_source`；
- `reportRequestUsage` 已分别聚合准确 Token 和估算 Token；
- 客户端消息管理页已能按 `client_message_id` 关联请求事件并展示成功、失败、耗时和 Token；
- 通用 stateless 路径已经存在 `primary` 与 `stateless_retry` 尝试；
- native tools 路径已经存在 validation/ack/empty-output 等恢复性尝试。

### 3.2 当前缺口

当前实现仍有以下问题：

1. `OpenAICompatibleProviderAdapter` 的多数非 HTTP 异常最终映射为 `upstream_unavailable`，无法区分 DNS、连接、TLS、代理和流中断。
2. `ProviderErrorDiagnostic` 的结构化事实主要写入日志，没有进入 request event 和上游尝试记录。
3. `streamErrorToGatewayError` 重新构造 `GatewayError` 时不能携带 provider 失败事实。
4. `UpstreamAttemptSummary.kind` 是详细流程名称，但没有稳定的“这是首尝试、故障重试还是合同恢复”维度。
5. 客户端消息页的 `request_count` 直接等于相关 `request_events` 行数；没有分别显示是否真正开始 provider 调用以及内部尝试数。
6. 页面把 `total_tokens + estimated_tokens` 作为 `effective_tokens` 放在一个“Token”标签下，容易被误读为全部都是 provider 精确 usage。
7. 旧客户端没有可靠的 client retry header；同一消息的多个 Gateway request ID 可能是正常工具循环，不能据此推断为自动重试。

## 4. 范围与非范围

### 4.1 本阶段范围

- `@codex-gateway/core` 的 provider 失败事实类型；
- OpenAI-compatible adapter 的结构化失败分类；
- Codex adapter 的最低完整失败分类；
- `StreamEvent`、`GatewayError`、provider stream summary 和 upstream attempt 的失败事实传递；
- 尝试目的 `purpose` 和请求级计数；
- `request_events` additive migration、写入、读取和报表聚合；
- Admin CLI `events`、`report-usage` 的新增内部字段；
- `/gateway/admin/client-messages.json` 的 additive 字段；
- `/gateway/admin/client-messages` 页面展示和排序；
- 单元、集成、迁移、兼容、性能、上线和回滚验证。

### 4.2 明确不在本阶段范围

- xAI 多出口、代理池、Mihomo selector 或健康检查；
- 任何新增自动重试、重试次数变化或 backoff 变化；
- 修改 `maxStatelessAttempts` 或 `isStatelessRetryableProviderError`；
- 客户端自动重试上限、按钮、文案和历史图片回放；
- 新增 Desktop header 或要求 beta.38 改造；
- 按失败类别自动熔断、隔离、切换账号或切换出口；
- 修改 token reservation 的 acquire/finalize 数值；
- 修改用户账单、余额、Plan、entitlement、quota window 或限流消耗；
- 把内部失败分类暴露给普通客户端；
- 对历史错误文本做不可靠的批量猜测或重写；
- 部署 Azure、CN1、Nginx、Mihomo、Research Worker 或 Desktop。

## 5. 术语和不可破坏的不变量

### 5.1 术语

| 术语 | 权威定义 |
| --- | --- |
| Gateway 请求 | 一个实际进入 Gateway 数据面并形成 `request_events.request_id` 的 HTTP 请求；即使在 Gateway 内被限流，也仍是一个 Gateway 请求 |
| 模型调用请求 | `upstream_attempt_count > 0` 的 Gateway 请求，表示该请求至少启动了一次 provider adapter 尝试 |
| 上游尝试 | Gateway 对 provider adapter 启动的一次调用；一个 Gateway 请求可以有 0、1 或多次上游尝试 |
| 首尝试 | `purpose=primary` 的上游尝试 |
| 故障重试 | 因上游服务、账号、网络或超时类失败而追加的尝试；`purpose=failure_retry` |
| 合同恢复 | 因工具调用校验、空确认、输出修复等合同原因而追加的尝试；`purpose=contract_recovery` |
| 客户端自动重试 | Desktop 对同一 Agent turn 再发起新的 Gateway 请求；只有客户端显式提供可靠元数据时才能确认 |
| Provider 准确 Token | provider 返回 usage 后记录的 prompt/completion/total token |
| Gateway 估算 Token | provider 未返回 usage 时，Gateway 最终采用的估算用量 `estimated_tokens` |
| 预检 Prompt 估算 | 请求准入前的 `gateway_estimated_prompt_tokens`；它不是 provider usage，也不得和最终 Token 相加 |
| 可归因 Token | `provider_total_tokens + estimated_tokens`；仅用于兼容汇总/排序，展示时必须给出准确与估算拆分 |

### 5.2 计数不变量

每个新写入的 request event 必须满足：

```text
gateway_request_count = 1
upstream_attempt_count >= 0
failure_retry_count >= 0
contract_recovery_count >= 0
unclassified_additional_attempt_count >= 0

failure_retry_count
  + contract_recovery_count
  + unclassified_additional_attempt_count
  <= max(upstream_attempt_count - 1, 0)
```

附加要求：

- provider 调用前被 Gateway 拒绝：`upstream_attempt_count=0`；
- 只有一次普通 provider 尝试：`upstream_attempt_count=1`、三个附加计数均为 `0`；
- 一个请求成功前发生一次故障重试：`upstream_attempt_count=2`、`failure_retry_count=1`；
- native tools validation recovery：`upstream_attempt_count=2`、`contract_recovery_count=1`，不得计为故障重试；
- 多个 Gateway request ID 永远不能仅凭相同 `client_message_id` 被改写为客户端重试；
- 成功请求之前曾发生失败尝试时，请求终态仍为成功，失败事实保留在对应 attempt 中。

### 5.3 Token 不变量

- Provider 准确 Token 和 Gateway 估算 Token 必须分列；
- 同一个请求有准确 `total_tokens` 时，`estimated_tokens` 不得再次加入该请求的可归因 Token；
- `gateway_estimated_prompt_tokens` 只作预检和诊断展示，不进入 Token 合计；
- 多次上游尝试的 attempt usage 可以求和成为请求级 provider usage，但不得再次与已经包含这些 attempt 的请求级 usage 重复求和；
- 本阶段不得改变 token reservation 的最终值和 `usage_source` 判定；
- `usage_missing` 必须继续表示既无准确 usage、也无最终估算的请求；
- UI 不得把估算 Token 显示为“输入 Token”或“Provider Token”。

## 6. 目标数据流

```text
原始 provider 异常 / HTTP 响应 / 流终止
  -> classifyProviderFailure（记录事实，不决定重试）
  -> ProviderErrorDiagnostic + StreamEvent.error.providerFailure
  -> GatewayError.providerFailure（内部字段，不进入公开响应）
  -> ProviderStreamSummary / UpstreamAttemptSummary
  -> Fastify request observation
  -> request_events 标量终态字段 + upstream_attempts_json
  -> reportRequestUsage / Admin CLI / client-messages admin JSON
  -> 管理页按请求、尝试、故障重试、合同恢复和 Token 来源展示
```

失败分类和重试策略必须分离：分类器只陈述“发生了什么”；未来 Phase 1 再根据分类、阶段、是否已输出和剩余 deadline 决定是否切换出口。

## 7. Core 类型合同

### 7.1 新增 provider 失败事实类型

在 `packages/core/src/provider-failure.ts` 新增并从 `packages/core/src/index.ts` 导出：

```ts
export type ProviderFailureOrigin =
  | "client"
  | "gateway"
  | "network"
  | "proxy"
  | "provider"
  | "unknown";

export type ProviderFailureKind =
  | "client_aborted"
  | "deadline_exceeded"
  | "dns"
  | "connect"
  | "connection_reset"
  | "tls"
  | "proxy_connect"
  | "http_auth"
  | "http_rate_limit"
  | "http_request"
  | "http_timeout"
  | "http_server"
  | "response_body_missing"
  | "stream_incomplete"
  | "stream_protocol"
  | "provider_reauth"
  | "unknown";

export type ProviderFailureStage =
  | "before_headers"
  | "after_headers"
  | "streaming"
  | "unknown";

export interface ProviderFailureClassification {
  origin: ProviderFailureOrigin;
  kind: ProviderFailureKind;
  stage: ProviderFailureStage;
  transportCode: string | null;
  upstreamStatus: number | null;
}

export type UpstreamAttemptPurpose =
  | "primary"
  | "failure_retry"
  | "contract_recovery"
  | "unknown";
```

枚举是内部持久化合同。新增值必须是 additive；不得重命名已经写入 SQLite 的值。

### 7.2 扩展 `GatewayError`

`packages/core/src/errors.ts` 中给 `GatewayError` 增加可选内部字段：

```ts
readonly providerFailure?: ProviderFailureClassification;
```

构造参数同步增加 `providerFailure?`。必须满足：

- `apps/gateway/src/http/error-response.ts` 不序列化该字段；
- `/v1/chat/completions` 的 error body 不新增 `failure_origin`、`failure_kind`、`failure_stage` 或 `transport_code`；
- 现有 `GatewayFailureKind` 继续只承担客户端恢复合同，不得拿它表达网络/代理事实；
- `toGatewayError`、错误复制和 provider summary attach 流程必须保留该内部字段。

### 7.3 扩展 `StreamEvent` 和诊断

`StreamEvent` 的 error 分支增加：

```ts
providerFailure?: ProviderFailureClassification;
```

`ProviderErrorDiagnostic` 增加必填字段：

```ts
failure: ProviderFailureClassification;
```

所有 provider adapter 必须提供该字段；无法判定时使用：

```json
{
  "origin": "unknown",
  "kind": "unknown",
  "stage": "unknown",
  "transportCode": null,
  "upstreamStatus": null
}
```

### 7.4 扩展 `UpstreamAttemptSummary`

新增字段：

```ts
purpose?: UpstreamAttemptPurpose | null;
failure?: ProviderFailureClassification | null;
```

新写入必须提供 `purpose`。成功 attempt 的 `failure=null`；失败 attempt 必须尽可能保存分类，无法判定时保存 `unknown` 分类，而不是省略。

历史 JSON 中字段缺失合法；row mapper 必须把缺失字段读为 `null`，不得拒绝整条事件。

### 7.5 扩展 `RequestEventRecord`

新增请求终态和计数字段：

```ts
upstreamFailureOrigin?: ProviderFailureOrigin | null;
upstreamFailureKind?: ProviderFailureKind | null;
upstreamFailureStage?: ProviderFailureStage | null;
upstreamTransportCode?: string | null;
upstreamFailureRetryCount?: number | null;
upstreamRecoveryAttemptCount?: number | null;
upstreamUnclassifiedAdditionalAttemptCount?: number | null;
```

规则：

- 请求最终失败时，标量 failure 字段取最后一个导致请求终态失败的 attempt；
- 请求最终成功时，四个请求终态 failure 字段必须为 `null`，早期失败保留在 attempts JSON；
- Gateway 本地鉴权、限流、Plan 或输入校验失败没有 provider attempt，四个 upstream failure 字段必须为 `null`；
- `transportCode` 只能保存通过第 8.3 节验证的短错误码；
- 新事件的三个 count 字段必须写非负整数；历史事件允许 `null`。

### 7.6 扩展 `RequestUsageReportRow`

新增：

```ts
modelCallRequests: number;
upstreamAttempts: number;
failureRetries: number;
recoveryAttempts: number;
unclassifiedAdditionalAttempts: number;
attemptCountMissing: number;
attemptPurposeMissing: number;
```

`emptyRequestUsageReportRow`、merge、group-by、sort 和所有 row mapper 必须同步更新。

## 8. Provider 失败分类规则

### 8.1 分类原则

分类器必须按结构化事实优先，禁止首先匹配完整错误文本：

1. 明确的 client abort reason；
2. Gateway 自己创建的 deadline/abort reason；
3. HTTP status；
4. error/cause 链中的稳定 `code`、`name`；
5. adapter 已知的 provider error 类型；
6. 最后才使用经过严格限定的兼容文本识别；
7. 仍无法判定时使用 `unknown`。

分类器不得决定是否重试，不得调用 router、Mihomo 或 provider。

### 8.2 OpenAI-compatible 分类矩阵

| 输入事实 | origin | kind | stage | 公开错误保持 |
| --- | --- | --- | --- | --- |
| 客户端 signal reason 为 `client_aborted` | `client` | `client_aborted` | 当前阶段 | `client_aborted` |
| adapter deadline AbortError | `gateway` | `deadline_exceeded` | 当前阶段 | `upstream_timeout` |
| `ENOTFOUND`、`EAI_AGAIN` | `network` | `dns` | `before_headers` | `upstream_unavailable` |
| `ECONNREFUSED`、连接建立失败 | `network` | `connect` | `before_headers` | `upstream_unavailable` |
| `ECONNRESET`、`EPIPE`、`UND_ERR_SOCKET` | `network` | `connection_reset` | 实际阶段 | 现有映射不变 |
| TLS/certificate 稳定错误码 | `network` | `tls` | `before_headers` | `upstream_unavailable` |
| 明确的代理 CONNECT 错误 | `proxy` | `proxy_connect` | `before_headers` | `upstream_unavailable` |
| HTTP 401/403 | `provider` | `http_auth` | `after_headers` | 现有 HTTP/public code 不变 |
| HTTP 429 | `provider` | `http_rate_limit` | `after_headers` | `rate_limited` |
| HTTP 408/504 | `provider` | `http_timeout` | `after_headers` | `upstream_timeout` |
| 其他 HTTP 400–499 | `provider` | `http_request` | `after_headers` | 现有映射不变 |
| HTTP 500–599 | `provider` | `http_server` | `after_headers` | `upstream_unavailable` 或现有映射 |
| HTTP success 但无 response body | `provider` | `response_body_missing` | `after_headers` | `upstream_unavailable` |
| SSE EOF 无 `[DONE]`/finish reason | `provider` | `stream_incomplete` | `streaming` | `upstream_incomplete_stream` |
| SSE JSON/协议解析失败 | `provider` | `stream_protocol` | `streaming` | 现有公开错误不变 |
| 只有 `TypeError: fetch failed` 且 cause 无稳定 code | `network` | `unknown` | `before_headers` | `upstream_unavailable` |
| 完全无法识别 | `unknown` | `unknown` | 当前阶段或 `unknown` | 现有公开错误不变 |

HTTP 403 不得因为“可能与区域有关”而在 Phase 0 中标成代理故障。分类只能记录可确认事实。

### 8.3 error/cause 链和 `transportCode`

实现一个有界 cause walker：

- 最多遍历 6 层；
- 支持普通 `Error.cause` 和 `AggregateError.errors`；
- 使用对象 identity set 防止循环；
- 只读取 `name`、`code`、`status`、`statusCode`；
- `transportCode` 只接受 `/^[A-Z0-9_-]{1,64}$/`；
- 不把 hostname、IP、proxy URL、query string、Authorization、cookie、API key 或完整 raw message 写入 request event；
- 日志中的 `raw_message` 继续经过现有 sanitizer，最长保持现有上限。

如果多层 cause 有多个 code，选择距离根异常最近、且在已知分类表中的第一个 code。无法识别的合法 code 可以作为 `transportCode` 保存，但 `kind` 仍为 `unknown`。

### 8.4 阶段追踪

`OpenAICompatibleProviderAdapter.message` 必须显式维护当前阶段：

```text
初始                    -> before_headers
fetch 返回 Response     -> after_headers
开始读取 response.body  -> streaming
```

catch 和显式错误分支必须使用当前阶段。不得仅凭公开 error code 倒推阶段。

### 8.5 Codex adapter 最低分类

`packages/provider-codex` 必须至少实现：

| 已知事实 | classification |
| --- | --- |
| client abort | `client/client_aborted` |
| Gateway deadline | `gateway/deadline_exceeded` |
| 登录/401/reauth | `provider/provider_reauth` |
| 429/rate limit | `provider/http_rate_limit` |
| context overflow | `provider/http_request` |
| SDK/network cause 有稳定 code | 按共用 cause classifier 分类 |
| 其他 Codex SDK/item error | `provider/unknown` |

Codex 当前兼容文本识别可以保留，但必须位于结构化 code/status 判定之后。

## 9. 上游尝试目的和计数规则

### 9.1 `purpose` 映射

保留现有 `kind` 详细值，同时新增稳定的 `purpose`：

| 现有/新增 attempt kind | purpose |
| --- | --- |
| `primary` | `primary` |
| `native`、`native_initial` | `primary` |
| `stateless_retry` | `failure_retry` |
| `auto_ack_to_required` | `contract_recovery` |
| `auto_ack_to_auto` | `contract_recovery` |
| `auto_ack_after_tool_to_auto` | `contract_recovery` |
| `auto_empty_to_auto` | `contract_recovery` |
| `validation_failed_to_same` | `contract_recovery` |
| `validation_failed_to_auto` | `contract_recovery` |
| 未来 xAI 出口切换 attempt kind | 必须显式写 `failure_retry` |
| 未知 kind | `unknown` |

不得使用 `attempt.index > 1` 自动判定为故障重试。

### 9.2 新请求写入规则

对本次版本之后的新请求：

- 即使没有 provider 调用，`upstream_attempt_count` 也必须写 `0`，不得写 `null`；
- 每个 provider summary 中的 attempt 必须有 `purpose`；
- request-level count 由 attempts 统一计算，不允许各调用路径独立手写不同算法；
- 新增纯函数 `summarizeUpstreamAttemptPurposes(attempts)`，由 observation、报表测试和 admin summary 复用；
- `failure_retry_count` 只统计 `purpose=failure_retry`；
- `recovery_attempt_count` 只统计 `purpose=contract_recovery`；
- index 大于 1 且 `purpose=unknown` 的 attempt 计入 `unclassified_additional_attempt_count`；
- `purpose=primary` 超过 1 个时必须记录 warning，并把第二个及以后计入 unclassified，不得静默修正。

### 9.3 历史请求兼容

历史数据允许缺少 `purpose` 和新增标量 count。读取时按以下顺序：

1. 有 `purpose`：直接使用；
2. 无 `purpose`、但 `kind` 在第 9.1 节冻结映射中：确定性映射；
3. 第一个 attempt 且 `kind` 缺失：按 `primary` 读取；
4. 其他情况：`unknown`。

这不是根据错误文本猜测。不得把同一个 `client_message_id` 下第二个 request event 自动标成 client retry。

## 10. Token 统计合同

### 10.1 请求级计算

每个 request event 的展示对象必须包含：

```ts
interface AdminTokenBreakdown {
  provider_usage_present: boolean;
  provider_prompt_tokens: number;
  provider_completion_tokens: number;
  provider_total_tokens: number;
  estimated_tokens: number;
  attributable_tokens: number;
  cached_prompt_tokens: number;
  reasoning_tokens: number;
  gateway_estimated_prompt_tokens: number | null;
  usage_source: RequestTokenUsageSource | null;
  usage_missing: boolean;
}
```

计算规则：

```text
provider_usage_present = total_tokens 非 NULL，或 prompt/completion 任一字段非 NULL
provider_total_tokens = provider_usage_present 时采用有效 total_tokens，
                        否则在 prompt/completion 字段存在时采用两者之和
estimated_tokens = 只有 provider_usage_present=false 时才采用 request_events.estimated_tokens
attributable_tokens = provider_total_tokens + estimated_tokens
usage_missing = provider_usage_present == false
                && estimated_tokens == 0
                && usage_source != "none"
```

provider 明确返回 0 Token 时，`provider_usage_present=true`，不得标记为缺失。`usage_source=none` 的身份保护等零用量请求也不是“缺失用量”。

### 10.2 聚合规则

- Provider prompt/completion/total 分别求和；
- estimated 单独求和；
- attributable 只在展示层计算，不写回 ledger；
- `sort_by=tokens` 为兼容现有行为，继续按 attributable tokens 排序；
- 新增 `sort_by=provider_tokens` 和 `sort_by=estimated_tokens`；
- 页面必须在“按 Token 排序”旁说明默认口径包含估算；
- 不得把 `gateway_estimated_prompt_tokens` 纳入任何总量或排序；
- token reservation 继续是权威账务来源，request event 是消息关联和诊断来源；两套来源不得相加生成“双倍 Token”。

## 11. SQLite migration 规格

### 11.1 migration 编号

当前主 schema 在实现基线已使用到 migration `25`。本功能必须使用下一个可用编号；按当前工作区应为 `26`。如果实现时已有其他 migration 占用 `26`，必须顺延并同步更新本文实现记录，不得复用编号。

### 11.2 新增列

对 `request_events` additive 增加：

```sql
upstream_failure_origin TEXT NULL
upstream_failure_kind TEXT NULL
upstream_failure_stage TEXT NULL
upstream_transport_code TEXT NULL
upstream_failure_retry_count INTEGER NULL
upstream_recovery_attempt_count INTEGER NULL
upstream_unclassified_additional_attempt_count INTEGER NULL
```

增加索引：

```sql
CREATE INDEX IF NOT EXISTS idx_request_events_failure_started
  ON request_events(upstream_failure_origin, upstream_failure_kind, started_at DESC)
  WHERE upstream_failure_origin IS NOT NULL;
```

迁移必须沿用 `columnExists` 守卫和 `applyMigration` 模式。不得在启动迁移中批量重写全部历史 `upstream_attempts_json`。

### 11.3 需要同步修改的存储代码

- `packages/store-sqlite/src/migrations.ts`
- `packages/store-sqlite/src/columns.ts`
- `packages/store-sqlite/src/request-events.ts`
- `packages/store-sqlite/src/row-mappers.ts`
- `packages/store-sqlite/src/request-usage-report.ts`
- `packages/store-sqlite/src/index.test.ts`
- `packages/core/src/types.ts`
- `packages/core/src/stores.ts`

insert、upsert、select、row mapper 和测试 fixture 必须同步更新；占位符数量必须由测试覆盖。

### 11.4 历史数据

- 新列对历史行保持 `NULL`；
- 历史 `upstream_attempts_json` 不重写；
- admin message 逐条展示可以使用第 9.3 节的确定性映射；
- usage report 对新增标量为 `NULL` 的历史行，允许从 attempts JSON 做确定性 fallback；
- fallback 仍无法分类时增加 `attemptPurposeMissing`，不得填成 0 后假装完整；
- Azure 兼容合并进入 R760 的旧事件允许新增字段为 `NULL`；同步脚本不得因源端缺少新列而失败。

### 11.5 报表 SQL

`reportUsage` 的 request 聚合必须增加：

- `model_call_requests`：`upstream_attempt_count > 0` 的请求数；
- `upstream_attempts`：已知 attempt count 之和；
- `failure_retries`；
- `recovery_attempts`；
- `unclassified_additional_attempts`；
- `attempt_count_missing`；
- `attempt_purpose_missing`。

JSON fallback 只能在已按时间和 subject/credential 过滤后的行上执行。必须增加 50,000 条 request event 的报表性能测试；目标是本地测试数据库中 48 小时默认查询小于 500 ms。超过目标时，不得通过取消准确性解决；应增加标量 backfill 工具或进一步索引，并更新本规格。

## 12. Gateway 写入链路

### 12.1 OpenAI-compatible adapter

修改 `apps/gateway/src/services/openai-compatible-provider.ts`：

1. 在 message 生命周期维护 failure stage；
2. `normalize` 返回带 `providerFailure` 的 `GatewayError`；
3. 每个 error `StreamEvent` 携带相同 classification；
4. `createProviderErrorDiagnostic` 携带 classification 和安全 raw code；
5. HTTP error、无 body、SSE error frame、incomplete EOF、JSON parse/reader exception 都必须分类；
6. 保持现有 public code/message/status/retry-after 不变；
7. 不新增 fetch 重试。

### 12.2 Codex adapter

修改 `packages/provider-codex/src/codex-adapter.ts`：

- 在 exception 和 `item.error` 路径附加 classification；
- 结构化 status/code 优先于文本兼容分类；
- 保持现有 reauth、rate limit、context length 和 service unavailable 的公开行为；
- 不改变 SDK 调用或账号 router 行为。

### 12.3 Provider stream

修改 `apps/gateway/src/services/provider-stream.ts`：

- `ProviderStreamSummaryCollector` 保存 error event 的 classification；
- `ProviderStreamAttemptContext` 新增 `purpose`；
- `providerSummaryToAttempt` 输出 `purpose` 和 `failure`；
- `combineProviderStreamSummaries` 重新编号时保留上述字段；
- `streamErrorToGatewayError` 复制 classification；
- `attachProviderStreamSummary` 不丢失 classification；
- provider completion 产生的 `stream_incomplete` 等协议错误也必须有 classification。

### 12.4 Attempt purpose 调用点

修改 `apps/gateway/src/index.ts`：

- 普通首尝试：`purpose=primary`；
- `stateless_retry`：`purpose=failure_retry`；
- `collectNativeClientTools` 首次：`purpose=primary`；
- native validation/ack/empty retry plan：`purpose=contract_recovery`；
- strict tools 对应调用按相同原则标记；
- 不修改任何触发条件、最大尝试数或 prompt transformation。

### 12.5 Observation

修改 `apps/gateway/src/http/context.ts` 和 `apps/gateway/src/http/observation.ts`：

- 新请求没有 provider 调用时写 `upstreamAttemptCount=0` 和三个计数 `0`；
- 有 provider summary 时由统一 helper 计算计数；
- 终态失败分类写入新增标量列；
- 成功请求的终态分类列写 `NULL`，但 attempts 保留早期失败；
- `createProviderErrorLogger` 增加结构化日志字段，不修改 sanitized raw message；
- 日志必须包含 `request_id`、provider、failure origin/kind/stage、transport code、upstream status；
- 日志不得包含 key、Authorization、完整图片 URL 或请求正文。

## 13. Admin JSON 合同

`GET /gateway/admin/client-messages.json` 保留所有现有字段，并 additive 增加以下字段。

### 13.1 消息级 `request_summary`

```json
{
  "gateway_request_count": 1,
  "model_call_request_count": 1,
  "upstream_attempt_count": 2,
  "failure_retry_count": 1,
  "recovery_attempt_count": 0,
  "unclassified_additional_attempt_count": 0,
  "attempt_count_missing": 0,
  "attempt_purpose_missing": 0,
  "token_usage": {
    "provider_usage_present": true,
    "provider_prompt_tokens": 95000,
    "provider_completion_tokens": 600,
    "provider_total_tokens": 95600,
    "estimated_tokens": 0,
    "attributable_tokens": 95600,
    "usage_missing_count": 0
  }
}
```

现有 `request_count`、`prompt_tokens`、`completion_tokens`、`total_tokens`、`estimated_tokens` 和 `effective_tokens` 暂时保留一个兼容周期：

- `request_count == gateway_request_count`；
- `total_tokens == provider_total_tokens`；
- `effective_tokens == attributable_tokens`；
- 新页面必须只读取新命名字段；
- 本阶段不删除旧字段。

### 13.2 逐 Gateway 请求明细

每个 message 增加 `gateway_requests`，按 `started_at` 升序：

```json
[
  {
    "request_id": "req-...",
    "started_at": "2026-08-21T06:52:43.000Z",
    "status": "error",
    "error_code": "upstream_unavailable",
    "duration_ms": 2400,
    "first_byte_ms": 2400,
    "provider": "xai",
    "upstream_runtime": "xai",
    "upstream_model": "grok-4.5",
    "upstream_attempt_count": 1,
    "failure_retry_count": 0,
    "recovery_attempt_count": 0,
    "terminal_failure": {
      "origin": "network",
      "kind": "connect",
      "stage": "before_headers",
      "transport_code": "UND_ERR_CONNECT_TIMEOUT",
      "upstream_status": null
    },
    "token_usage": {
      "provider_usage_present": false,
      "provider_prompt_tokens": 0,
      "provider_completion_tokens": 0,
      "provider_total_tokens": 0,
      "estimated_tokens": 95854,
      "attributable_tokens": 95854,
      "gateway_estimated_prompt_tokens": 95854,
      "usage_source": "estimate",
      "usage_missing": false
    },
    "upstream_attempts": [
      {
        "index": 1,
        "purpose": "primary",
        "kind": "primary",
        "duration_ms": 223,
        "error_code": "upstream_unavailable",
        "failure": {
          "origin": "network",
          "kind": "connect",
          "stage": "before_headers",
          "transport_code": "UND_ERR_CONNECT_TIMEOUT",
          "upstream_status": null
        }
      }
    ]
  }
]
```

`upstream_attempts` 中允许展示：index、purpose、kind、provider、runtime、model、耗时、HTTP status、上游 request ID、公开 error code、failure classification 和 attempt token。不得返回 raw provider message、请求正文、Authorization、API key、proxy credential 或完整签名 URL。

每条消息最多返回 100 个 Gateway request 明细；超过时：

- summary 仍按全部已关联事件计算；
- `gateway_requests` 只返回最新 100 个并保持升序；
- 增加 `gateway_requests_truncated=true` 和总数；
- 不得静默截断。

### 13.3 用户级和全局汇总

`users[]` 和顶层 `summary` 增加：

- `gateway_request_count`
- `model_call_request_count`
- `upstream_attempt_count`
- `failure_retry_count`
- `recovery_attempt_count`
- `unclassified_additional_attempt_count`
- `attempt_count_missing`
- `attempt_purpose_missing`
- `provider_total_tokens`
- `estimated_tokens`
- `attributable_tokens`

新增排序：

- `sort_by=upstream_attempts`
- `sort_by=retries`
- `sort_by=recoveries`
- `sort_by=provider_tokens`
- `sort_by=estimated_tokens`

保留：

- `sort_by=requests`
- `sort_by=tokens`，继续按 attributable tokens；
- `sort_by=errors`
- `sort_by=rate_limited`
- `sort_by=avg_duration`
- `sort_by=name`

## 14. 管理页面展示规格

### 14.1 消息卡片

每条消息必须显示：

1. 状态：成功、部分成功、失败或无请求记录；
2. `模型调用`：真正开始 provider 调用的 Gateway 请求数；详情显示“Gateway 请求 N，成功 A / 失败 B”；
3. `上游尝试`：attempt 总数；详情显示“故障重试 R / 合同恢复 C”；
4. `端到端耗时`：消息关联请求从最早开始到最晚结束；多请求时显示调用耗时合计；
5. `Provider Token`：准确总量；详情显示输入/输出；
6. `估算 Token`：最终 fallback 估算量；详情显示数据来源或“未使用估算”；
7. `限流`：Gateway/上游限流次数；
8. 错误摘要：公开 error code 及内部 failure origin/kind/stage；
9. 可展开的 Gateway request ID 和 attempt 明细。

不得继续把 `provider_total_tokens + estimated_tokens` 作为一个无说明的“Token”值。用户列表为了排序可以显示“可归因 Token”，但必须同时显示准确/估算拆分。

### 14.2 旧数据和不确定性

- `upstream_attempt_count=null`：显示“上游尝试未知”，不得显示 0；
- attempt purpose 无法识别：显示“未分类附加尝试 N”；
- beta.38 多个 Gateway request：显示多个 request ID，但“客户端自动重试”显示“无法确认”或不显示；
- `usage_missing_count>0`：显示“有 N 个请求缺少 Token usage”；
- 历史 failure classification 缺失：显示“旧记录未分类”。

### 14.3 示例

沈杰失败消息应显示：

```text
Gateway 请求 2
模型调用 2
上游尝试 2
Gateway 故障重试 0
合同恢复 0
客户端自动重试 无法确认
Provider Token 0
估算 Token 191,708
```

沈杰成功工具循环消息应显示：

```text
Gateway 请求 3
模型调用 3
上游尝试 3
Gateway 故障重试 0
合同恢复 0
Provider Token 231,911
估算 Token 0
```

未来一次 Gateway 内部出口故障转移应显示：

```text
Gateway 请求 1
模型调用 1
上游尝试 2
Gateway 故障重试 1
合同恢复 0
Gateway request ID 只有 1 个
```

## 15. Admin CLI 规格

### 15.1 `events`

逐请求输出 additive 增加：

```json
{
  "upstream_failure_origin": "network",
  "upstream_failure_kind": "connect",
  "upstream_failure_stage": "before_headers",
  "upstream_transport_code": "UND_ERR_CONNECT_TIMEOUT",
  "upstream_attempt_count": 2,
  "upstream_failure_retry_count": 1,
  "upstream_recovery_attempt_count": 0,
  "upstream_unclassified_additional_attempt_count": 0,
  "upstream_attempts": []
}
```

### 15.2 `report-usage`

每个汇总 row additive 增加第 7.6 节字段。现有参数和输出字段不得删除。

建议新增内部过滤参数：

```text
--failure-origin <value>
--failure-kind <value>
```

如果本阶段不增加过滤参数，至少必须保证 `events` 能输出并由 request ID 查询分类；过滤不是 Phase 0 上线阻塞项。

## 16. 文件级实施清单

### 16.1 Core

- 新建 `packages/core/src/provider-failure.ts`；
- 修改 `packages/core/src/index.ts` 导出类型和 classifier helper；
- 修改 `packages/core/src/errors.ts`，增加内部 `providerFailure`；
- 修改 `packages/core/src/types.ts`，扩展 stream、diagnostic、attempt 和 request event；
- 修改 `packages/core/src/stores.ts`，扩展 usage report row；
- 添加 provider failure classifier 单元测试。

### 16.2 Provider adapters

- 修改 `apps/gateway/src/services/openai-compatible-provider.ts`；
- 修改 `apps/gateway/src/services/openai-compatible-provider.test.ts`；
- 修改 `packages/provider-codex/src/codex-adapter.ts`；
- 修改 `packages/provider-codex/src/codex-adapter.test.ts`。

### 16.3 Stream 和 Gateway 请求链路

- 修改 `apps/gateway/src/services/provider-stream.ts`；
- 修改 `apps/gateway/src/services/provider-stream.test.ts`；
- 修改 `apps/gateway/src/index.ts`；
- 修改 `apps/gateway/src/http/context.ts`；
- 修改 `apps/gateway/src/http/observation.ts`；
- 修改对应 Gateway/observation 测试。

### 16.4 SQLite 和报表

- 修改第 11.3 节列出的 store 文件；
- 修改 Admin CLI serializer/command 输出；
- 增加 migration、round-trip、legacy、aggregation 和 sync compatibility 测试。

### 16.5 Admin client messages

- 修改 `apps/gateway/src/admin-client-messages.ts` 的数据模型、聚合、排序、JSON shaping 和 HTML；
- 修改 `apps/gateway/src/index.test.ts` 的管理页与 JSON 测试；
- 保留现有 admin auth、`Cache-Control: no-store`、CSP 和正文访问控制。

## 17. 实施顺序

必须按以下顺序实施，保持每一步可编译：

1. 增加 core 类型、分类器和单元测试；
2. 扩展 `GatewayError`、`StreamEvent` 和两个 provider adapter；
3. 扩展 provider stream summary、attempt purpose 和错误传递；
4. 为所有 provider 调用点赋予明确 `purpose`；
5. 增加 migration 和 store round-trip；
6. 扩展 observation 和 request usage aggregation；
7. 扩展 Admin CLI；
8. 扩展 client-messages JSON；
9. 改造管理 HTML；
10. 完成全量测试、性能测试和发布文档。

实现期间不得覆盖当前工作区中并行的 Phone Auth、client-messages 标签或其他用户修改。修改重叠文件前必须先检查 `git diff`，按语义合并。

## 18. 测试矩阵

### 18.1 分类器单元测试

必须覆盖：

1. `fetch failed` + `ENOTFOUND`；
2. `fetch failed` + `EAI_AGAIN`；
3. `ECONNREFUSED`；
4. `ECONNRESET`；
5. `EPIPE`；
6. 一个 TLS/certificate code；
7. 明确 proxy CONNECT error；
8. Gateway deadline before headers；
9. client abort；
10. HTTP 400、401、403、408、429、500、503、504；
11. success response 无 body；
12. SSE malformed JSON；
13. SSE EOF before terminal；
14. stream 已有 delta 后 reader error；
15. `AggregateError`；
16. cause 循环和超过 6 层；
17. 不合法/超长 transport code；
18. unknown fallback；
19. raw secret、Bearer、签名 URL 继续被脱敏。

每个用例必须同时断言：

- public error code/status 未变化；
- internal classification 正确；
- public response 不含 internal classification；
- request log 不泄露 secret。

### 18.2 Attempt purpose 测试

必须覆盖：

- 单次 primary；
- stateless retry；
- native initial；
- 所有 native retry plan kind；
- validation recovery；
- unknown legacy kind；
- 成功前一次失败重试；
- 两个 primary 的异常数据产生 unclassified/warning；
- combine summaries 后 index 重排不丢 purpose/failure。

### 18.3 SQLite 测试

必须覆盖：

- migration 25 -> 下一版本；
- migration 重复执行；
- 老库只有 `request_events(request_id)` 的兼容测试；
- 新字段 insert/read/upsert round-trip；
- attempts JSON 新字段 round-trip；
- 历史 JSON 缺少新字段；
- 损坏 JSON 继续降级为空，不阻断 event 查询；
- user/date/model group-by 的新增计数 merge；
- Azure 旧事件字段为 null 时仍能合并；
- 50,000 行、48 小时报表性能目标。

### 18.4 Gateway 路由测试

必须至少断言：

| 场景 | Gateway 请求 | 模型调用请求 | attempts | failure retry | recovery |
| --- | ---: | ---: | ---: | ---: | ---: |
| Gateway 本地 429 | 1 | 0 | 0 | 0 | 0 |
| primary success | 1 | 1 | 1 | 0 | 0 |
| xAI fetch transport failure | 1 | 1 | 1 | 0 | 0 |
| 现有 pool stateless retry success | 1 | 1 | 2 | 1 | 0 |
| native validation recovery | 1 | 1 | 2 | 0 | 1 |
| 三次正常 client tool loop | 3 | 3 | 3 | 0 | 0 |

还必须断言：

- streaming 和 non-streaming 都保存分类；
- stream 已输出后失败仍只记录事实，不新增重试；
- request ID 不因内部 attempt 增加而变化；
- RPM 只按现有 Gateway 请求行为执行；
- token reservation 结果与改造前相同。

### 18.5 Admin 页面测试

必须覆盖：

- 页面 JavaScript 可解析；
- 新旧 JSON 字段共存；
- request ID 和 attempt 明细展示；
- Provider Token 与估算 Token 分列；
- `tokens`、`provider_tokens`、`estimated_tokens`、`retries`、`recoveries` 排序；
- 历史 null 显示未知而不是 0；
- 100 个 request 明细截断标志；
- HTML escaping；
- admin token 仍是唯一授权边界；
- 页面和 JSON 继续 `no-store`；
- 普通用户 credential 无法读取 admin 数据。

## 19. 本地验证命令

实现完成后至少执行：

```powershell
npm run typecheck
npm test -- --run apps/gateway/src/services/openai-compatible-provider.test.ts
npm test -- --run apps/gateway/src/services/provider-stream.test.ts
npm test -- --run packages/provider-codex/src/codex-adapter.test.ts
npm test -- --run packages/store-sqlite/src/index.test.ts
npm test -- --run apps/gateway/src/index.test.ts
npm test -- --run apps/admin-cli/src/index.test.ts
npm test
npm run build
```

如果 Vitest 参数形式在实现时发生变化，应使用仓库当时等价的 targeted 命令，但全量 `npm test` 和 `npm run build` 仍为强制门禁。

## 20. 部署顺序和生产验证

### 20.1 上线前

1. 确认当前分支和最终 commit；
2. 确认 `git status` 中没有被覆盖的用户改动；
3. 完成全量 build/test；
4. 对 R760 SQLite 做受控备份；
5. 记录迁移前 schema version、Gateway release 和 `/gateway/health`；
6. 不修改 Nginx、Mihomo、Research Worker、端口和 proxy env；
7. 不把 Azure 当作同一请求的 retry target。

### 20.2 R760 发布

只部署 Gateway release，并让 additive migration 在受控启动中执行。发布后验证：

- Gateway container healthy；
- 仍只发布 `127.0.0.1:18787->8787`；
- public `/gateway/health` 正常；
- `/v1/models` 保持预期模型；
- `goldencode` streaming/non-streaming smoke 正常；
- 一个受控的小图片 vision smoke 正常；
- 新 request event 的 attempt count 为非 null；
- 成功事件的终态 failure 字段为 null；
- admin 页面能展示 request ID、attempt 和 Token 拆分；
- 现有 beta.38 key 和 Phone Auth 并行功能均未受影响。

不得为了生成分类证据而在生产主动破坏代理出口。失败分类的强制错误场景必须在本地 fake provider 或隔离测试环境完成。

### 20.3 观测期

上线后至少检查：

- `unknown` failure kind 比例；
- attempt count/purpose missing 比例；
- request count 与迁移前同口径趋势；
- provider/estimated Token 与 token ledger 的差异；
- admin 默认 48 小时查询耗时；
- Gateway error rate、延迟和 SQLite 写入错误。

Phase 0 不设置基于分类的自动动作；即使发现大量 network failure，也只能按现有 runbook 人工处置。

## 21. 回滚

### 21.1 应用回滚

- 可以回滚到上一 Gateway binary/release；
- additive SQLite 列和索引保留，不执行 schema downgrade；
- 旧 binary 会忽略新增列；
- 新 attempts JSON 的 additive 字段必须能被旧 parser 忽略；
- 不删除 request events，不回写 token ledger。

### 21.2 回滚触发条件

出现以下任一情况应回滚应用：

- public error code、HTTP status 或 response body 非预期变化；
- RPM、RPD、并发或 token quota 行为变化；
- token reservation/usage 与发布前同输入不一致；
- request event 写入失败或 SQLite lock 显著增加；
- admin 查询造成 Gateway 明显延迟或内存增长；
- beta.38、Phone Auth 或 Research 既有路径回归。

管理页展示错误但数据面正常时，可以先关闭/回滚管理页改动；不得因此删除已采集的新增诊断字段。

## 22. Definition of Done

只有同时满足以下条件，Phase 0 才能标记完成：

- [ ] Core 失败事实和 attempt purpose 类型已实现并导出；
- [ ] OpenAI-compatible 与 Codex adapter 都写结构化 classification；
- [ ] 公开错误合同无变化；
- [ ] 每个新 request event 的 attempt count 为明确的 0 或正整数；
- [ ] 故障重试和合同恢复分开计数；
- [ ] request/attempt classification 持久化和 round-trip 通过；
- [ ] 准确 Token、估算 Token、预检估算和 missing usage 分开；
- [ ] Admin CLI、admin JSON 和 HTML 均使用相同统计 helper/口径；
- [ ] beta.38 客户端重试未被猜测；
- [ ] SQLite migration additive、可重复、可由旧应用忽略；
- [ ] targeted tests、全量 tests、typecheck 和 build 全部通过；
- [ ] R760 smoke 和 admin 页面验收通过；
- [ ] system status/current state 已更新为实际 deployed commit；
- [ ] 没有代理切换、自动重试、限流或计费行为变化。

## 23. 后续 Phase 1 接口边界

未来实现 xAI 多出口故障转移时，只允许读取本阶段的事实字段：

- failure origin/kind/stage；
- 是否已经产生客户端可见输出；
- attempt purpose/count；
- 剩余 request deadline；
- 当前和候选 egress identity。

Phase 1 必须单独定义重试 eligibility、不同出口证明、并发选择、健康检查和计费风险。不得在 Phase 0 中预埋“看到 `upstream_unavailable` 就自动重试”的行为。

## 24. 实现交付物

开发 agent 最终必须交付：

1. 代码和 migration；
2. 新增/更新测试；
3. 一份实现结果记录，列出实际 migration 版本、字段、测试结果和未完成项；
4. R760 发布候选 commit；
5. 经授权部署后更新 `docs/operations/system-status.md` 和 `references/current-state.md`；
6. 不包含任何用户完整消息、手机号、API key、admin token、proxy credential 或签名 URL。
