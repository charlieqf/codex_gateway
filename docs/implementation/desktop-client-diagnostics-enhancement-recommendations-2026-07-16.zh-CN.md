# Desktop 客户端诊断与工具循环增强建议

- 日期：2026-07-16
- 适用范围：MedEvidence Desktop 使用 Codex Gateway 的聊天、Agent 和客户端工具执行路径
- Gateway 基线：`e1a704c`（Gateway request diagnostics）

## 1. 结论

建议 Desktop 客户端分阶段补齐以下能力：

1. 为每个用户 turn 生成稳定的 `client_turn_id` 和便于人工沟通的 `turn_code`，并在该 turn 的所有 Gateway 请求中持续传递；
2. 记录模型请求、工具执行、重试、用户取消和 turn 结束的结构化诊断事件；
3. 在客户端维护完整的本地 turn 状态，先以 shadow 模式统计循环次数、耗时、Prompt 增长和重复失败；
4. shadow 数据验证后，再逐步启用用户可见告警、重复失败熔断、turn 上限和一次性 finalizer；
5. 在错误界面提供不含敏感信息的 `turn_code` 和 Gateway `request_id`，便于用户反馈和服务端关联查询。

这些增强不是当前 Gateway 的强制适配要求。现有客户端不增加任何 Header 或诊断上报，聊天请求仍然保持兼容。增强版客户端也不需要解析新的 Gateway 响应字段，因为本次 Gateway 改动没有改变公开请求、响应、错误或 SSE 契约。

## 2. 当前 Gateway 已提供的诊断能力

Gateway 现在会在内部 `request_events` 中记录：

- Gateway Prompt 估算值及估算方法；
- 模型 context window 和最大输出 token；
- 当前请求携带的工具数量及工具模式；
- public model、实际 runtime、上游账号、上游模型及请求尝试；
- provider token usage、耗时、首字节耗时、finish reason 和错误分类；
- 基于同一客户端 turn 的工具循环 shadow 评估。

当前工具循环策略仅为观测模式：

- Warning 候选：连续工具调用达到 8 次；
- Hard 候选：连续工具调用达到 12 次；
- turn elapsed 候选上限：10 分钟；
- Prompt Warning/Hard 候选：100k/120k tokens；
- shadow 只记录 `allow`、`shadow_warn` 或 `shadow_finalize` 候选决策，不中断、不拒绝、不改写客户端请求。

Gateway 能观察 HTTP 请求和上游响应，但无法完整观察以下客户端本地状态：

- 用户何时开始、停止、重试或重新生成一个 turn；
- 工具在本地是否真正启动、成功、失败、超时或被取消；
- 工具失败后客户端为什么继续重试；
- 本地文件、sidecar、renderer 或网络状态；
- UI 是否已经显示终态，但后台循环仍在继续；
- 客户端准备下一轮请求前的完整上下文裁剪和 Prompt 增长过程。

因此，Gateway 诊断和 Desktop 诊断应当互补，不能由其中一侧替代另一侧。

## 3. 兼容性原则

| 能力 | 现有客户端 | 增强客户端 |
| --- | --- | --- |
| 正常调用 `/v1/chat/completions` | 保持可用 | 保持可用 |
| Gateway 单请求诊断 | 可用 | 可用 |
| 跨请求 turn 聚合 | 无稳定 turn id 时无法可靠评估 | 可完整评估 |
| GoldenCode 会话 sticky | 回退到 credential/subject | 优先使用稳定 client session |
| 客户端工具执行诊断 | 不完整 | 可与 Gateway 请求合并成时间线 |
| 用户反馈定位 | 依赖时间和用户信息猜测 | 可通过 turn code/request id 精确定位 |

实现时应遵循：

- 所有新 Header 均为可选，不能成为发送模型请求的前置条件；
- 诊断上传必须 best effort，上传失败不能让聊天或工具执行失败；
- 客户端不能依赖 Gateway 内部 SQLite 字段作为运行时协议；
- Gateway 返回的公开 HTTP/SSE 契约保持现状；
- 客户端保护逻辑应使用独立 feature flag 分阶段启用；
- 不通过 IP、Prompt、时间邻近或用户文本猜测 turn 身份。

## 4. P0：稳定传递 turn 关联信息

### 4.1 推荐 Header

增强客户端应在每个受保护的 Gateway 模型请求中发送：

| Header | 最大长度 | 生命周期 | 用途 |
| --- | ---: | --- | --- |
| `x-medcode-client-turn-id` | 128 | 一个用户 turn 内固定 | 聚合同一 turn 的多次模型调用 |
| `x-medcode-client-turn-code` | 64 | 一个用户 turn 内固定 | 用户反馈和人工检索，例如 `T:7K3P2` |
| `x-medcode-client-session-id` | 128 | 一个对话 session 内固定 | 会话关联及 GoldenCode sticky |
| `x-medcode-client-message-id` | 128 | 指向发起该 turn 的用户消息 | 关联客户端消息与诊断事件 |
| `x-medcode-client-app-version` | 64 | 当前安装版本 | 识别版本回归和灰度范围 |

建议 ID 使用不含用户信息的 UUID、ULID 或等价随机标识。`turn_code` 可以使用较短的随机 Base32/Base36 编码，但必须保证在客户端合理时间窗口内低碰撞。

Header 不得包含姓名、手机号、邮箱、文件路径、Prompt、API key、access token 或其他凭据。Gateway 会存储这些关联字段，超长、空白或缺失值会被忽略，但不会拒绝原请求。

### 4.2 turn 生命周期

建议采用以下规则：

- 用户提交一条新消息时，创建新的 `client_turn_id`、`turn_code` 和本地 turn state；
- 模型返回 `tool_calls` 后，工具结果回传模型的后续请求继续使用同一 `client_turn_id`；
- 客户端自动网络重试、provider 重试或同一执行链中的修复请求继续使用同一 `client_turn_id`；
- 同一 turn 内的所有请求继续指向最初的 `client_message_id`；
- 用户主动点击“重新生成”或“重试整个任务”时创建新 turn，不与原失败 turn 混合；
- 两个并发运行的用户任务必须使用不同 turn id；
- 用户 Stop 后不得再为原 turn 启动新的工具或模型请求；若用户明确恢复执行，建议创建新 turn 并在本地记录来源 turn，而不是复用已结束的 turn。

伪代码：

```ts
type ClientTurnContext = {
  turnId: string;
  turnCode: string;
  sessionId: string;
  messageId: string;
  startedAt: string;
  startedMonoMs: number;
};

function gatewayHeaders(turn: ClientTurnContext, appVersion: string) {
  return {
    "x-medcode-client-turn-id": turn.turnId,
    "x-medcode-client-turn-code": turn.turnCode,
    "x-medcode-client-session-id": turn.sessionId,
    "x-medcode-client-message-id": turn.messageId,
    "x-medcode-client-app-version": appVersion
  };
}
```

所有自动重试路径必须复用同一个 `ClientTurnContext`，不要在 HTTP helper 内部为每次请求重新生成 turn id。

## 5. P0：补齐客户端诊断事件

### 5.1 使用现有接口

客户端可使用现有接口：

```text
POST /gateway/client-events/diagnostics
schema = client_diagnostic.v1
```

接口使用当前 Gateway credential 鉴权。相同用户下，同一个 `event_id` 使用完全相同内容重传会返回 duplicate success；相同 `event_id` 携带不同内容会返回 `409 idempotency_conflict`。

因此每个状态转换应生成独立、稳定的 `event_id`，不要尝试用同一个事件覆盖 `started -> ok/error`。

### 5.2 最小事件集合

建议至少记录以下事件：

| category | action | status | 触发时机 |
| --- | --- | --- | --- |
| `agent_turn` | `turn` | `started` | 用户 turn 开始 |
| `provider_stream` | `request` | `started` | 准备发送一次模型请求 |
| `provider_stream` | `request` | `ok/error/timeout/aborted` | 模型请求结束 |
| `tool` | `execution` | `started` | 本地工具开始执行 |
| `tool` | `execution` | `ok/error/timeout/aborted` | 本地工具结束 |
| `user_action` | `stop` | `aborted` | 用户点击 Stop |
| `agent_turn` | `guard` | `queued` | 本地 shadow 命中 warning/hard 候选 |
| `agent_turn` | `turn` | `ok/error/timeout/aborted` | turn 到达唯一终态 |

事件中的 `created_at` 使用 UTC ISO 时间；耗时判断使用 monotonic clock，并将相对值放在 `mono_ms`、`duration_ms` 或 metadata 的数值字段中，避免系统时间调整导致负耗时。

### 5.3 推荐 metadata

在不包含正文的前提下，建议按事件类型携带以下字段：

- 关联：`client_turn_id`、`turn_code`、`gateway_request_id`；
- 循环：`loop_index`、`model_request_count`、`consecutive_tool_calls`；
- 请求形态：`active_tool_count`、`client_tool_mode`、`requested_tool_choice`；
- 结果：`finish_reason`、`tool_call_count`、`retry_index`；
- 工具：`tool_name`、`tool_result_chars`、`tool_error_code`；
- 本地 guard：`guard_mode`、`guard_decision`、`warning_reasons`、`hard_reasons`；
- 上下文：`request_shape.estimated_prompt_tokens`、`request_shape.tools_schema_bytes`；
- 取消：`abort_source`，例如 `user`、`app_shutdown`、`deadline` 或 `superseded`。

当 Gateway 返回响应 Header `x-request-id` 时，客户端应立即保存，并在该请求的完成事件中写入 `metadata.gateway_request_id`。即使 SSE 后续中断，也应保留已经收到的 request id。若连接建立前就失败，可以只记录本地 attempt id，不要伪造 Gateway request id。

示例：

```json
{
  "schema": "client_diagnostic.v1",
  "event_id": "diag_01K0TURN_REQUEST_DONE",
  "session_id": "ses_01K0SESSION",
  "message_id": "msg_01K0MESSAGE",
  "created_at": "2026-07-16T09:30:02.125Z",
  "app": {
    "name": "medevidence-desktop",
    "version": "2.1.0"
  },
  "category": "provider_stream",
  "action": "request",
  "status": "ok",
  "duration_ms": 1840,
  "http_status": 200,
  "metadata": {
    "client_turn_id": "turn_01K0TURN",
    "turn_code": "T:7K3P2",
    "gateway_request_id": "req-00000000-0000-4000-8000-000000000000",
    "loop_index": 4,
    "model_request_count": 4,
    "consecutive_tool_calls": 3,
    "active_tool_count": 7,
    "client_tool_mode": "native",
    "requested_tool_choice": "auto",
    "finish_reason": "tool_calls",
    "tool_call_count": 1,
    "retry_index": 0,
    "request_shape": {
      "estimated_prompt_tokens": 18420,
      "tools_schema_bytes": 9320
    }
  }
}
```

工具事件示例只记录形态和结果，不上传参数或结果正文：

```json
{
  "schema": "client_diagnostic.v1",
  "event_id": "diag_01K0TOOL_DONE",
  "session_id": "ses_01K0SESSION",
  "message_id": "msg_01K0MESSAGE",
  "tool_call_id": "call_01K0TOOL",
  "created_at": "2026-07-16T09:30:03.450Z",
  "app": {
    "name": "medevidence-desktop",
    "version": "2.1.0"
  },
  "category": "tool",
  "action": "execution",
  "status": "error",
  "duration_ms": 1200,
  "error_code": "upstream_http_502",
  "error_message": "Tool upstream returned a transient server error.",
  "metadata": {
    "client_turn_id": "turn_01K0TURN",
    "turn_code": "T:7K3P2",
    "loop_index": 4,
    "tool_name": "medevidence",
    "tool_result_chars": 0,
    "tool_error_code": "upstream_http_502",
    "consecutive_same_failure": 2
  }
}
```

### 5.4 上传可靠性

诊断上传器应满足：

- 与聊天请求使用不同的短超时和有界队列；
- 不阻塞 UI、模型流或工具结果回传；
- 使用稳定 `event_id` 做重试幂等；
- `429` 按 `Retry-After` 延迟，`503` 暂停上传后再恢复；
- `401/403` 不做无限重试；
- 进程退出时允许丢弃低优先级事件，但优先保留 turn 终态和错误事件；
- 诊断上传自身失败只能做本地采样记录，不能递归地产生无限 `diagnostic_upload` 事件。

## 6. P1：客户端本地 tool-loop shadow

Desktop 是实际驱动 Agent 和执行本地工具的一侧，因此应为每个 turn 维护：

```ts
type ToolLoopState = {
  modelRequestCount: number;
  consecutiveToolCalls: number;
  startedMonoMs: number;
  estimatedPromptTokens: number | null;
  lastFinishReason: string | null;
  repeatedFailureCount: number;
  finalizerStarted: boolean;
  terminalState: "running" | "ok" | "error" | "timeout" | "aborted";
};
```

第一阶段只计算和上报，不改变执行：

- 第 8 次连续工具调用记录 warning 候选；
- 第 12 次连续工具调用记录 hard 候选；
- elapsed 达到 10 分钟记录 hard 候选；
- 本地估算 Prompt 达到 100k/120k 时记录 warning/hard 候选；
- 同一工具出现重复的标准化失败时记录 `consecutive_same_failure`；
- turn 到达终态后，如果后台仍准备发送模型请求或启动工具，记录 `post_terminal_activity` 客户端缺陷事件并阻止该后台动作进入正式执行。

客户端估算和 Gateway 估算都只能视为近似值。客户端可在 `request_shape.estimated_prompt_tokens` 中上报自己的估算，Gateway 会独立保存 `gateway_estimated_prompt_tokens` 和实际 provider usage，运维查询时可比较三者偏差。

## 7. P2：数据审核后启用客户端保护

建议至少观察一个真实使用高峰，再决定是否开启客户端主动保护。启用顺序如下：

1. **用户取消优先**：Stop 立即 abort 当前 fetch/stream/工具，并禁止原 turn 进入下一轮；
2. **重复失败熔断**：同一工具的同类可重试失败连续达到配置上限后，不再自动调用同一工具；
3. **Warning UI**：达到 warning 候选时显示“任务正在进行多轮工具调用”，同时保留 Stop；
4. **Hard guard**：达到审核后的工具次数、耗时或 Prompt 上限时，停止继续调用工具；
5. **一次性 finalizer**：如产品决定保留总结，最多发送一次 `tool_choice=none` 的总结请求，然后将 turn 置为终态；finalizer 失败后直接返回明确错误，不能恢复无限工具循环。

保护阈值必须可配置并带策略版本。客户端可以从与 Gateway 相同的候选值开始做 shadow 对比，但不应假设 Gateway 的内部阈值永远等于客户端产品策略。

客户端本地 guard 是用户体验层的主要保护，Gateway guard 是服务端的纵深保护。两者同时存在时应遵循“任意一侧停止后都不得继续该 turn”，但不能通过自动换模型、换上游账号或创建新 turn 绕过限制。

## 8. UI 与用户反馈增强

建议在错误详情或“复制诊断信息”中提供：

- `turn_code`；
- 最近一个 Gateway `request_id`；
- app version、public model、发生时间和时区；
- 当前模型请求次数、工具轮次和 elapsed；
- 客户端错误分类，例如 network、tool timeout、user aborted；
- 是否命中客户端 warning/hard guard。

不要展示或复制：

- API key、Authorization Header、cookie 或上游 token；
- 用户 Prompt、工具参数、工具结果正文；
- 本地完整文件路径；
- PDF/图片 base64 或附件正文；
- system/developer prompt。

用户只需提供 `turn_code`；运维侧可以通过以下命令把 Desktop 事件和 Gateway 请求合并为同一时间线：

```bash
node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  --client-events-db /var/lib/codex-gateway/client-events.db \
  client-turn T:7K3P2 \
  --timezone Australia/Sydney \
  --include-metadata
```

合并结果会同时显示客户端诊断、Gateway 请求、实际上游、Prompt 估算、provider usage、工具数量、finish reason 和 tool-loop shadow 判断。

## 9. 隐私与数据最小化

`client_diagnostic.v1` 会拒绝明显的 secret、凭据以及危险的正文类 metadata key。客户端仍应在上传前主动建立 allowlist：

- 只上传数值、枚举、布尔值、随机 ID 和脱敏错误分类；
- 不上传名为 `request`、`response`、`body`、`content`、`data`、`prompt`、`text`、`token`、`authorization`、`cookie`、`password` 或 `secret` 的正文数据；
- `error_message` 使用用户安全的归一化消息，不直接转发底层异常全文；
- 工具参数和结果只上传大小、类型、耗时和状态，不上传内容；
- 如需识别重复工具输入，优先在本地比较；确需上传 fingerprint 时使用 turn/session 范围内加盐的不可逆值，避免对低熵参数直接做可枚举哈希；
- 诊断队列落盘时采用与现有客户端凭据和日志相同或更严格的本地保护及保留周期。

## 10. 建议交付顺序

### M1：身份贯通与最小事件

- 实现 `ClientTurnContext`；
- 五个 Header 全路径注入；
- 捕获响应 `x-request-id`；
- 上报 turn/model request/tool/stop/terminal 最小事件；
- UI 可复制 `turn_code` 和 request id；
- 诊断上传失败不影响主流程。

### M2：客户端 shadow

- 建立本地 `ToolLoopState`；
- 统计循环、elapsed、Prompt 估算和重复失败；
- 上报版本化 shadow decision；
- 使用生产 `client-turn` 查询核对 Desktop 与 Gateway 时间线。

### M3：告警与熔断灰度

- 先启用 Warning UI 和 Stop；
- 再灰度重复失败熔断；
- 审核真实分布后启用 hard guard；
- 如需要 finalizer，确保最多一次且不可重新进入工具循环。

## 11. 验收标准

### 11.1 兼容性

- 不发送任何新 Header 的旧客户端仍能完成普通、流式和工具请求；
- 新客户端不需要解析新的 Gateway 响应字段；
- 诊断接口 401、429、503 或网络不可用时，主聊天请求不受影响；
- public model、SSE frame、tool call 和错误响应契约无变化。

### 11.2 关联正确性

- 同一用户 turn 的所有模型请求具有相同 `client_turn_id` 和 `turn_code`；
- 新用户消息、用户主动重新生成和并发任务使用不同 turn id；
- 工具 follow-up 和自动重试不生成新 turn id；
- 同一 session 的请求使用稳定 `client_session_id`；
- `client-turn <turn_code>` 能同时查到 Desktop 事件和 Gateway 请求；
- 客户端保存的 `gateway_request_id` 与 Gateway `request_events.request_id` 一致。

### 11.3 循环与取消

- Stop 后不会再发起下一轮模型请求或工具调用；
- timeout、abort、工具错误和模型错误均产生唯一终态；
- started/terminal 事件使用不同 event id，重传同一事件保持幂等；
- shadow 命中 8/12 次、10 分钟、100k/120k 边界时记录正确；
- 并发 turn 之间的计数和 guard 状态互不污染；
- finalizer 如被启用，最多执行一次，失败后不重新进入循环。

### 11.4 安全

- 自动测试确认诊断 payload 不包含 credential、Authorization、cookie、Prompt、工具正文或本地完整路径；
- 日志和“复制诊断信息”同样不包含上述敏感信息；
- 超长或非法 Header 不会导致客户端崩溃，也不会被客户端当作服务端强制失败；
- 诊断队列有明确容量、重试和保留上限。

## 12. Gateway 与 Desktop 的职责边界

| Gateway 负责 | Desktop 负责 |
| --- | --- |
| 请求级身份、模型路由和上游诊断 | 用户 turn 的创建、终止和并发隔离 |
| Gateway Prompt 估算与 provider usage | 客户端发送前 Prompt/附件/工具 schema 形态 |
| 上游账号、runtime、HTTP 状态和 finish reason | 本地工具真实执行状态和结果形态 |
| 跨请求 tool-loop shadow 和后续纵深保护 | 用户 Stop、本地 warning、重复失败熔断和 UI |
| 诊断事件安全接收、存储和运维查询 | best-effort 上报、隐私过滤和本地有界队列 |

这份建议的核心不是把 Gateway 逻辑复制到 Desktop，而是让两侧共享稳定的 turn/request 关联标识，并各自记录只有自己能观察到的事实。这样既保持旧客户端兼容，也能在工具循环、长上下文、网络失败或用户取消问题出现时快速还原完整时间线。

## 13. 相关资料

- [Desktop client turn diagnostics runbook](../operations/desktop-client-turn-diagnostics-runbook.md)
- [GoldenCode required tool loop incident and fix plan](goldencode-required-tool-loop-incident-and-fix-plan-2026-07-14.zh-CN.md)
- [Large PDF Gateway/client event contract](../operations/large-pdf-gateway-client-event-contract-2026-07-09.zh-CN.md)
- [Client message upload proposal](../medcode-gateway-client-message-upload-proposal.zh-CN.md)
