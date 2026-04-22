# 访问网关 - 初步技术方案设计

| Field | Value |
| --- | --- |
| 状态 | Draft |
| 日期 | 2026-04-22 |
| 来源 | `access-gateway-requirements.md` |
| 定位 | 技术方案草案。只从需求文档推导，不依赖现有应用端代码。 |

## 1. 设计边界

本文只讨论技术可实现路径，不讨论第三方服务条款、医疗合规、商业化合规、威胁建模等问题。涉及凭据保存、TLS、日志脱敏等内容时，仅作为满足需求文档中功能和非功能目标所需的工程机制，不展开安全论证。

本文将需求拆成三档：

| 档次 | 技术目标 |
| --- | --- |
| MVP | 单提供商、单订阅、多访问凭据、多设备、凭据生命周期、scope 分权、跨设备会话延续、凭据维度观察 |
| v2 | 多订阅池化、高并发调度、订阅维度观察、第二个提供商 adapter 验证 |
| v2+ | 多网关实例、共享状态、负载均衡、故障剔除、指标汇聚 |

关键收敛：

1. MVP 只承诺一个经过验证的提供商。提供商中立体现在抽象边界和 adapter 合同，不体现在 MVP 同时接入多家。
2. MVP 只承诺单订阅。多订阅的字段、会话绑定和调度接口在 MVP 预留，但调度器只选择唯一订阅。
3. 会话归属单位不是裸凭据值，而是 `subject`。默认一把凭据创建一个 subject；例行轮换时新旧凭据可以显式归到同一 subject，从而兼顾 S11 和 S12。
4. v2+ 的在线会话不中断按“短暂断连后可恢复或可重试”设计，不把“进行中的流式响应永不断线”作为硬前提。

## 2. 核心概念

| 概念 | 含义 |
| --- | --- |
| `provider` | 底层 AI 服务供应方类型，例如 `openai`、`anthropic`、`kimi`、`deepseek`。 |
| `subscription` | 一份由订阅持有者接入的付费服务能力，包含 provider、登录态引用、健康状态和调度状态。 |
| `provider credential` | 对 provider 的原始登录态或 API 凭据，只存在服务端受控目录或凭据库。 |
| `access credential` | 网关签发给终端的二级凭据。终端只持有它，不持有 provider credential。 |
| `subject` | 访问网关内的逻辑使用者。会话历史归属 subject，而不是归属单个凭据字符串。 |
| `scope` | 访问凭据的能力档位。MVP 预置 `medical` 和 `code`。 |
| `session` | 用户与 AI 的连续交互上下文。MVP 下归属一个 subject，并绑定唯一 subscription。 |
| `adapter` | provider 适配器，负责登录态续期、模型调用、流式响应、错误归一化和健康探测。 |

### 2.1 Subject 与凭据的关系

为解决“不同凭据隔离”和“例行轮换不中断”的张力，采用以下规则：

1. 新发给新人的凭据默认创建新的 `subject_id`，会话历史互不可见。
2. 给同一用户做例行轮换时，新凭据使用原 `subject_id`，新旧凭据在宽限期内共享会话历史。
3. 应急吊销只吊销某个 `credential_id`。是否同时冻结该 `subject_id` 由管理操作显式决定。
4. 审计和限流仍以 `credential_id` 为主，必要时同时聚合到 `subject_id`。

这样满足：

- S3：每位受信者独立凭据、独立会话空间。
- S11：例行轮换时新旧凭据并存，不导致历史丢失。
- S12：同一 subject 的多设备可看到同一会话列表。

## 3. 总体架构

```text
Client
  |
  | service_url + access_credential
  v
Access Gateway
  |-- Auth Middleware
  |-- Scope Engine
  |-- Rate Limiter
  |-- Session Service
  |-- Scheduler
  |-- Streaming Proxy
  |-- Observation Writer
  |
  v
Provider Adapter
  |-- Credential Refresh
  |-- Health Probe
  |-- Request Translation
  |-- Error Normalization
  |-- Stream Translation
  |
  v
AI Provider
```

管理面独立于普通访问面：

```text
Operator
  |
  v
Admin CLI / Admin API
  |-- issue credential
  |-- rotate credential
  |-- revoke credential
  |-- list usage
  |-- add subscription
  |-- disable subscription
```

## 4. 组件设计

### 4.1 Access Gateway

职责：

1. 接收终端请求。
2. 校验 access credential。
3. 检查过期、吊销、scope、限流。
4. 为新 session 选择 subscription。
5. 为已有 session 使用固定 subscription。
6. 将请求转交给 provider adapter。
7. 透传流式响应，不在网关层缓冲完整回答。
8. 写入请求元数据和统计指标。
9. 返回结构化错误。

非职责：

1. 不保存 provider credential 到终端。
2. 不做业务内容审计。
3. 不判断第三方条款。
4. MVP 不做多租户 SaaS。

### 4.2 Credential Store

保存访问凭据的元数据，不保存完整凭据明文。

逻辑字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 凭据内部 ID。 |
| `prefix` | 给管理员识别和吊销用的短前缀。 |
| `hash` | 完整凭据的不可逆校验值。 |
| `subject_id` | 归属的逻辑用户。 |
| `label` | 管理员可读标签。 |
| `scope` | `medical` 或 `code`。 |
| `expires_at` | 到期时间。 |
| `revoked_at` | 吊销时间，未吊销为空。 |
| `rate` | 每分钟、每日等限流配置。 |
| `created_at` | 创建时间。 |
| `rotates_id` | 例行轮换时指向旧凭据，可为空。 |

MVP 可使用单机持久化存储。v2+ 需要迁移到多实例共享存储，或将该存储外置。

### 4.3 Subject Store

保存逻辑用户身份。

逻辑字段：

| 字段 | 说明 |
| --- | --- |
| `id` | subject ID。 |
| `label` | 管理员可读名称。 |
| `state` | `active`、`disabled`、`archived`。 |
| `created_at` | 创建时间。 |

Subject 是会话隔离的主要边界。普通新凭据不共享 subject；轮换凭据显式复用 subject。

### 4.4 Session Store

保存网关视角的会话索引和归属。

逻辑字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 网关会话 ID。 |
| `subject_id` | 会话归属。 |
| `subscription_id` | 首次创建时绑定的订阅。 |
| `provider_session_ref` | provider adapter 返回的会话引用。 |
| `title` | 可选，会话列表展示用。 |
| `state` | `active`、`archived`、`failed`。 |
| `created_at` | 创建时间。 |
| `updated_at` | 最近更新时间。 |

规则：

1. `GET /sessions` 只返回当前 subject 的 session。
2. `POST /sessions` 创建新 session，并绑定当前 scheduler 选择的 subscription。
3. `POST /sessions/{id}/messages` 必须校验 session 属于当前 subject。
4. v2 多订阅下，已有 session 始终回到创建时绑定的 subscription。
5. 如果绑定的 subscription 不可用，默认返回结构化错误，不自动迁移到其他 subscription。

### 4.5 Subscription Store

保存接入的订阅条目和运行状态。

逻辑字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 订阅 ID。 |
| `provider` | provider 类型。 |
| `label` | 管理员可读标签。 |
| `credential_ref` | provider credential 的服务端引用。 |
| `state` | `active`、`disabled`、`reauth_required`、`unhealthy`。 |
| `health` | 最近健康探测结果。 |
| `last_used_at` | 最近一次被调度时间。 |
| `cooldown_until` | v2 池化时的冷却截止时间。 |

MVP 只有一条 active subscription。v2 支持多条。

### 4.6 Provider Adapter

Provider adapter 是提供商中立设计的关键边界。每个 provider 必须实现同一组能力。

建议接口：

```ts
interface ProviderAdapter {
  kind: string
  health(sub: Subscription): Promise<ProviderHealth>
  refresh(sub: Subscription): Promise<RefreshResult>
  create(input: CreateSessionInput): Promise<CreateSessionResult>
  list(input: ListSessionInput): Promise<ProviderSession[]>
  message(input: MessageInput): AsyncIterable<StreamEvent>
  cancel(input: CancelInput): Promise<void>
  normalize(err: unknown): GatewayError
}
```

MVP 只实现一个 adapter，但要用该接口组织代码和测试。接入第二个 provider 时，不允许绕过该接口直接改网关核心逻辑。

Provider 接入前置验证：

1. 服务端能持有登录态或 API 凭据。
2. 能从服务端代表用户调用模型。
3. 能处理登录态续期或清晰返回重新授权状态。
4. 能提供流式输出或可接受的非流式降级。
5. 错误能归一化为网关错误码。
6. 会话引用能被保存并在后续请求中继续使用；如果 provider 不支持会话引用，则 adapter 必须在网关侧重建上下文。

### 4.7 Scope Engine

Scope 不只是凭据字段，必须转成能力矩阵。

MVP 能力矩阵：

| 能力 | `medical` | `code` |
| --- | --- | --- |
| 普通问答 | allow | allow |
| 医学证据检索类工具 | allow | allow |
| 文件读取 | deny by default | allow |
| 文件写入 | deny | allow |
| shell / command | deny | allow |
| 外部副作用操作 | deny | allow |
| 自定义工具调用 | deny unless allowlisted | allow |

执行位置：

1. Gateway 请求入口做 endpoint/action 级拒绝。
2. Session 创建时写入 scope/capability。
3. Provider adapter 调用工具前再做一次 capability 检查。
4. 观察记录中写入 `scope` 和拒绝原因。

### 4.8 Rate Limiter

MVP 使用每凭据限流：

1. 每分钟请求数。
2. 每日请求数。
3. 可选并发请求数。

v2 增加：

1. 每 subscription 并发数。
2. 每 subscription provider 错误率冷却。
3. 全局队列或公平调度。

限流错误必须返回 `retry_after_seconds`。

### 4.9 Scheduler

MVP：

```text
SingleSubscriptionScheduler:
  if session has subscription_id:
    return that subscription
  return only active subscription
```

v2：

```text
PoolScheduler:
  if session has subscription_id:
    return that subscription if usable
    otherwise return subscription_unavailable

  candidates = active subscriptions excluding cooldown
  choose by least_recently_used / least_inflight / health
  return selected subscription
```

S8 “停用其中一份订阅，其他份承接负载”解释为：新 session 和未绑定请求在 10 秒内不再选择被停用订阅。已有 session 因需求明确“不做跨订阅迁移”，默认不自动迁移。

### 4.10 Observation Writer

只记录元数据。

MVP 事件字段：

| 字段 | 说明 |
| --- | --- |
| `request_id` | 请求 ID。 |
| `credential_id` | 凭据 ID。 |
| `subject_id` | 逻辑用户 ID。 |
| `scope` | 权限档位。 |
| `session_id` | 会话 ID，可为空。 |
| `subscription_id` | 订阅 ID。 |
| `provider` | provider 类型。 |
| `started_at` | 开始时间。 |
| `duration_ms` | 总耗时。 |
| `first_byte_ms` | 首包耗时。 |
| `status` | `ok` 或 `error`。 |
| `error_code` | 错误码，可为空。 |
| `rate_limited` | 是否触发限流。 |

MVP 报表：

1. 每凭据 `last_used_at`。
2. 每凭据本周请求数。
3. 每凭据错误率。
4. 当前限流状态。
5. 网关健康和唯一订阅健康。

v2 增加订阅维度健康、错误、延迟。

## 5. 客户端协议草案

客户端只需要服务地址和访问凭据。

建议认证方式：

```http
Authorization: Bearer <access_credential>
```

### 5.1 状态检查

```http
GET /gateway/status
```

成功响应：

```json
{
  "state": "ready",
  "subject": {
    "id": "subj_123",
    "label": "student-a"
  },
  "credential": {
    "prefix": "ag_live_abcd",
    "scope": "medical",
    "expires_at": "2026-04-23T00:00:00Z"
  },
  "subscription": {
    "state": "healthy"
  }
}
```

### 5.2 会话列表

```http
GET /sessions
```

只返回当前 subject 可见的会话。

### 5.3 创建会话

```http
POST /sessions
```

网关创建 session，绑定 subject 和 subscription。

### 5.4 发送消息

```http
POST /sessions/{id}/messages
Accept: text/event-stream
```

网关必须：

1. 校验凭据。
2. 校验 subject 拥有该 session。
3. 校验 scope 能力。
4. 校验限流。
5. 使用 session 绑定的 subscription。
6. 透传 provider adapter 的流式事件。

## 6. 结构化错误

统一错误形状：

```json
{
  "error": {
    "code": "rate_limited",
    "message": "当前请求已超频，请稍后再试。",
    "request_id": "req_123",
    "retry_after_seconds": 60
  }
}
```

MVP 错误码：

| code | HTTP | 含义 |
| --- | --- | --- |
| `missing_credential` | 401 | 未提供访问凭据。 |
| `invalid_credential` | 401 | 凭据不存在或校验失败。 |
| `revoked_credential` | 401 | 凭据已吊销。 |
| `expired_credential` | 401 | 凭据已过期。 |
| `rate_limited` | 429 | 凭据超过限流。 |
| `forbidden_scope` | 403 | scope 不允许该操作。 |
| `session_not_found` | 404 | 会话不存在，或不属于当前 subject。 |
| `subscription_unavailable` | 503 | 绑定订阅不可用。 |
| `provider_reauth_required` | 503 | provider credential 需要重新授权。 |
| `service_unavailable` | 503 | 网关或 adapter 暂不可用。 |

## 7. MVP 交付范围

MVP 包含：

1. 单 provider adapter。
2. 单 subscription。
3. 多 access credential。
4. `subject`、`credential`、`session`、`subscription` 四类核心状态。
5. 凭据签发、列表、吊销、过期、例行轮换。
6. `medical` / `code` 两档 scope。
7. 每凭据限流。
8. 跨设备会话最终一致。
9. 流式响应透传。
10. 凭据维度观察。
11. 管理端命令或管理 API。
12. 部署和运维文档。

MVP 不包含：

1. 多 provider 同时上线。
2. 多 subscription 池化。
3. 多网关实例。
4. 近实时跨设备同步。
5. 跨订阅会话迁移。
6. 注册、计费、多租户 SaaS。
7. 请求和响应正文审计。

## 8. v2 设计预留

v2 增加多订阅池化和更高并发。

需要在 MVP 预留但不启用：

1. `subscription_id` 字段。
2. Session 创建时绑定 subscription。
3. Scheduler 接口。
4. Subscription health 和 cooldown 字段。
5. 订阅维度观察事件。
6. Provider adapter 抽象。

v2 新增能力：

1. 多 subscription 接入。
2. 新 session 在健康订阅间调度。
3. 某 subscription 被禁用后，新流量在 10 秒内不再命中。
4. 单凭据限流不影响其他凭据。
5. 订阅维度健康、错误率、延迟可查。
6. 第二个 provider adapter 接入验证。

v2 不做：

1. 已有 session 跨 subscription 自动迁移。
2. 多网关实例强一致。
3. 复杂优先级队列。

## 9. v2+ 设计预留

v2+ 目标是多网关实例和高可用。

需要引入：

1. 共享 Credential Store。
2. 共享 Session Store。
3. 共享 Rate Limiter。
4. 共享 Scheduler 状态或无状态调度策略。
5. Load Balancer 健康检查。
6. 指标汇聚。
7. 客户端断线重连和请求重试机制。

v2+ 对“不中断”的技术解释：

1. 已完成的 session 和 message 不丢失。
2. 网关实例故障后，客户端可以重新连接到其他实例。
3. 进行中的流式响应允许中断后重试或重新生成。
4. 若要做到流式响应无感续传，需要 provider adapter 支持可恢复流或网关实现事件缓存；该能力不作为默认 v2+ 基线。

## 10. 关键流程

### 10.1 签发凭据

```text
operator -> admin:
  issue --label alice --scope medical --expires 30d --rpm 5

admin:
  create subject if needed
  generate random credential
  store hash + metadata
  print full credential once
```

### 10.2 例行轮换

```text
operator -> admin:
  rotate <credential_prefix> --grace 24h

admin:
  create new credential with same subject_id
  set rotates_id = old credential
  keep old credential active until grace ends
  mark old credential revoked or expired after grace
```

### 10.3 应急吊销

```text
operator -> admin:
  revoke <credential_prefix>

gateway:
  next request reloads or observes revoked state
  return revoked_credential
  other credentials remain unaffected
```

MVP 目标：吊销后 10 秒内生效。

### 10.4 新会话请求

```text
client -> gateway:
  POST /sessions

gateway:
  auth credential
  load subject
  check scope
  choose subscription
  create provider session through adapter
  store gateway session
  return session id
```

### 10.5 继续会话

```text
client -> gateway:
  POST /sessions/{id}/messages

gateway:
  auth credential
  verify session.subject_id == credential.subject_id
  use session.subscription_id
  stream adapter.message()
```

### 10.6 Provider 重新授权

```text
adapter:
  detects refresh failure
  marks subscription reauth_required

gateway:
  new requests return provider_reauth_required
  observation records affected subscription
```

## 11. 可测验收调整

为避免不可证明的验收项，建议将部分原始验收转成可测标准。

| 原需求点 | 技术验收建议 |
| --- | --- |
| 终端不存在订阅原始凭据的任何文件/内存痕迹 | 协议、客户端配置、抓包、日志和持久化目录中不出现 provider credential；不承诺证明任意内存无痕。 |
| 远程首包延迟增量 <= 300 ms | 拆成网关自身转发开销和端到端实测。网关开销用压测证明，端到端在指定网络条件下测 5 次平均。 |
| v1 到 v2 不需要迁移脚本 | 改为不需要破坏性迁移；允许幂等、自动、可回滚的小迁移。 |
| 网关升级不中断所有在线会话 | MVP 单实例允许短暂断连后重连；v2+ 保证已完成消息不丢失，流式响应可重试。 |

## 12. 技术风险与前置验证

| 风险 | 影响 | 验证方式 |
| --- | --- | --- |
| Provider 不支持服务端长期登录态或自动续期 | FR-4 无法满足 | MVP Phase 0 先验证 refresh 和重新授权状态。 |
| Provider 不支持可继续会话 | S12 受影响 | Adapter 必须证明 provider session ref 可复用；否则在网关侧保存上下文。 |
| Provider 流式协议不稳定或不可透传 | NFR-1 受影响 | 先做流式压测和断流恢复测试。 |
| Scope 无法映射到底层工具能力 | S4 受影响 | MVP 明确 medical/code 能力矩阵，并做拒绝路径测试。 |
| 多订阅池化下 provider 限流不可观测 | S8/S9 受影响 | v2 调度器按错误码和超时做 best effort cooldown。 |
| 多实例共享状态复杂 | S10 受影响 | v2+ 前置共享存储和重连协议设计。 |

## 13. 建议实施阶段

### Phase 0: Provider adapter 可行性验证

目标：

1. 服务端持有 provider credential。
2. 能自动续期或明确进入重新授权状态。
3. 能成功调用模型。
4. 能拿到流式响应。
5. 能归一化错误。

退出条件：单 provider adapter 合同通过。

### Phase 1: Gateway MVP 骨架

目标：

1. Credential Store。
2. Subject Store。
3. Session Store。
4. 单 subscription。
5. `GET /gateway/status`。
6. `POST /sessions`。
7. `POST /sessions/{id}/messages`。

退出条件：一把凭据可以创建会话并收到回复。

### Phase 2: 凭据生命周期

目标：

1. issue。
2. list。
3. revoke。
4. expire。
5. rotate。
6. 结构化错误。

退出条件：S1、S2、S6、S11 基础验收通过。

### Phase 3: Scope 与限流

目标：

1. `medical` / `code` 能力矩阵。
2. 禁止 medical 高危操作。
3. 每凭据 rpm / daily limit。
4. 超频后返回 `rate_limited` 和 `retry_after_seconds`。

退出条件：S4、S5 通过。

### Phase 4: 会话延续与观察

目标：

1. 同 subject 跨设备会话可见。
2. 不同 subject 会话隔离。
3. 每凭据使用统计。
4. 错误率和 last_used_at。

退出条件：S3、S12、S13 MVP 通过。

### Phase 5: MVP 运维固化

目标：

1. 部署文档。
2. 重新授权流程。
3. 吊销流程。
4. 轮换流程。
5. 故障恢复流程。
6. 性能测量脚本。

退出条件：生手按文档 4 小时内搭通。

## 14. 需求覆盖矩阵

| 需求 | 设计覆盖 |
| --- | --- |
| FR-1 访问凭据管理 | Credential Store + Admin CLI/API + rotate/revoke/expire 流程 |
| FR-2 访问控制 | Auth Middleware + 结构化错误 |
| FR-3 授权与隔离 | Subject Store + Session Store + Scope Engine |
| FR-4 订阅凭据托管 | Subscription Store + Provider Credential Ref + Adapter Refresh |
| FR-4a 提供商中立 | Provider Adapter 合同 + 单 provider MVP + v2 adapter 扩展 |
| FR-5 客户端体验 | `service_url + access_credential` + `/gateway/status` + streaming |
| FR-6 观察与审计 | Observation Writer + 凭据/订阅维度统计 |
| NFR-1 性能 | Streaming Proxy + first_byte_ms 观测 + 压测 |
| NFR-2 可用性 | MVP 单实例恢复流程；v2+ 共享状态和重连 |
| NFR-3 可扩展性 | MVP 预留 subscription/session/scheduler 字段 |
| NFR-4 安全相关机制 | 凭据不明文落盘、日志不记录完整凭据、管理面独立 |
| NFR-5 运维 | Phase 5 runbook 和可复刻部署 |

## 15. 当前待定事项

1. MVP 第一家 provider 选择。
2. MVP 持久化存储选型：单文件、嵌入式数据库，还是直接上服务端数据库。
3. access credential 的外部格式：opaque key、JWT，或二者组合。初步建议 opaque key，便于吊销。
4. `medical` scope 的 allowlist 具体能力清单。
5. provider 不支持 session ref 时，网关侧上下文保存长度和截断策略。
6. v2 中已有 session 的绑定 subscription 故障时，是立即报错、允许手工迁移，还是提供只读历史。
7. v2+ 是否需要流式响应续传。如果需要，需要额外事件缓存设计。

