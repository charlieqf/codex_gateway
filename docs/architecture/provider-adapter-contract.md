# Provider Adapter 合同

Provider adapter 是网关保持中立的边界。Gateway 不能直接调用某个厂商 SDK；所有 provider 行为必须通过本合同进入核心流程。

## TypeScript 接口

源码入口：[packages/core/src/provider-adapter.ts](../../packages/core/src/provider-adapter.ts)

核心方法：

| 方法 | 目的 |
| --- | --- |
| `health(subscription)` | 探测订阅是否健康、是否需要重新授权 |
| `refresh(subscription)` | 尝试刷新 provider 登录态或明确返回 reauth |
| `create(input)` | 创建 provider 侧会话或初始化网关侧上下文 |
| `list(input)` | 列出当前 subject 可映射的 provider 会话 |
| `message(input)` | 发送消息并返回 `AsyncIterable<StreamEvent>` |
| `cancel(input)` | 取消进行中的 provider 请求 |
| `normalize(err)` | 把 provider 错误归一化为 `GatewayError` |

## 必须归一化的错误

| Gateway code | 触发条件 |
| --- | --- |
| `provider_reauth_required` | provider token 过期、刷新失败、登录态失效 |
| `subscription_unavailable` | subscription 被禁用或 health 不可用 |
| `rate_limited` | provider 或 gateway 限流 |
| `service_unavailable` | provider 超时、网络错误、非授权类 5xx |

## StreamEvent 约束

adapter 不返回 provider 原始事件给客户端。它必须把输出转成统一事件：

- `message_delta`：增量文本。
- `tool_call`：工具调用元数据，后续由 scope engine 决定是否允许。
- `completed`：会话完成，可附带新的 provider session ref。
- `error`：可机器识别的错误。

## Provider 接入验收

任何新 provider 必须先有 contract test：

1. health 可区分 healthy 和 reauth_required。
2. refresh 失败不会泄露 provider credential。
3. create/message 能完成一次最短会话。
4. message 事件可被 SSE 转发。
5. normalize 覆盖认证失败、限流、服务不可用。

