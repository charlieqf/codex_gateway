# Codex Gateway 收费与充值后台接口设计方案

日期：2026-05-11

本文描述 Codex Gateway 为收费、充值团队需要提供的后台接口和服务端改造范围。目标是让支付系统负责订单和资金流，Gateway 负责把支付结果转换为模型访问权益、能力开关、额度展示和用量对账；并把"用户注册建账 + opaque key 签发"也收敛到 Gateway 后端，由收费团队站点的注册页调用。

## 1. 结论

P0 实现：

- "用户注册建账"的 s2s 后台接口（subject 创建、查询、key 轮换、停用）。
- "支付成功后开通或变更 entitlement"的后台接口。
- 注册路径自动调用上游 MedEvidence v2 的 s2s "建用户 + 签 key" 接口，将 v2 凭据和 Gateway 凭据封装为 opaque `cgu_live_*` key 返回给收费团队；终端用户只看到 opaque key，永远不直接登 v2。

P0 不在 Gateway 内实现完整钱包扣费。

P1 再实现充值余额 ledger、按 token / image cost unit 扣减、退款冲正和余额过期。原因是当前 Gateway 已有 plan / entitlement / token usage 基础，但没有可审计的钱包账本；如果直接把充值余额塞进现有 token quota，会导致后续退款、对账、余额过期和多产品扣费难以处理。

对外边界：

- 收费团队是订单、支付、退款、发票、价格展示和**终端用户注册页 UI** 的 source of truth。
- Gateway 是 subject、模型凭据、plan / entitlement / capability / usage 的 source of truth。
- MedEvidence v2 是 Gateway 注册路径的**隐藏上游**：v2 账号纯粹是 Gateway 代申请的资源；终端用户、收费团队、客户端都不感知 v2 的存在。v2 必须对外提供 s2s "建用户 + 签 key" 接口，不能依赖运维 CLI / 手工流程。
- 客户端是否能调用模型，最终以 `GET /gateway/credentials/current` 返回的 entitlement 为准，不以支付订单状态为准。

## 2. 当前基础

Gateway 已有以下能力：

- `subjects`：用户主体。
- `access_credentials`：`cgw.*` Gateway API key。
- `plans`：不可变套餐模板，包含 token policy 和 feature policy。
- `entitlements`：用户权益快照，包含 `period_start` / `period_end` / `state`。
- `admin_audit_events`：管理操作审计。
- token budget limiter：按 minute / day / month 记录和限制 token 用量。
- `GET /gateway/credentials/current`：返回 credential、plan、entitlement、token usage、feature policy。
- 生图 capability：`entitlement.feature_policy.capabilities` 可包含 `image_generation`。
- 已有 unified key 工作（`cgu_live_*` opaque 凭据和对应 broker 解析路径，见 `packages/core/src/unified-client-key.ts` 与 admin CLI `unified-key` 命令）。

当前缺口：

- 没有 HTTP 后台 billing API。
- 没有 billing webhook/event 幂等表。
- 没有面向收费团队的 subject 开户 API；现有 unified-key 签发只能通过 admin CLI 手工完成（`provision-medevidence-codex-key.ps1`），不能放在 web 请求路径里供收费后端调用。
- 没有自动化的上游 v2 调用通道：现有 provisioning 脚本假设 v2 key 已经由运维手工签发并落到本地 JSON 文件，无法在生产 web 流量中即时建用户。
- 没有充值钱包 ledger。
- 没有 image generation usage / quota ledger。
- 没有面向收费团队的 usage 对账查询 API。
- `subjects` 表缺少 `external_provider` / `external_user_id` 等外部映射字段，无法基于收费系统的稳定用户 ID 做幂等开户。

## 3. 目标和非目标

### 3.1 P0 目标

1. 提供 service-to-service 后台鉴权。
2. 提供幂等的 subject 开户、查询、key 轮换、停用接口。
3. 注册路径内部自动调用上游 v2 s2s 接口建用户并签 key，把 v2 key 和 Gateway key 包装成 opaque `cgu_live_*` 凭据返回。
4. 提供幂等的 billing entitlement event 写入接口。
5. 支持支付成功后开通、续费、暂停、恢复、取消 entitlement。
6. 支持收费团队查询订单事件是否已被 Gateway 应用。
7. 支持收费团队查询用户当前 entitlement 和历史 entitlement。
8. 支持收费团队按用户、时间范围查询 token usage 聚合数据。
9. 所有写操作进入 `admin_audit_events`，并有 `x-request-id` 便于排障。

### 3.2 P0 非目标

P0 不做以下能力：

- 支付 checkout。
- 价格计算。
- 卡信息、支付账户、发票管理。
- 退款资金流处理。
- Gateway 内钱包余额。
- 按余额实时扣费。
- 客户端直接调用 billing admin API。
- Gateway 自己提供的注册站点 UI：收费团队拥有注册页和账号体系；Gateway 只提供后台 s2s 注册 API。
- 客户端直接看到 v2 凭据：v2 是 Gateway 内部上游，对外完全不可见。
- 团队订阅、多座位 entitlement、一次购买批量开通 N 个 seat。

### 3.3 P1 目标

P1 增加充值和余额：

- credit account / ledger。
- `top_up`、`charge`、`refund`、`adjustment` 账本条目。
- token usage 和 image usage 映射为 cost units。
- 余额查询和账本查询。
- 余额不足时阻断模型请求。
- 退款、拒付、余额过期的冲正规则。

## 4. Subject 开户与上游 v2 集成

### 4.1 架构决策

终端用户的注册旅程：

1. 用户在收费团队站点提交注册表单（邮箱验证、密码或 SSO、captcha 等前置由收费团队站点负责）。
2. 收费后端 s2s 调用 `POST /gateway/admin/billing/v1/subjects`，传入 `external_user_id` 和最小必要信息。
3. Gateway 内部按以下顺序处理（事务化）：
   - 查或创建 `subjects` row（基于 `(provider, external_user_id)` 幂等）。
   - 调用上游 v2 s2s "建用户 + 签 key" 接口，得到 v2 user id 和 v2 key。
   - 落 `upstream_v2_bindings` row。
   - 签发 Gateway 侧 `access_credentials`。
   - 合成 opaque `cgu_live_*` key（封装 Gateway key + v2 key）。
   - 写 `admin_audit_events`。
4. Gateway 把 opaque key 一次性返回给收费后端，收费后端转交终端用户。

**关键决策**：

- **注册 UI 由收费团队拥有**。Gateway 不做面向 C 端的注册站点。
- **Subject 创建逻辑由 Gateway 独占**。即使 UI 在收费侧，所有"建用户、调 v2、签 key、合成 opaque key"步骤都在 Gateway 后端发生；收费团队无法绕过 Gateway 直接动 `subjects` 表或 v2 接口。
- **v2 是隐藏后端资源**。终端用户和客户端永远不直接看到、不直接登录 v2；v2 user id 只存在 `upstream_v2_bindings` 表里，供 broker 阶段解 opaque key 时使用。
- **opaque key 一次性返回**。Gateway 不存 key 原文（仅存 hash 和 prefix）；丢失只能通过轮换得到新 key。

### 4.2 上游 v2 团队需要提供的 s2s 接口（必需）

P0 上线**强依赖**于 MedEvidence v2 提供以下接口。这些是 v2 团队需要交付的工作，已纳入 P0 阻塞项。

#### 4.2.1 建用户 + 签 key

```
POST <v2-internal-base>/internal/users
```

- 必须是 **s2s HTTP 接口**，可以在 Gateway 后端的 web 请求路径里被同步调用；不能是只给运维用的 CLI、手工签发脚本、邮件流程或异步审批工单。
- 入参：Gateway 传入的稳定标识（建议直接传 Gateway `subject_id` 作为 v2 的 external user id；细节由两边联调期敲定）、display name（可选）、scope（可选）。
- 出参：v2 user id、v2 key 原文（v2 key 不必是 v2 用户的 reusable session—— 它将由 Gateway broker 在每次请求时解出并代理）、签发时间、可选过期时间。
- **必须支持幂等**：同一 `(external_user_id, idempotency_key)` 二次调用必须返回与首次相同的 v2 user id 和（如果约定）相同的 v2 key，或者返回明确的 "已存在" 状态，便于 Gateway 在重试或部分失败修复时不会建出第二个 v2 用户。
- 必须返回 JSON 结构化错误，至少区分：参数错误、用户已存在、上游不可用、限流。
- 必须有访问 token / mTLS 鉴权，不能裸奔。
- 必须提供测试环境（联调用），与生产隔离。

#### 4.2.2 吊销 / 停用 key

```
POST <v2-internal-base>/internal/users/{v2_user_id}/keys/{v2_key_id}/revoke
POST <v2-internal-base>/internal/users/{v2_user_id}/disable
```

- 用户在 Gateway 侧 `disable_subject` 时，Gateway 需要级联调用 v2 把对应 key 吊销、用户状态置为 disabled。
- 必须幂等：对已经吊销的资源再次调用返回成功 / no-op。

#### 4.2.3 错误模型与限流

- v2 必须明确返回：`200 created` / `200 already_exists` / `400 invalid_request` / `401/403` / `409 conflict` / `429 too_many_requests` / `5xx`。
- v2 应当对 Gateway 的调用方有独立速率限制（防止 Gateway 出 bug 时压垮 v2），并把限流明确告知 Gateway，Gateway 据此对终端用户做退避或返回 `429 rate_limited`。
- v2 团队需要给 Gateway 提供一个**长期稳定**的 service token / 凭据，并支持滚动轮换（与 Gateway 自己的 billing admin token 类似的双 token 并存模型即可）。

#### 4.2.4 性能与可用性

- v2 建用户接口的 P95 延迟应在 1s 内，超时则 Gateway 走"整体失败、要求收费团队重试"的策略（详见 §4.4）。
- v2 的可用性直接决定 Gateway 注册 API 的可用性；建议 v2 团队为此接口配置独立监控和告警。

### 4.3 内部数据模型变更

`subjects` 表新增列：

```sql
ALTER TABLE subjects ADD COLUMN external_provider TEXT;
ALTER TABLE subjects ADD COLUMN external_user_id TEXT;
ALTER TABLE subjects ADD COLUMN display_name TEXT;
ALTER TABLE subjects ADD COLUMN state TEXT NOT NULL DEFAULT 'active';

CREATE UNIQUE INDEX idx_subjects_external_provider_user
  ON subjects(external_provider, external_user_id)
  WHERE external_provider IS NOT NULL AND external_user_id IS NOT NULL;
```

`state` 取值：`active` / `disabled`。`disabled` 后所有相关 credential 吊销、entitlement 转 `cancelled`、`(external_provider, external_user_id)` 不允许再用于新建 subject。

新增 `upstream_v2_bindings` 表：

```sql
CREATE TABLE upstream_v2_bindings (
  subject_id TEXT PRIMARY KEY,
  v2_user_id TEXT NOT NULL,
  v2_key_id TEXT,
  state TEXT NOT NULL,
  last_synced_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES subjects(id)
);

CREATE UNIQUE INDEX idx_upstream_v2_user
  ON upstream_v2_bindings(v2_user_id);
```

- 一个 Gateway subject 对应一个 v2 user（1:1）。
- `v2_key_id` 是当前 active 的 v2 key id；轮换时更新该字段，旧 key id 写入 `metadata_json` 历史段以便排障。
- 不保存 v2 key 原文；原文只在签发瞬间用于合成 opaque key 并立即丢弃。

opaque key 的合成与解析复用 `packages/core/src/unified-client-key.ts` 的现有路径；P0 需要把"代申请 v2 key 后立即合成 cgu_live_* 并返回"的流程串起来，并保证 v2 key 原文不落 Gateway 任何持久化层。

### 4.4 失败原子性与重试

注册涉及多个步骤（subject row、v2 调用、credential 签发、opaque key 合成、audit）。原则：

- **任何一步失败 → 整体失败**，返回 5xx；不留下"半开"用户。
- 实现上使用一个外层 SQLite 事务，v2 HTTP 调用插在事务"先读 / 准备 → v2 调用 → 写"中间。如果 v2 调用失败，整个事务 rollback，subject row 也不会留。
- 但 v2 调用本身可能"已创建但响应丢失"（HTTP 超时、网络抖动）。处理方式：
  - Gateway 在向 v2 发起请求时，传一个稳定的 `Idempotency-Key`（推荐 `gateway:<subject_id>:create_user`）。
  - 重试时使用同一 key；v2 应该返回 `200 already_exists` 并把同一 v2 user id 返回。
  - Gateway 重试在新事务中重新走一遍流程：如果 v2 返回 already_exists，复用现有 v2 user id 继续后续步骤。
- Gateway 对收费团队的 `Idempotency-Key` 也做幂等：同一 `(provider, external_user_id)` 二次请求按 idempotent replay 处理。
- **`idempotent_replay=true` 不返回 opaque key 原文**（仅返回 key prefix）。收费团队首次响应必须保存 key；丢失只能走 §4.6 轮换。

### 4.5 注册限流与防滥用

Gateway 后端独立的注册限流（不与 webhook 限流共用）：

- 单 IP（取自 `X-Forwarded-For` 第一跳）：默认 60/小时，超过返回 `429 rate_limited`。
- 单 `(provider, external_user_id)`：3 次/小时，防止收费侧 retry 风暴重复建账。
- 全局速率上限：避免拖垮上游 v2。
- 限流参数通过运行时配置可调，并支持 ops 临时调整。

Gateway 不做 captcha / 邮箱验证 / 短信验证——这些防滥用前置在收费团队站点完成。Gateway 的限流是兜底，不是主要防线。

### 4.6 Key 轮换与停用语义

`POST /subjects/{id}/keys`（轮换）：

- 签发新的 Gateway access credential 和（视策略）新的 v2 key。
- 默认立即吊销旧 Gateway credential；`grace_period_seconds > 0` 时旧 credential 多存活该窗口便于客户端切换。
- 旧 v2 key 通过 v2 `revoke` 接口同步吊销；可选保留窗口。
- 写 `admin_audit_events`（`unified-key-issue` + `unified-key-revoke`）。

`POST /subjects/{id}/disable`（停用）：

- subject `state` → `disabled`。
- 所有 active access credential 立即吊销。
- 所有 active / scheduled entitlement 转 `cancelled`（不退费）。
- 调用 v2 `disable_user` 把上游账号一并停用。
- `(provider, external_user_id)` 不允许复用；后续如要重新开户必须使用新 `external_user_id`。
- 历史 usage / billing event / ledger 数据保留用于对账和合规审计。

### 4.7 审计 action

P0 复用现有 audit action 即可，不新增枚举值：

- `subject` 创建：`provision-user` + `unified-key-issue`。
- `subject` key 轮换：`unified-key-issue`（新 key）+ `unified-key-revoke`（旧 key）。
- `subject` 停用：`disable-user` + `unified-key-revoke`。

所有 audit params 加 `source: "billing"`、`provider`、`external_user_id`、`billing_admin_token_slot` 字段，便于按收费链路检索。

## 5. 权限模型

Billing 后台接口使用独立 token，不复用现有 `GATEWAY_ADMIN_MESSAGES_TOKEN`。现有 `/gateway/admin/client-messages` 支持 `GATEWAY_ADMIN_MESSAGES_AUTH=open` 是为了临时只读排障页面；billing 路由涉及资金、权益写入和用户开户，P0 明确不支持 open 模式。

新增后台 token：

```text
GATEWAY_BILLING_ADMIN_TOKEN=<operator-managed-secret>
GATEWAY_BILLING_ADMIN_TOKEN_NEXT=<operator-managed-secret-for-rotation>
```

后台 billing 路由使用：

```http
Authorization: Bearer <GATEWAY_BILLING_ADMIN_TOKEN>
```

鉴权规则：

- `GATEWAY_BILLING_ADMIN_TOKEN` 和可选的 `GATEWAY_BILLING_ADMIN_TOKEN_NEXT` 只允许访问 `/gateway/admin/billing/v1/*`。
- `/gateway/admin/billing/v1/*` 只接受 billing admin token，普通 `cgw.*`、`cmev1.*`、`cgu_live_*` 和 `GATEWAY_ADMIN_MESSAGES_TOKEN` 都不能访问。
- 不接受普通 `cgw.*`、`cmev1.*`、`cgu_live_*`。
- 不进入普通 credential rate limit；但注册路径有自己的限流（§4.5）。
- 不消耗 token quota。
- 所有响应都返回 `x-request-id`。
- 生产环境缺少 `GATEWAY_BILLING_ADMIN_TOKEN` 时，billing admin 路由应返回 `503 service_unavailable` 或启动时拒绝开启该路由。
- token 校验同时接受 current 和 next 两个 token，便于无中断轮换。轮换流程：先配置 `GATEWAY_BILLING_ADMIN_TOKEN_NEXT`，收费系统切换到 next，确认无旧 token 调用后把 next 提升为 current 并删除旧 token。请求日志记录 `billing_admin_token_slot: current | next` 以辅助观测旧 token 是否还在使用。
- 可复用 admin messages 的 timing-safe bearer token 校验模式和 `adminMessagesSecurityHeaders` 安全响应头，或抽成通用 admin security helper；但不能复用 `resolveAdminMessagesAccess` 的 open 模式。
- 路由配置建议使用 `public: true` 跳过普通 credential auth，并显式设置 `skipRateLimit: true`、`skipObservation: true`；同时需要单独的 billing webhook 限流或 WAF 规则防止 webhook 风暴。
- JSON 响应也应设置 `cache-control: no-store`、`x-content-type-options: nosniff`，避免后台结果被缓存。

P1 可升级为 HMAC 签名或 mTLS，但 P0 先用强随机 bearer token，便于快速对接。

上游 v2 团队需要给 Gateway 提供独立的 s2s 凭据，鉴权方式由 v2 团队选择（推荐与 Gateway 对收费团队的方案一致：双 bearer token + 滚动轮换）；该凭据放在 Gateway 的 `GATEWAY_UPSTREAM_V2_TOKEN` 类配置中，不与收费团队共享。

## 6. 幂等设计

所有写接口必须幂等。

请求必须带稳定的 `Idempotency-Key`。该 key 的唯一性以"一个外部业务事件"为粒度，不以订单或订阅本身为粒度。

```http
Idempotency-Key: <provider>:<event_reference>:<event_type>[:<event_discriminator>]
```

格式约束：

- 只允许 ASCII 字符。
- 只允许字符集 `[A-Za-z0-9._:-]`。
- 长度必须 `1..200`。
- 违规返回 `400 invalid_request`，且不创建任何 idempotency row。

推荐模板：

| event_type | 推荐 Idempotency-Key | 说明 |
| --- | --- | --- |
| `create_subject` | `<provider>:<external_user_id>:create_subject` | 同一外部用户的开户事件 |
| `rotate_key` | `<provider>:<subject_id>:rotate_key:<request_id>` | 每次密钥轮换必须不同 |
| `disable_subject` | `<provider>:<subject_id>:disable_subject:<event_id>` | 用户注销 / 风控停用 |
| `purchase` | `stripe:checkout_123:purchase` | 一次 checkout / payment intent 只对应一次购买 |
| `renew` | `stripe:sub_123:renew:2026-06-11` | 同一 subscription 每个续费周期必须不同；优先用 period_start |
| `pause` | `stripe:sub_123:pause:evt_123` | 同一年可能暂停多次，必须带 external_event_id |
| `resume` | `stripe:sub_123:resume:evt_124` | 同一年可能恢复多次，必须带 external_event_id |
| `cancel` | `stripe:sub_123:cancel:evt_125` | 取消、拒付、退款触发的停权事件必须可区分 |
| `notice` | `stripe:evt_123:notice:refund` | 仅记录不应用权益变化时使用，必须配合 `apply_mode: "log_only"` |

如果支付提供方提供全局唯一 webhook event id，可以把它作为最后一段。`renew` 事件如果没有可靠 event id，必须使用 `period_start` 或账期编号。

`event_reference` 可以是 checkout id、payment intent id、subscription id、external user id 或 billing event id；如果它本身不会随重复事件变化，就必须追加 `event_discriminator`。

服务端保存（按业务类型分表）：

- entitlement 事件：`billing_events` 表（见 §7）。
- subject 生命周期事件：复用 `admin_audit_events` + `subjects.external_user_id` 的 unique 约束保证幂等；具体见 §4.4 失败原子性。
- credit 事件（P1）：`credit_ledger_entries` 表。

规则：

- 同一 `Idempotency-Key` + 相同 payload：返回历史结果，`idempotent_replay: true`。
- 同一 `Idempotency-Key` + 不同 payload：返回 `409 idempotency_conflict`。
- apply 过程必须在 SQLite `BEGIN IMMEDIATE` 事务内完成；对包含 v2 调用的 subject create 流程，参见 §4.4 的分阶段策略。
- 所有 4xx 前置校验错误都不创建持久化记录；同一 `Idempotency-Key` 在前置条件修复后可以无冲突重试。
- entitlement 状态预检也属于前置校验，包括已是目标状态、状态不允许、已有 active 但未显式替换、已有 scheduled 但未显式替换等情况。apply service 应在打开写事务和插入 idempotency row 前做只读预检；事务内复核如果仍命中业务状态冲突，必须整体回滚。命中时直接返回 `409 entitlement_already_active` 或 `409 invalid_entitlement_transition`，不创建 `failed` row。
- 只有通过前置校验、成功创建或取得 idempotency row，并进入 apply 阶段后发生 DB 错误或内部异常时，才创建或保留 `status=failed` row。
- 事件已记录但 apply 失败时，同 key 重试只有 payload 相同才允许修复。重试成功后同一 row 由 `failed` 更新为 `applied`，更新 `applied_at`、`error_message=null`、`entitlement_id`；响应返回 `idempotent_replay: false`，因为这是首次实际生效。
- 并发同 key 请求必须使用 `INSERT ... ON CONFLICT DO NOTHING` 或等价模式：事务内先尝试插入 idempotency row；插入失败时读取已有 row，比较 payload hash，相同则返回历史结果，不再执行 apply。
- 不允许先 apply 再写 idempotency row。
- `payload_hash` 应基于 canonical JSON 计算，至少要保证字段顺序不影响 hash。

## 7. P0 数据库改造

### 7.1 `billing_events`

```sql
CREATE TABLE billing_events (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  external_event_id TEXT,
  event_type TEXT NOT NULL,
  apply_mode TEXT NOT NULL DEFAULT 'apply',
  subject_id TEXT NOT NULL,
  plan_id TEXT,
  entitlement_id TEXT,
  status TEXT NOT NULL,
  amount_minor INTEGER,
  currency TEXT,
  period_kind TEXT,
  period_start TEXT,
  period_end TEXT,
  applied_at TEXT,
  error_message TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_billing_events_provider_order_type
  ON billing_events(provider, external_order_id, event_type);

CREATE INDEX idx_billing_events_subject_created
  ON billing_events(subject_id, created_at DESC);
```

状态：

- `applied`
- `failed`
- `ignored`

唯一约束只保留 `idempotency_key`。`provider, external_order_id, event_type` 只能是普通 index，因为同一订阅或同一订单族可能多次续费、暂停、恢复或取消。

`ignored` 只允许在请求明确设置 `apply_mode: "log_only"` 时产生。未知 `event_type` 必须返回 `400 invalid_event_type`，不能自动记为 `ignored`。

`amount_minor` 和 `currency` 在 P0 仅用于审计、对账和排障留痕，不参与 Gateway entitlement、quota、余额或扣费决策。

### 7.2 `subjects` 表扩展

```sql
ALTER TABLE subjects ADD COLUMN external_provider TEXT;
ALTER TABLE subjects ADD COLUMN external_user_id TEXT;
ALTER TABLE subjects ADD COLUMN display_name TEXT;
ALTER TABLE subjects ADD COLUMN state TEXT NOT NULL DEFAULT 'active';

CREATE UNIQUE INDEX idx_subjects_external_provider_user
  ON subjects(external_provider, external_user_id)
  WHERE external_provider IS NOT NULL AND external_user_id IS NOT NULL;
```

- 历史 subjects（由 admin CLI 或 provisioning 脚本创建的）`external_provider` / `external_user_id` 为 NULL，不冲突。
- 新增 unique index 是部分索引（partial），SQLite 3.8.0+ 支持。

### 7.3 `upstream_v2_bindings`

```sql
CREATE TABLE upstream_v2_bindings (
  subject_id TEXT PRIMARY KEY,
  v2_user_id TEXT NOT NULL,
  v2_key_id TEXT,
  state TEXT NOT NULL,
  last_synced_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES subjects(id)
);

CREATE UNIQUE INDEX idx_upstream_v2_user
  ON upstream_v2_bindings(v2_user_id);
```

`state` 取值：`active` / `disabled` / `pending`（首次调用 v2 期间）。

## 8. P0 后台接口

所有 P0 billing admin API 都放在 `/gateway/admin/billing/v1/*`。P0 ship 后，`/v1` 已有 endpoint 只能新增可选请求字段、可选响应字段或新的非破坏性 enum；不能改变已有字段语义、必填集合、状态码、错误码含义或幂等语义。P1 可以在 `/v1` 增加独立的新 endpoint，例如 `credit-events`、balance、ledger；任何会破坏既有 endpoint contract 的钱包、图片用量或扣费语义变更都必须进入 `/v2`。

### 8.1 创建 subject

```http
POST /gateway/admin/billing/v1/subjects
Authorization: Bearer <billing_service_token>
Idempotency-Key: medevidence_billing:bu_abc123:create_subject
Content-Type: application/json
```

请求：

```json
{
  "provider": "medevidence_billing",
  "external_user_id": "bu_abc123",
  "display_name": "Alice",
  "scope_allowlist": ["code"],
  "metadata": {
    "signup_source": "web"
  }
}
```

字段：

| 字段 | P0 要求 | 说明 |
| --- | --- | --- |
| `provider` | 必填 | 收费系统名 |
| `external_user_id` | 必填 | 收费系统稳定用户 ID；与 `provider` 组成唯一对 |
| `display_name` | 可选 | 仅用于 Gateway 内部审计/排障，不下发客户端 |
| `scope_allowlist` | 可选 | Gateway credential 允许的 scope；缺省取系统默认（`["code"]`） |
| `metadata` | 可选 | 限制同 entitlement event：禁止落库邮箱、手机号、卡号等敏感字段；JSON ≤ 4 KB |

成功响应：

```json
{
  "created": true,
  "idempotent_replay": false,
  "subject": {
    "id": "medevidence-xxx",
    "provider": "medevidence_billing",
    "external_user_id": "bu_abc123",
    "display_name": "Alice",
    "scope_allowlist": ["code"],
    "state": "active",
    "created_at": "2026-05-11T00:00:00.000Z"
  },
  "credential": {
    "id": "ckey_xxx",
    "key": "cgu_live_AAAAAAAAAAAA...",
    "key_prefix": "cgu_live_AAAA",
    "issued_at": "2026-05-11T00:00:00.000Z",
    "expires_at": null
  }
}
```

注意：

- `credential.key` 是 opaque key 原文，仅在本次响应返回。
- `idempotent_replay=true` 时不返回 `credential.key` 原文，只返回 `key_prefix`。

### 8.2 查询 subject

```http
GET /gateway/admin/billing/v1/subjects/{subject_id}
GET /gateway/admin/billing/v1/subjects?provider=...&external_user_id=...
```

响应包含 subject 信息和 active credentials（不含 key 原文）。

### 8.3 轮换 key

```http
POST /gateway/admin/billing/v1/subjects/{subject_id}/keys
Idempotency-Key: <provider>:<subject_id>:rotate_key:<request_id>
```

请求：

```json
{
  "reason": "user_lost_key",
  "revoke_previous": true,
  "grace_period_seconds": 0
}
```

行为见 §4.6。响应包含新 opaque key 原文。

### 8.4 停用 subject

```http
POST /gateway/admin/billing/v1/subjects/{subject_id}/disable
Idempotency-Key: <provider>:<subject_id>:disable_subject:<event_id>
```

行为见 §4.6。

### 8.5 Plan 查询

收费团队需要知道可售套餐和 Gateway `plan_id` 的映射。

```http
GET /gateway/admin/billing/v1/plans
Authorization: Bearer <billing_service_token>
```

响应：

```json
{
  "plans": [
    {
      "id": "plan_paid_monthly_v1",
      "display_name": "MedCode Pro Monthly",
      "state": "active",
      "scope_allowlist": ["code"],
      "token_policy": {
        "tokens_per_minute": 100000,
        "tokens_per_day": 5000000,
        "tokens_per_month": 100000000,
        "max_prompt_tokens_per_request": 200000,
        "max_total_tokens_per_request": 300000
      },
      "feature_policy": {
        "capabilities": ["chat", "tools", "image_generation"]
      }
    }
  ]
}
```

P0 不允许收费团队通过 HTTP 创建 plan。Plan 仍由 Gateway 运维通过 admin CLI 或迁移脚本创建，避免支付系统误改套餐模板。

`token_policy` 只用于收费团队展示套餐额度和对账，不允许收费团队在购买请求里覆盖 plan policy。真正生效的 quota 仍来自 Gateway plan / entitlement snapshot。

### 8.6 写入 billing entitlement event

```http
POST /gateway/admin/billing/v1/entitlement-events
Authorization: Bearer <billing_service_token>
Idempotency-Key: stripe:checkout_123:purchase
Content-Type: application/json
```

请求：

```json
{
  "event_type": "purchase",
  "apply_mode": "apply",
  "provider": "stripe",
  "external_order_id": "pay_123",
  "external_event_id": "evt_123",
  "subject_id": "medevidence-xxx",
  "plan_id": "plan_paid_monthly_v1",
  "period_kind": "monthly",
  "period_start": "2026-05-11T00:00:00.000Z",
  "period_end": "2026-06-11T00:00:00.000Z",
  "replace_current": false,
  "replace_scheduled": false,
  "amount_minor": 1999,
  "currency": "USD",
  "metadata": {
    "sku": "medcode_pro_monthly"
  }
}
```

字段说明：

| 字段 | P0 要求 | 说明 |
| --- | --- | --- |
| `event_type` | 必填 | `purchase` / `renew` / `pause` / `resume` / `cancel` / `notice`；`notice` 只能配合 `apply_mode: "log_only"` |
| `apply_mode` | 可选 | 只接受 `apply` / `log_only`，默认 `apply`；其他值返回 `400 invalid_request` 且不创建 `billing_events` row；`log_only` 只记录 billing event，不改变 entitlement |
| `provider` | 必填 | 支付提供方或收费系统名，例如 `stripe`、`medevidence_billing` |
| `external_order_id` | 必填 | 收费系统订单 ID |
| `external_event_id` | 可选 | webhook 事件 ID |
| `subject_id` | 必填 | Gateway subject id，必须已通过 §8.1 完成开户 |
| `plan_id` | `purchase` / `renew` 必填 | Gateway plan id |
| `period_kind` | `purchase` / `renew` 必填 | `monthly` / `one_off` / `unlimited` |
| `period_start` | 可选 | 缺省为服务端当前时间；传入时必须为带明确 offset 的 RFC 3339 / ISO 8601 字符串 |
| `period_end` | 按 period kind 决定 | `unlimited` 可为空 |
| `replace_current` | 可选 | 默认 `false`，是否替换当前 active entitlement；不隐式取消 scheduled 或 paused |
| `replace_scheduled` | 可选 | 默认 `false`，仅当调用方明确要清除未来 scheduled entitlement 时设置为 `true` |
| `replace_paused` | 可选 | 默认 `false`，仅当 `replace_current=true` 时有效；是否同时取消 paused entitlement |
| `entitlement_id` | 状态变更事件可选 | 指定要暂停、恢复或取消的 entitlement |
| `reason` | 状态变更事件可选 | 审计原因 |
| `amount_minor` | 可选 | 订单金额，最小货币单位；P0 仅审计留痕，不参与权益决策 |
| `currency` | 可选 | ISO 货币代码；P0 仅审计留痕，不参与权益决策 |
| `metadata` | 可选 | 不包含敏感支付信息 |

`metadata` 必须做 schema 校验和敏感字段过滤。P0 不允许落库卡号、CVV、支付账户完整标识、用户邮箱、手机号、账单地址、发票抬头等支付或个人敏感信息；需要排障时只保存 provider、SKU、订单短 ID、非敏感渠道标识。

时间格式约束：

- `period_start` / `period_end` 必须是 RFC 3339 / ISO 8601 时间字符串，并包含明确 offset，推荐 UTC `Z`。
- Gateway 拒绝没有 offset 的本地时间字符串，例如 `2026-05-11T00:00:00`。
- `period_end` 必须晚于 `period_start`；不满足时返回 `400 invalid_period`。

成功响应：

```json
{
  "applied": true,
  "idempotent_replay": false,
  "billing_event": {
    "id": "bevt_xxx",
    "provider": "stripe",
    "external_order_id": "pay_123",
    "event_type": "purchase",
    "apply_mode": "apply",
    "status": "applied"
  },
  "subject_id": "medevidence-xxx",
  "plan": {
    "id": "plan_paid_monthly_v1",
    "display_name": "MedCode Pro Monthly"
  },
  "entitlement": {
    "id": "ent_xxx",
    "state": "active",
    "period_kind": "monthly",
    "period_start": "2026-05-11T00:00:00.000Z",
    "period_end": "2026-06-11T00:00:00.000Z"
  },
  "cancelled_entitlement_ids": []
}
```

`apply_mode=log_only` 成功响应：

```json
{
  "applied": false,
  "idempotent_replay": false,
  "billing_event": {
    "id": "bevt_xxx",
    "provider": "stripe",
    "external_order_id": "pay_123",
    "event_type": "notice",
    "apply_mode": "log_only",
    "status": "ignored",
    "applied_at": null
  },
  "subject_id": "medevidence-xxx"
}
```

所有成功响应都必须回显 `billing_event.apply_mode` 和 `billing_event.status`。

### 8.7 查询 billing event

```http
GET /gateway/admin/billing/v1/entitlement-events/{idempotency_key}
GET /gateway/admin/billing/v1/entitlement-events?provider=stripe&external_order_id=pay_123
GET /gateway/admin/billing/v1/entitlement-events?subject_id=medevidence-xxx&limit=50&cursor=...
```

分页规则：

- `limit` 默认 50，最大 200。
- `cursor` 使用服务端返回的不透明字符串。
- 响应包含 `next_cursor`，没有下一页时为 `null`。

### 8.8 查询用户 entitlement

```http
GET /gateway/admin/billing/v1/users/{subject_id}/entitlements?limit=50&cursor=...
```

`history` 元素结构与 `current` 相同，按 `period_start DESC` 排序，分页。

### 8.9 查询 usage 对账

```http
GET /gateway/admin/billing/v1/usage?subject_id=...&from=...&to=...&group_by=day&limit=90&cursor=...
```

`subject_id`、`from`、`to` 必填。单次查询时间范围 ≤ 90 天。`group_by` 支持 `day` / `month` / `none`。`limit` 默认 90，最大 200。

`estimated_tokens` 表示 provider 未返回 usage 时，Gateway 按 token estimator 或 `missingUsageCharge` 策略记录的估算量。

## 9. Event apply 规则

### 9.1 Subject 生命周期

`create_subject`：详见 §4。校验 `provider` + `external_user_id` 唯一；不存在则进入"建 subject + 调 v2 + 签 credential + 合 opaque key"流程，失败整体回滚；同 key 重试做 idempotent replay。

`rotate_key`：在事务里签发新 Gateway credential，调 v2 签发新 v2 key 并把旧 v2 key 吊销；如果 `revoke_previous=true` 立即吊销旧 Gateway credential，否则在 `grace_period_seconds` 后通过 scheduled job 吊销。

`disable_subject`：把 subject `state` 置为 `disabled`，吊销所有 active credential，把 entitlement 全部转 `cancelled`，调 v2 `disable_user`。所有步骤失败整体回滚。

### 9.2 `purchase`

行为：

1. 校验 `subject_id` 存在且 `state=active`。
2. 校验 `plan_id` 存在且 `state=active`。
3. 如果 `replace_current=false` 且用户已有 active entitlement，返回 `409 entitlement_already_active`，由收费团队决定是否重试并显式替换。
4. 如果用户已有 scheduled entitlement，默认不取消；只有 `replace_scheduled=true` 时才取消。如果新 entitlement 会与既有 scheduled entitlement 冲突（`[period_start, period_end]` 重叠）且未传 `replace_scheduled=true`，返回 `409 invalid_entitlement_transition`。
5. 如果 `replace_current=true`，只取消当前 active entitlement。
6. paused entitlement 默认不取消；只有 `replace_paused=true` 时才取消 paused entitlement。
7. 创建新的 entitlement。
8. 写 `billing_events`，并在响应中返回被取消的 entitlement id 列表。
9. 写 `admin_audit_events`。

审计 action P0 复用现有 `entitlement-grant`。在 audit params 中记录：

```json
{
  "source": "billing",
  "billing_event_id": "bevt_xxx",
  "provider": "stripe",
  "external_order_id": "pay_123",
  "event_type": "purchase"
}
```

### 9.3 `renew`

行为：

1. 校验用户当前 entitlement；如果没有 current entitlement，返回 `404 entitlement_not_found`，要求收费团队改发 `purchase`，P0 不把 `renew` 自动提升为 `purchase`。
2. paused 用户不支持续期：返回 `404 entitlement_not_found`，要求先发 `resume`。
3. 按请求里的 `period_start` / `period_end` 创建新的 entitlement。
4. P0 不直接调用现有 `renewEntitlement`，因为当前 `RenewEntitlementInput` 只接受 `subjectId` / `planId` / `replace` / `now`，不能表达收费团队传入的显式周期。
5. P0 的 `renew` 实现为 billing apply service 内部的显式周期 grant：校验当前 entitlement 后，调用可接受 `periodStart` / `periodEnd` 的 grant 路径创建下一周期 entitlement。
6. 如果 `replace_current=true`，先按 `purchase` 的替换规则取消 active entitlement；如果 `replace_scheduled=true`，取消 scheduled entitlement；再创建新 entitlement。
7. 写 billing event 和 audit。

说明：P0 不自动计算自然月周期；收费团队应传明确的周期开始和结束时间。

审计 action P0 复用现有 `entitlement-renew` 或 `entitlement-grant`，并在 audit params 中标记 `source: "billing"`、`billing_event_id` 和外部订单信息。

### 9.4 `pause`

1. 用 `entitlement_id` 找目标 entitlement；如果未传，则找 subject 当前 active entitlement。
2. 调用现有 pause transition。
3. 写 billing event 和 audit。

审计 action 复用现有 `entitlement-pause`，audit params 标记 `source: "billing"`。

### 9.5 `resume`

1. 用 `entitlement_id` 找目标 entitlement；如果未传，则找 subject 最近 paused entitlement。
2. 调用现有 resume transition。
3. 写 billing event 和 audit。

审计 action 复用现有 `entitlement-resume`，audit params 标记 `source: "billing"`。

### 9.6 `cancel`

1. 用 `entitlement_id` 找目标 entitlement；如果未传，则找 subject 当前 active entitlement。
2. 调用现有 cancel transition。
3. 写 billing event 和 audit。

审计 action 复用现有 `entitlement-cancel`，audit params 标记 `source: "billing"`。

P0 不建议把 `refund` 自动解释为 `cancel`。退款后的 Gateway 权益处理应由收费团队明确发送 `cancel` 或 `pause` 事件。

### 9.7 `notice` / `apply_mode=log_only`

规则：

1. `event_type=notice` 必须设置 `apply_mode: "log_only"`。
2. `apply_mode="log_only"` 不调用 grant / pause / resume / cancel。
3. billing event status 写为 `ignored`。
4. 未知 `event_type` 必须返回 `400 invalid_event_type`。
5. 未知 `apply_mode` 必须在字段校验阶段返回 `400 invalid_request`，且不创建 `billing_events` row。

## 10. 错误响应

后台 billing API 使用固定错误体：

```json
{
  "error": {
    "code": "idempotency_conflict",
    "message": "Idempotency key was already used with a different payload.",
    "request_id": "req-..."
  }
}
```

常见错误码：

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `invalid_request` | 请求字段缺失或格式错误，包括未知 enum、metadata 超大、idempotency-key 非法 |
| 400 | `invalid_event_type` | `event_type` 不支持 |
| 400 | `invalid_period` | `period_start` / `period_end` 缺失、顺序错误或与 `period_kind` 不匹配 |
| 400 | `invalid_external_user_id` | `external_user_id` 长度或字符不合法 |
| 401 | `missing_credential` | 缺少 billing admin token |
| 401 | `invalid_credential` | billing admin token 错误 |
| 404 | `subject_not_found` | 用户不存在或已 disabled |
| 404 | `plan_not_found` | plan 不存在或非 active |
| 404 | `entitlement_not_found` | entitlement 不存在或不在可操作状态 |
| 404 | `credential_not_found` | 指定 key 不存在 |
| 409 | `subject_already_exists` | 同 `(provider, external_user_id)` 已存在但 payload 与历史不一致 |
| 409 | `idempotency_conflict` | 幂等 key 与历史 payload 冲突 |
| 409 | `entitlement_already_active` | `replace_current=false` 但用户已有 active entitlement |
| 409 | `invalid_entitlement_transition` | entitlement 状态流转不允许，包括 scheduled entitlement 冲突但未传 `replace_scheduled=true` |
| 429 | `rate_limited` | 触发注册或 webhook 限流 |
| 502 | `upstream_unavailable` | 上游 v2 调用失败（注册路径专用）；按指数退避重试同 key |
| 503 | `service_unavailable` | billing admin 未配置或 store 不支持 |

所有错误都带 `x-request-id`。

## 11. P1 充值钱包设计

P1 新增钱包账本，不复用 entitlement 表直接存余额。

### 11.1 表结构草案

```sql
CREATE TABLE credit_ledger_entries (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  external_order_id TEXT,
  entry_type TEXT NOT NULL,
  unit_kind TEXT NOT NULL,
  units_delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  amount_minor INTEGER,
  currency TEXT,
  expires_at TEXT,
  related_request_id TEXT,
  related_entry_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_credit_ledger_subject_created
  ON credit_ledger_entries(subject_id, created_at DESC);
```

`entry_type`：

- `top_up`
- `charge`
- `refund`
- `adjustment`
- `expire`

`unit_kind`：

- `token`
- `image`
- `credit`

建议 P1 使用统一 `credit`，再通过价格表把 token / image 转换成 credit units。否则不同模型和图片尺寸的价格变化会导致账本难以维护。

`units_delta` 必须使用整数最小精度，不能用浮点。建议定义 `1 credit = 1,000,000 micro_credits`，所有充值、扣费、退款和余额都以 micro-credit 整数入账。SQLite `INTEGER` 是 64-bit signed，最大约 `9.2e18` micro-credits，约 `9.2e12` credits，足够 P1 钱包账本使用。

### 11.2 P1 接口

以下 P1 路径是新增 endpoint，可以作为 additive contract 放在 `/v1` 下；它们不能修改 §8 已有 P0 endpoint 的字段语义、必填集合、错误语义或幂等语义。

```http
POST /gateway/admin/billing/v1/credit-events
GET /gateway/admin/billing/v1/users/{subject_id}/balance
GET /gateway/admin/billing/v1/users/{subject_id}/ledger
```

### 11.3 P1 请求扣费集成

文本模型：

1. 请求开始时检查余额或套餐 quota。
2. 请求结束后按 provider usage 计算 cost units。
3. 写 `charge` ledger。
4. provider usage 缺失时，按现有 `missingUsageCharge` 策略处理。

图片模型：

1. 新增 image usage event。
2. 按内部模型、尺寸、质量、张数计算 cost units。
3. 成功后写 `charge` ledger。
4. 失败不扣费，除非未来有上游已计费但 Gateway 失败的特殊规则。

并发注意：

- 扣余额必须在事务里做余额检查和 ledger 写入。
- 多进程或多 VM 前，需要 reservation 或数据库锁策略，避免余额超扣。

## 12. 我们需要做的事情

### 12.1 P0 实现任务

1. **Core types**
   - 新增 billing event 类型。
   - 新增 subject lifecycle event 类型（create / rotate-key / disable）。
   - 新增 billing store interface（含 subject CRUD、v2 binding）。
   - 新增 billing error codes（含 subject_already_exists、upstream_unavailable）。
   - 扩展 billing admin request / response DTO，包含 `apply_mode`、分页 cursor、幂等 replay 结果、opaque key 一次性返回标记。

2. **SQLite store**
   - migration 1：扩展 `subjects` 表，新增 `external_provider` / `external_user_id` / `display_name` / `state` 列及 partial unique index。
   - migration 2：新建 `upstream_v2_bindings` 表。
   - migration 3：新建 `billing_events` 表。
   - 实现 insert / get / list billing event。
   - 实现按 subject 查询 entitlement history。
   - 实现 usage 聚合查询。
   - 实现 subject 创建 / 查询 / 轮换 / 停用的 store 方法。
   - 实现 `UNIQUE(idempotency_key)` 并发保护；`provider, external_order_id, event_type` 只建普通 index。

3. **上游 v2 HTTP client**
   - 新建 `packages/upstream-v2-client`（或同等位置）。
   - 接口：`createUser`、`revokeKey`、`disableUser`。
   - 内置重试（仅对幂等场景）、超时、限流退避。
   - 配置：`GATEWAY_UPSTREAM_V2_BASE_URL`、`GATEWAY_UPSTREAM_V2_TOKEN`、`GATEWAY_UPSTREAM_V2_TIMEOUT_MS`。
   - 错误映射：v2 5xx / 429 → `upstream_unavailable`；v2 已存在 → 走 idempotent replay 路径。
   - 测试 mock：本地用 `nock`-style 测试桩，CI 不依赖真实 v2。

4. **Gateway routes**
   - 新增 billing admin auth hook。
   - 新增 `/subjects` POST / GET / 按 query 查询。
   - 新增 `/subjects/{id}/keys` POST（轮换）。
   - 新增 `/subjects/{id}/disable` POST（停用）。
   - 新增 `/plans` GET。
   - 新增 `/entitlement-events` POST 和查询。
   - 新增 `/users/{subject_id}/entitlements` GET。
   - 新增 `/usage` GET。
   - billing 路由不支持 open 模式，不接受普通 Gateway credential。
   - billing 路由设置 `public: true`、`skipRateLimit: true`、`skipObservation: true`，并添加单独 webhook 限流策略；注册路径走独立 IP / external_user_id 限流。
   - 所有列表查询实现 `limit` / `cursor`。

5. **Subject apply service**
   - 封装 create / rotate / disable。
   - 与上游 v2 client 串联，分阶段事务（参见 §4.4）。
   - opaque key 合成复用 `unified-client-key.ts` 的现有路径；v2 key 原文不持久化。
   - 写 `admin_audit_events`，复用现有 `provision-user` / `unified-key-issue` / `unified-key-revoke` / `disable-user`，在 params 标记 `source: "billing"`。

6. **Entitlement apply service**
   - 封装 purchase / renew / pause / resume / cancel。
   - 封装 notice / `apply_mode=log_only` 的短路路径，只写 billing event，不改变 entitlement。
   - 所有写操作事务化。
   - 写 `admin_audit_events`，复用现有 entitlement action，并在 params 中标记 `source: "billing"`。
   - 幂等 replay 和 conflict 判断。
   - `renew` 使用显式周期 grant 语义，不直接依赖现有 `renewEntitlement`。
   - `replace_current` 默认 false；scheduled 只有 `replace_scheduled=true` 才替换；paused 只有 `replace_paused=true` 才替换。

7. **Runtime config**
   - `GATEWAY_BILLING_ADMIN_TOKEN`。
   - `GATEWAY_BILLING_ADMIN_TOKEN_NEXT`，用于无中断滚动轮换。
   - `GATEWAY_UPSTREAM_V2_*` 系列上游配置。
   - production validation。
   - 不把 token 打到日志；请求日志记录 `billing_admin_token_slot`。
   - token 旋转/失效流程：支持先配置新 token、灰度收费系统切换、再移除旧 token；P0 可先通过维护窗口重启实现。

8. **Tests**
   - billing admin auth 成功和失败。
   - subject create 成功 / 已存在 idempotent replay / `(provider, external_user_id)` payload 冲突。
   - subject create 在 v2 调用失败时整体回滚，并能在 v2 恢复后用同 key 重试成功。
   - opaque key 仅首次响应返回原文；replay 不返回原文。
   - subject rotate / disable 状态机和级联吊销。
   - 注册限流（IP / external_user_id / 全局）。
   - purchase / renew / pause / resume / cancel 状态流转。
   - 幂等 replay 和 conflict。
   - 并发同 key 只 apply 一次。
   - `apply_mode=log_only` 不改变 entitlement。
   - replace 默认 false、`replace_scheduled` 和 `replace_paused` 行为。
   - plan / subject / entitlement 不存在。
   - usage 查询不返回敏感内容。
   - metadata schema 拒绝支付敏感字段。
   - billing route 不接受普通 `cgw.*` key。

9. **Docs**
   - 对外：`docs/codex-gateway-billing-integration-guide.zh-CN.md`（已发收费团队）。
   - 对 v2 团队：单独发出 §4.2 提到的 s2s 接口需求，附测试环境对接细节。
   - 运维配置说明。
   - 回滚和排障说明。

### 12.2 P1 实现任务

1. credit ledger migration。
2. top-up / refund / adjustment API。
3. balance / ledger query API。
4. token usage -> cost units 价格表。
5. image usage event 和 cost units。
6. 请求扣费和余额不足错误。
7. 余额 reservation 或事务锁。
8. 对账报表和退款冲正规则。

## 13. 收费/充值团队需要做的事情

完整 checklist 见对外文档 `docs/codex-gateway-billing-integration-guide.zh-CN.md`。这里仅记要点：

### 13.1 P0

1. 注册站点 UI：邮箱验证、密码或 SSO、captcha；提交后调 `POST /subjects` 拿 opaque key；展示一次后保存提醒。
2. 用户 ID 映射：收费系统 `user_id` ↔ Gateway `subject_id`，由收费团队维护。
3. SKU ↔ `plan_id` 映射。
4. 支付订单系统、provider webhook、订单状态机。
5. 周期计算：传明确的 `period_start` / `period_end`。
6. 调用 entitlement event：幂等 key 稳定唯一；后台 token 仅在收费后端使用。
7. 重试策略：按 §10 错误码分支处理。
8. 退款与状态变更：显式发 `cancel` / `pause` / `resume`，不假设自动级联。
9. 账号注销：调用 `disable_subject`。
10. 对账与排障。
11. 客户端展示边界：模型可用性以 `/gateway/credentials/current` 为准。

### 13.2 P1

充值订单、价格表、credit event、余额展示、低余额流程、退款冲正、对账。

## 14. 上线计划

### Phase A：P0 开发

- 在本地和测试 VM 完成 billing admin API。
- 使用临时 billing admin token 测试。
- 使用 v2 团队提供的测试环境跑通 subject create → v2 调用 → opaque key 合成全链路。
- 用 fake payment events 验证 entitlement 变化。

### Phase B：收费团队联调

- 双方确认 `plan_id` 和 SKU 映射。
- 收费团队搭好注册页 Mock，跑通"建账 → 拿 opaque key → fake payment → entitlement 开通"。
- 收费团队后端在测试环境接收支付 provider webhook 后，转发支付事件到 Gateway billing API。
- Gateway 返回 `applied` 后，客户端调用 `/gateway/credentials/current` 验证 entitlement。

### Phase C：生产灰度

- 生产配置 `GATEWAY_BILLING_ADMIN_TOKEN`、`GATEWAY_UPSTREAM_V2_TOKEN`。
- v2 团队完成生产环境对接。
- 先只允许少量内部订单。
- 每天核对：
  - subject 注册数（与收费团队登记数对账）。
  - upstream v2 调用成功率与延迟。
  - billing event 数量。
  - active entitlement 数量。
  - usage 聚合。
  - admin audit。

### Phase D：严格模式

当收费链路稳定后，再考虑：

```text
GATEWAY_REQUIRE_ENTITLEMENT=1
```

切换前 checklist：

- 盘点所有 active `cgw.*` credential 是否都有 active entitlement。
- 对仍走 `entitlementAccessForSubject.status === "legacy"` 的存量用户，先批量补 entitlement 或明确停用计划。
- 验证 `/gateway/credentials/current` 对所有付费用户都返回 plan / entitlement。
- 客户端已处理 `plan_inactive`、`plan_expired`、`forbidden_scope`、`rate_limited`。
- 收费团队已能重放 billing event 并完成订单到 entitlement 对账。
- 灰度切换时保留回滚方案，可以恢复 `GATEWAY_REQUIRE_ENTITLEMENT=0`。

切换前需要单独通知客户端团队和收费团队。

## 15. 开放问题

1. **充值余额和套餐 quota 是否同时存在？**
   - P1 需要定义优先级，例如先用套餐 quota，超出后用余额。

2. **图片如何计费？**
   - P1 需要定义 image cost units，至少按 model / size / quality 区分。

3. **团队订阅和座位如何建模？**
   - 代码里已有 `Plan.teamPoolId` 和 `Entitlement.teamSeatId`，但 P0 billing event 只支持单 subject entitlement。
   - 团队购买一次开 N 个座位，需要单独设计 team subscription、seat assignment、批量 entitlement grant 和 seat 回收。
   - P0 不允许通过 `metadata` 驱动座位开通；metadata 只能留痕，不能承载权益 apply 语义。

4. **是否需要对账导出文件？**
   - P0 提供 API 查询；如财务需要 CSV，后续加 admin CLI 或导出接口。

5. **v2 outage 期间能否注册？**
   - P0 选择"整体失败、收费团队重试"。是否需要降级方案（例如先建 Gateway subject、v2 异步补创建并暂时拒绝模型调用）由 v2 SLA 决定。

6. **v2 user 与 Gateway subject 的生命周期是否完全一致？**
   - 当前设计：1:1，Gateway disable 时级联 v2 disable。
   - 如果用户在 Gateway 注销后又在收费侧重新注册，是新建 v2 user 还是复用旧 v2 user？建议新建（更干净），但 v2 团队需要确认是否支持同一 external user id 多个用户记录的生命周期。

7. **opaque key 是否支持单 subject 多把 active key？**
   - P0 默认单把 active key；若客户端需要桌面端、CLI 端各持一把，需要扩展轮换语义和 v2 多 key 支持。

8. **用户注销时数据保留多久？**
   - 是否需要满足 GDPR / 个保法的数据删除请求？目前 P0 选择保留历史 usage / ledger 用于对账；删除请求需要单独走运维流程。

9. **v2 team SLA**：v2 建用户接口的可用性目标、P95 延迟、限流额度，需要 v2 团队明确并写入对接协议。

## 16. 已决议事项备忘

为方便后续团队成员快速对齐，记录已经达成共识的关键决议：

- **用户 ID 映射**：收费系统 `external_user_id` 与 Gateway `subject_id` 通过 `POST /subjects` 创建时绑定，收费团队维护双向映射；下单、状态变更、扣费时一律使用 `subject_id`。
- **注册 UI 归属**：注册页 UI、邮箱验证、密码/SSO、captcha 等防滥用前置都在收费团队站点。Gateway 不提供面向 C 端的注册页。
- **用户创建归属**：Gateway 后端独占用户建账逻辑（subject row、上游 v2 调用、credential 签发、opaque key 合成、审计）。收费团队通过 s2s API 触发，不直接操作 Gateway 数据库，也不直接调用 v2。
- **凭据形态**：终端用户只持有 opaque `cgu_live_*` key；Gateway 内部和 v2 凭据组成对外不可见。
- **购买时用户不存在**：Gateway 返回 `404 subject_not_found`；不做"购买即开户"。注册必须在下单前完成。
- **v2 角色**：MedEvidence v2 对终端用户和收费团队完全隐藏；v2 账号是 Gateway 代申请的资源。v2 必须对外提供 s2s "建用户 + 签 key" 接口（不是给运维脚本用的 CLI/手工流程，必须能在 web 请求路径里被 Gateway backend 调用），并提供吊销 / 停用接口、错误模型、限流告知、滚动轮换的 service token。这是 P0 上线的硬依赖。
- **opaque key 一次性返回**：原文只在 `create_subject` 或 `rotate_key` 首次响应中返回；Gateway 不持久化原文，丢失只能轮换。
- **失败原子性**：注册涉及多步骤时整体回滚，要求 v2 接口支持幂等以便 Gateway 在重试时复用已建用户，不留半开账号。
