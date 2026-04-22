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
- Gateway auth 已改为默认保护的 Fastify hook，`/gateway/health` 是显式 public route。
- Gateway request context 已承载 dev credential、subject、subscription、provider 和 scope，为 Phase 2 credential lookup 替换做好入口。
- SSE 路径已加入 response close abort、heartbeat 和 write failure cleanup。
- Store contracts 已从 `store-sqlite` 上移到 `@codex-gateway/core`，SQLite 和内存实现只依赖 core contract。
- SQLite store 已有幂等 schema migration，覆盖 `subjects`、`subscriptions`、`access_credentials`、`sessions`、`request_events` 基础表。
- Access credential MVP 已实现：opaque token issue、SHA-256 hash 落库、prefix lookup、list、revoke、rotate、gateway SQLite credential auth、admin CLI `issue/list/revoke/rotate/events/report-usage/prune-events`。
- Gateway 已实现单进程 per-credential rate limiting：requests per minute、requests per day、concurrency，并返回 `rate_limited` 与 `retry_after_seconds`。
- Gateway 已将 request events 写入 SQLite `request_events`，并通过 admin CLI `events`、`report-usage`、`prune-events --dry-run` 提供明细检查、动态聚合和手动 retention 清理入口。
- Gateway 设置 `GATEWAY_SQLITE_PATH` 后会使用 SQLite Session Store，并在启动时 seed 开发 subject/subscription。
- 2026-04-22 已在 Azure VM 上用 `127.0.0.1:18787` 完成真实端到端 smoke：`/gateway/status` 返回 Codex provider healthy，`/sessions` 创建成功，`/messages` 经 SSE 返回 `codex-gateway-through-gateway-ok`，并回写 provider thread id `019db3ae-4612-7493-b93a-95999f66de60`。测试后确认无残留监听端口或长跑 Codex 进程。
- 2026-04-22 已在 Azure VM 上启用 `GATEWAY_SQLITE_PATH` 完成 SQLite-backed gateway smoke：SSE 返回 `codex-gateway-sqlite-ok`，并回写 provider thread id `019db3b4-830f-79e3-b94d-b36689c04e47`。测试后确认无残留监听端口或长跑 Codex 进程。
- 2026-04-22 commit `62b9801` 已在 Azure VM 上完成优化后验证：`npm ci`、`npm run build`、`npm test` 通过；loopback gateway smoke 返回 `codex-gateway-optimized-ok`，SQLite session 写回 provider thread id，测试后确认 `127.0.0.1:18787` 和 gateway/Codex 进程无残留。
- 2026-04-22 commit `5f57221` 已在 Azure VM 上完成 credential auth 验证：admin CLI 签发临时 SQLite credential，gateway 以 `GATEWAY_AUTH_MODE=credential` 完成 loopback SSE smoke 并返回 `codex-gateway-credential-ok`；随后 CLI revoke 后同一 bearer token 返回 `revoked_credential`，测试后确认无残留监听端口或长跑进程。
- 2026-04-22 commit `c696be0` 已在 Azure VM 上完成 rotate/rate-limit 验证：低 rpm credential 第二次请求返回 `rate_limited` 与 `retry_after_seconds`；CLI `rotate --grace-hours 0` 后旧 token 返回 `revoked_credential`，新 token 完成 loopback SSE smoke 并返回 `codex-gateway-rotate-rate-ok`。测试后删除临时 smoke DB，并确认无残留监听端口或长跑进程。
- 2026-04-22 commit `3a35b24` 已在 Azure VM 上完成 request event 验证：`npm ci`、`npm run build`、`npm test` 通过；loopback gateway 用低 rpm credential 产生一次成功请求和一次 `rate_limited` 请求，admin CLI `events` 查到 2 条事件，分别为 `ok` 和 `error/rate_limited`。测试后删除临时 smoke DB，并确认无残留监听端口或长跑进程。

尚未完成：

- 多进程共享限流、定时 retention automation 和 materialized usage reports。
- SubjectStore / SubscriptionStore 仍只有 bootstrap upsert，尚未拆成完整 CRUD。
- Admin CLI 仍缺少更完整的 subject/subscription 配置管理和操作审计。
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
