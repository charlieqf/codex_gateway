# Codex Gateway

访问网关原型项目，用于把订阅持有者的 AI/Codex 能力通过受控服务端代理给多设备或少数受信用户使用。

当前阶段是 Phase 1 开发态网关。Provider 可行性、真实 Codex SDK 调用、SSE 网关路径和 SQLite-backed session persistence 已验证；正式 access credential 管理和生产部署尚未完成。

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
docker compose -f compose.azure.yml build
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

## Access Credential MVP

SQLite-backed access credentials are now available for the MVP path:

```powershell
$env:GATEWAY_SQLITE_PATH = "C:\work\code\codex-gateway\.gateway-state\gateway.db"
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH issue --label local-dev --scope code
```

The `issue` command prints the bearer token once. The database stores only a prefix and SHA-256 hash.

Run the gateway with database credential authentication:

```powershell
Remove-Item Env:\GATEWAY_DEV_ACCESS_TOKEN -ErrorAction SilentlyContinue
$env:GATEWAY_AUTH_MODE = "credential"
$env:GATEWAY_SQLITE_PATH = "C:\work\code\codex-gateway\.gateway-state\gateway.db"
npm run dev:gateway
```

Credential operations:

```powershell
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH list --active-only
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH revoke <credential-prefix>
```
