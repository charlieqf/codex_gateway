# Codex Gateway

## 操作用词

日常使用先按下面几个概念理解，内部表名只作为排查时的对应关系：

- 用户：你要授权的人、客户或设备组。内部表名是 `subjects`。
- API key：发给用户的 bearer token。内部表名是 `access_credentials`；数据库只保存 prefix 和 hash。
- 上游 Codex 账号：服务端 `CODEX_HOME` 里的 ChatGPT/Codex 登录态。内部 provider 记录叫 subscription。
- 用量：按 API key 或用户统计的请求事件和日报。

访问网关原型项目，用于把订阅持有者的 AI/Codex 能力通过受控服务端代理给多设备或少数受信用户使用。

当前阶段是 Phase 1 开发态网关。Provider 可行性、真实 Codex SDK 调用、SSE 网关路径、SQLite-backed session persistence、access credential 管理、限流和基础 usage observation 已验证；生产部署尚未完成。

## MVP 收敛

- 技术栈：TypeScript + Node.js + npm workspaces。
- 部署目标：Azure Ubuntu VM 单实例，Docker Compose 容器优先。
- 第一个 provider：OpenAI Codex / ChatGPT subscription path。
- 第一阶段目标：用开发态 bearer token 跑通 gateway -> Codex adapter -> SSE，并用 SQLite 持久化 session。
- 网关核心保持 provider-neutral，OpenAI Codex 只作为第一个 adapter。

## 文档入口

- 需求文档：[access-gateway-requirements.md](./access-gateway-requirements.md)
- 初步技术设计：[access-gateway-technical-design.md](./access-gateway-technical-design.md)
- MVP 蓝图：[docs/architecture/mvp-blueprint.md](./docs/architecture/mvp-blueprint.md)
- Provider adapter 合同：[docs/architecture/provider-adapter-contract.md](./docs/architecture/provider-adapter-contract.md)
- OpenAI Codex adapter 方案：[docs/architecture/openai-codex-adapter.md](./docs/architecture/openai-codex-adapter.md)
- Phase 0 验证计划：[docs/implementation/phase-0-openai-codex-validation.md](./docs/implementation/phase-0-openai-codex-validation.md)
- Azure Ubuntu VM 部署草案：[docs/operations/azure-ubuntu-vm.md](./docs/operations/azure-ubuntu-vm.md)
- 重要 VM 非侵入测试规则：[docs/operations/safe-vm-testing.md](./docs/operations/safe-vm-testing.md)
- 当前系统状态：[docs/operations/system-status.md](./docs/operations/system-status.md)
- 环境访问方式：[docs/operations/environment-access.md](./docs/operations/environment-access.md)
- 操作经验：[docs/operations/operational-experience.md](./docs/operations/operational-experience.md)
- MedCode 服务消费者技术说明：[docs/consumer-technical-guide.md](./docs/consumer-technical-guide.md)

## 仓库结构

```text
apps/
  gateway/       # HTTP gateway service
  admin-cli/     # operator CLI
packages/
  core/          # provider-neutral types, errors, contracts
  provider-codex/# OpenAI Codex adapter proof path
  store-sqlite/  # MVP single-node persistence package
docs/
  architecture/
  implementation/
  operations/
  decisions/
ops/
  runbooks/
  scripts/
tests/
  contract/
  e2e/
```

## 本地开发

本机已验证 Node.js/npm/Codex CLI 可用。初始化依赖后可使用：

```powershell
npm install
npm run typecheck
npm run dev:gateway
```

容器化部署入口：

```powershell
Copy-Item config\gateway.container.example.env config\gateway.container.env
docker compose -p codex_gateway_test -f compose.azure.yml build gateway
docker compose -p codex_gateway_test -f compose.azure.yml up -d gateway
```

Phase 0 期间不要把任何 ChatGPT/Codex 登录态提交进仓库。服务端登录态应放在 `CODEX_HOME` 指向的受控目录，并由部署用户独占访问。

## Phase 0 Probe

检查隔离 Codex 环境和登录状态：

```powershell
npm run probe:codex -- --codex-home .gateway-state\codex-home
```

登录后执行 SDK streamed turn：

```powershell
npm run probe:codex -- --codex-home .gateway-state\codex-home --run
```

## Phase 1 Dev Gateway

当前 gateway 已有开发态最小路径：临时 bearer token、内存 session store、真实 Codex adapter、SSE message stream。

```powershell
$env:GATEWAY_DEV_ACCESS_TOKEN = "local-dev-token"
$env:CODEX_HOME = "C:\work\code\codex-gateway\.gateway-state\codex-home"
$env:CODEX_WORKDIR = "C:\work\code\codex-gateway"
$env:GATEWAY_SQLITE_PATH = "C:\work\code\codex-gateway\.gateway-state\gateway.db"
npm run dev:gateway
```

可用接口：

- `GET /gateway/status`
- `POST /sessions`
- `GET /sessions`
- `POST /sessions/{id}/messages` with `Accept: text/event-stream`

所有访问面请求都需要：

```http
Authorization: Bearer local-dev-token
```

这只是 Phase 1 开发路径。Phase 2 会替换为正式 access credential 签发、hash 落盘、吊销、过期和限流。

如果不设置 `GATEWAY_SQLITE_PATH`，gateway 使用内存 session store；设置后会自动创建 SQLite schema 并持久化 sessions。

## API Key MVP

SQLite-backed API keys are now available for the MVP path:

```powershell
$env:GATEWAY_SQLITE_PATH = "C:\work\code\codex-gateway\.gateway-state\gateway.db"
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH issue --user alice --label "Alice laptop" --scope code --rpm 30 --rpd 500 --concurrent 1
```

The `issue` command prints the API key once. The database stores only a prefix
and SHA-256 hash.

Run the gateway in API key auth mode:

```powershell
Remove-Item Env:\GATEWAY_DEV_ACCESS_TOKEN -ErrorAction SilentlyContinue
$env:GATEWAY_AUTH_MODE = "credential"
$env:GATEWAY_SQLITE_PATH = "C:\work\code\codex-gateway\.gateway-state\gateway.db"
npm run dev:gateway
```

When a SQLite API key store is available, the gateway defaults to API key auth
even if `GATEWAY_DEV_ACCESS_TOKEN` is also set. Dev auth must be explicit in
mixed setups and is rejected when `NODE_ENV=production`. `/gateway/health`
includes `auth_mode` so operators can confirm the active mode.

API key and user operations:

```powershell
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH list-users
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH list --user alice --active-only
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH update-key <credential-prefix> --scope medical --rpm 10 --rpd 200 --concurrent 1
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH events --user alice --limit 50
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH report-usage --user alice --days 7
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH audit --user alice --limit 50
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH trial-check --max-active-users 2
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH disable-user alice
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH enable-user alice
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH prune-events --before-days 30 --dry-run
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH rotate <credential-prefix> --grace-hours 24
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH revoke <credential-prefix>
```

`update-key` changes an existing API key's label, scope, expiration, or
`rpm`/`rpd`/`concurrent` limits without issuing a new token. `disable-user`
makes all API keys for that user fail authentication without deleting usage
history. `rotate` issues a new token for the same user so session history is
shared. The old token stays active until the grace window expires; use
`--grace-hours 0` to revoke it immediately. Gateway API key auth enforces each
key's `rpm`, `rpd`, and `concurrent` policy in the current gateway process and
returns `rate_limited` with `retry_after_seconds` when exceeded.

`events` lists request-level observation records. `report-usage` dynamically
aggregates `request_events` into daily rows. `audit` lists administrator actions
such as issuing, updating, revoking, rotating, disabling users, enabling users,
and pruning request events. `trial-check` runs read-only checks before a 1-2
user controlled internal trial. `prune-events` manually deletes old request
events by cutoff. Run `prune-events` with `--dry-run` first and remove it only
after reviewing the `matched` count. There is no scheduled retention job yet.
