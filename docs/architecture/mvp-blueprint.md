# MVP 具体化蓝图

本文把两份源文档收敛成可实施的 MVP 设计。源文档仍是需求和初步技术方案的权威入口；本文用于指导目录、接口和 Phase 0/1 工作。

## 固定决策

| 项 | MVP 决策 |
| --- | --- |
| 技术栈 | TypeScript + Node.js + npm workspaces |
| 部署形态 | Azure Ubuntu VM 单实例，Docker Compose 容器优先 |
| Provider | OpenAI Codex / ChatGPT subscription 作为第一家验证对象 |
| 存储 | SQLite 单机持久化，v2+ 再外置 |
| Access credential | opaque key，服务端只保存 hash + prefix |
| Scope | `medical` / `code` 两档进入 MVP |
| Session 归属 | `subject_id` 是会话隔离边界 |
| Subscription | MVP 仅一条 active subscription，但所有 session 都写入 `subscription_id` |
| 管理面 | Admin CLI 优先，Admin API 可后置 |

## 组件边界

```text
apps/gateway
  HTTP access surface
  auth middleware
  scope/rate/session orchestration
  streaming proxy

apps/admin-cli
  issue/list/revoke/rotate
  provider reauth command
  usage reports

packages/core
  shared types
  provider adapter contract
  structured errors

packages/provider-codex
  OpenAI Codex adapter
  app-server or SDK integration
  ChatGPT subscription auth verification

packages/store-sqlite
  credential/subject/session/subscription/event stores

compose.azure.yml
  gateway container
  Caddy TLS reverse proxy
  persistent gateway_state volume for SQLite and CODEX_HOME
```

## 请求路径

1. 客户端携带 `Authorization: Bearer <access_credential>`。
2. Gateway 用 prefix 定位候选 credential，用 hash 校验完整凭据。
3. Gateway 检查 revoked/expired/scope/rate limit。
4. 新会话由 scheduler 绑定唯一 active subscription。
5. 已有会话必须属于当前 `subject_id`，并复用 `subscription_id`。
6. Gateway 调用 provider adapter 并透传 stream event。
7. Observation writer 记录元数据，不记录请求/响应正文和完整凭据。

## MVP 验证路径

Phase 0 不先写完整网关，而是验证第一家 provider 是否满足 adapter 合同。验证通过后进入 Phase 1。

通过标准：

- 服务端受控 `CODEX_HOME` 能持有 ChatGPT/Codex 登录态。
- 客户端不需要接触 ChatGPT/Codex 原始 token。
- 能创建/继续一段 Codex thread。
- 能获得可转发的增量事件或可接受的非流式降级。
- 授权失效时可以稳定识别 `provider_reauth_required`。
- 能读取 ChatGPT/Codex rate-limit 状态或至少归一化限流错误。

失败处理：

- 若 ChatGPT subscription path 不能作为服务端托管 provider credential，MVP 第一 provider 改为 OpenAI API key path，但 adapter 合同不变。
- 若 Codex 不适合通用问答代理，只把 `provider-codex` 定位为 code scope adapter，另建 `provider-openai-api` 覆盖 medical scope。
