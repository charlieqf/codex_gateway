# Phase 0: OpenAI Codex 可行性验证

目标是在本机和 Azure Ubuntu VM 上验证“服务端持有 ChatGPT/Codex 订阅登录态，Gateway 终端不接触原始订阅凭据”是否成立。

## 前置条件

- 有一个可用于测试的 ChatGPT/Codex 订阅账号。
- 本机或 VM 已安装 Node.js 24+、npm、Codex CLI。
- 设置独立 `CODEX_HOME`，不要使用个人日常 Codex 目录。

Windows 本机建议：

```powershell
$env:CODEX_HOME = "C:\work\code\codex-gateway\.gateway-state\codex-home"
codex --version
codex
```

Azure Ubuntu VM 建议目录见：[docs/operations/azure-ubuntu-vm.md](../operations/azure-ubuntu-vm.md)

## 验证项

### P0-1 登录态托管

1. 用受控 `CODEX_HOME` 执行 Codex ChatGPT 登录。
2. 退出 shell 后重新进入，保留同一 `CODEX_HOME`。
3. 验证无需重新登录即可启动 Codex。

通过标准：登录态只存在受控目录或服务用户凭据库中，仓库和客户端配置不含 token。

### P0-2 App Server/SDK 可控性

1. 用 `@openai/codex-sdk` 或 Codex App Server 创建 thread。
2. 发送最短 prompt。
3. 记录是否能拿到 thread id、最终响应、增量事件。

通过标准：能由 Node 服务端代码触发一次 Codex 运行。

### P0-3 会话继续

1. 保存 thread/session ref。
2. 重新启动验证程序。
3. resume 同一 thread 并发送第二条消息。

通过标准：后续消息能带上上一轮上下文，或明确需要网关侧保存上下文。

### P0-4 流式输出

1. 触发一个会产生多段输出的 prompt。
2. 观察 SDK/App Server 是否暴露增量事件。
3. 将事件映射为 `StreamEvent.message_delta`。

通过标准：能转发增量输出；若不能，则标记 Codex adapter MVP 只支持非流式降级，并评估是否改用 OpenAI API provider。

### P0-5 重新授权与限流

1. 读取 account/rate limit 状态。
2. 模拟 token 失效或手动 logout。
3. 验证错误能归一化为 `provider_reauth_required`。

通过标准：终端用户收到结构化错误，不暴露 provider token 或内部栈。

## Go / No-Go

Go 条件：

- P0-1 到 P0-5 都通过，或只有非关键项需要网关侧补偿。

No-Go 条件：

- 不能服务端托管 ChatGPT subscription 登录态。
- 不能由 Node 服务端稳定触发 Codex 运行。
- 认证失败无法区分重新授权与普通服务错误。

No-Go 后的默认调整：

1. MVP provider 改为 OpenAI API key path。
2. 保留 `provider-codex` 目录，用于后续 code scope 或本地 agent 场景。
3. 文档中的“订阅示例”改成 API subscription/usage-based provider，不改变 access credential、subject、session、scope 设计。

