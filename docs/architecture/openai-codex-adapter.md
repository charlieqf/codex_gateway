# OpenAI Codex Adapter 方案

本文以 ChatGPT/Codex 订阅作为 MVP 第一 provider 示例。

## 官方资料结论

官方文档显示：

- Codex CLI 可以通过 ChatGPT 订阅或 API key 登录。
- Codex CLI/IDE 的 ChatGPT 登录会缓存本地凭据，活跃使用时会自动刷新。
- Codex SDK 可在服务端程序中控制本地 Codex agent。
- Codex App Server 暴露 account、thread、rate limit 等 JSON-RPC 能力，并支持 ChatGPT 登录、device-code 登录和实验性的外部 ChatGPT token 模式。

参考：[docs/references/openai-codex-docs.md](../references/openai-codex-docs.md)

## MVP 推荐路径

优先验证 `Codex App Server` 路径：

```text
Gateway process
  -> provider-codex adapter
    -> local Codex app-server / SDK
      -> CODEX_HOME=/var/lib/codex-gateway/codex-home
        -> ChatGPT subscription auth cache
```

设计理由：

- ChatGPT subscription 登录态只在 Azure VM 的服务用户目录中。
- 终端客户端只拿 gateway access credential。
- App Server 已暴露 account/rateLimits/thread 类接口，适合映射 adapter contract。
- 若后续需要 CI/API key 路径，可以增加 `provider-openai-api` 或在 adapter 内拆 auth mode。

## 服务端凭据目录

Azure VM 上固定：

```text
/var/lib/codex-gateway/
  gateway.db
  codex-home/
    auth.json or OS credential backing store
```

约束：

- `codex-home` 归 `codexgw` 服务用户所有，权限 `0700`。
- 不进入 Git、不进入日志、不打包到 release artifact。
- 管理命令只展示 auth mode、account email hash、plan type、rate-limit 摘要，不展示 token。

## Adapter 能力映射

| Gateway adapter | Codex path |
| --- | --- |
| `health` | MVP 先检查隔离 `CODEX_HOME/auth.json` 是否存在；后续可升级到 `account/read` |
| `refresh` | MVP 返回 `not_needed` 或 `reauth_required`；Codex CLI 在活跃使用中刷新 ChatGPT token |
| `create` | 无首条消息时只创建 gateway session；有首条消息时启动 Codex thread |
| `message` | `startThread` 或 `resumeThread` 后调用 `runStreamed()`，转换为网关 `StreamEvent` |
| `list` | Codex SDK 暂无稳定 list API；网关 Session Store 是会话列表事实来源 |
| `cancel` | MVP no-op；后续接 AbortController |
| `normalize` | 401 => `provider_reauth_required`，429 => `rate_limited` |

## 当前实现状态

代码入口：[packages/provider-codex/src/codex-adapter.ts](../../packages/provider-codex/src/codex-adapter.ts)

已实现：

- 使用 `@openai/codex-sdk`。
- 强制传入隔离 `CODEX_HOME`。
- `message()` 根据 `session.providerSessionRef` 选择 `resumeThread()` 或 `startThread()`。
- SDK `thread.started` 映射为 `completed.providerSessionRef`。
- `agent_message` 的 started/updated/completed 文本映射为 `message_delta`。
- MCP tool call 和 command execution 映射为 `tool_call`。
- auth/rate-limit/service unavailable 基础错误归一化。

重要约束：

- Codex SDK 只有在首次 run 后才产生 thread id；因此 Gateway 创建空 session 时 `providerSessionRef = null` 是正常状态。
- Gateway 在收到 `completed.providerSessionRef` 后必须回写 Session Store，后续消息才能 resume。
- MVP 默认使用 `read-only` sandbox、`approvalPolicy=never`、`webSearchMode=disabled`。`code` scope 的写权限要等 Scope Engine 明确接管后再打开。

## Phase 0 风险

| 风险 | 处理 |
| --- | --- |
| ChatGPT subscription auth cache 不适合长驻服务端托管 | 改用 OpenAI API key provider 做 MVP，Codex adapter 留作本地 code scope |
| App Server thread/list 能力不足 | 网关侧保存 `providerSessionRef` 和消息上下文 |
| Codex 输出事件不是稳定公开合同 | 只依赖官方 SDK/App Server 暴露的稳定层；不解析私有缓存文件 |
| Scope 无法限制 Codex 本地工具 | `medical` scope 不走 Codex 工具执行路径；`code` scope 才允许 Codex local agent |

## 重要边界

本 adapter 不绕过 ChatGPT/Codex 登录流程，不复制用户浏览器 cookie，不解析非公开 token 格式。Phase 0 只验证官方支持的 CLI/SDK/App Server 集成面。
