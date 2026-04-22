# 实施路线

## Phase 0: Provider 可行性验证

- 验证 OpenAI Codex ChatGPT subscription 登录态能否服务端托管。
- 验证 Codex SDK/App Server 可由 Node 服务端控制。
- 产出 adapter contract test 草稿。

退出：确定 `provider-codex` 是 MVP provider，或切换到 OpenAI API key provider。

## Phase 1: Gateway 骨架

- Codex provider adapter 接真实 SDK。
- Fastify HTTP service。
- `/gateway/health`、`/gateway/status`。
- SQLite store 初始化。
- 单 subscription scheduler。
- provider adapter wiring。

退出：一把手工 seed 的 access credential 可以创建会话并收到 provider 响应。

当前进展：

- `provider-codex` 已能基于 `CODEX_HOME` start/resume Codex thread。
- adapter tests 已覆盖 agent message delta、resume、tool call 映射和错误归一化。
- 开发态 Gateway 已接入临时 bearer token、内存 Session Store、`/sessions` 和 SSE `/sessions/:id/messages`。
- Gateway 会在收到 `completed.providerSessionRef` 后回写内存 Session Store。

尚未完成：

- 正式 access credential 生成、hash、吊销、过期、限流。
- SQLite 持久化 Session Store。
- Admin CLI。
- 生产化错误码覆盖和观察事件。

## Phase 2: 凭据生命周期

- `issue`、`list`、`revoke`、`rotate`。
- opaque key 生成、hash 落盘、prefix 管理。
- 结构化错误。

退出：S1、S2、S6、S11 基础验收通过。

## Phase 3: Scope 与限流

- `medical` / `code` 能力矩阵。
- endpoint/action 层 scope enforcement。
- 每凭据 rpm/day/concurrency 限流。

退出：S4、S5 验收通过。

## Phase 4: 会话延续与观察

- 同 subject 跨设备会话列表。
- 不同 subject 隔离。
- usage/event metadata。
- 每凭据 last_used_at、本周请求数、错误率。

退出：S3、S12、S13 MVP 验收通过。

## Phase 5: Azure VM 运维固化

- systemd service。
- TLS reverse proxy。
- backup/restore。
- reauth/revoke/rotate runbooks。
- 基础性能测量脚本。

退出：未参与开发的人按文档 4 小时内搭通。
