# MedEvidence 收费/充值 API 集成指南

日期：2026-05-11
适用：收费、充值团队后端开发与产品

本文给出 MedEvidence 提供给收费/充值团队的后台 API contract、事件语义、双方分工、上线节奏和待对齐问题。

- **P0** 实现"用户注册建账"和"支付成功后开通或变更模型访问权益"，覆盖 subject 开户、plan、entitlement、capability、token usage 对账。
- **P1** 在 P0 基础上增加预付费余额账本、token / image 按 cost unit 扣减、退款冲正、余额过期，并将 image usage 接入对账。

P0 和 P1 共用同一份 `/v1` contract，P1 仅做 additive 扩展（新增 endpoint、新增可选字段），不改动 P0 已有 endpoint 的字段语义、必填集合或错误码语义。

## 1. 集成边界

MedEvidence 把用户注册、支付结果、用量记录和余额扣减统一管理，不承接资金流，也不直接提供面向终端用户的网页。

- **收费/充值团队**：拥有终端用户的账号体系（注册、登录、找回密码、账户中心）、订单、支付、退款、发票、SKU 和价格展示。注册页和支付页都在收费团队站点。
- **MedEvidence**：拥有 `subject_id`、模型访问凭据（opaque `cgu_live_*` key）、plan、entitlement、capability（如 `chat` / `tools` / `image_generation`）、token usage、image usage、credit ledger。MedEvidence 暴露 s2s 后台 API 由收费/充值团队后端调用。
- 终端用户在收费团队站点注册时，收费后端调用 MedEvidence `create_subject` API 拿到 `subject_id` 和 opaque key；用户用这把 key 直连模型 API。
- 客户端是否能调用模型，最终以 `GET /gateway/credentials/current` 返回的 entitlement 和余额状态为准，不以支付订单状态为准。
- MedEvidence 内部的上游账号/密钥编排（包括 v2 凭据）对收费团队和终端用户都不可见；收费团队只需要维护"收费系统用户 ↔ `subject_id`"的映射。
- P1 价格表（token / image → cost units）由收费团队定义并需有版本可追溯；MedEvidence 内部按版本快照记录每笔扣费。

## 2. 鉴权

所有 billing 后台接口前缀：

```
/gateway/admin/billing/v1/
```

请求 header：

```http
Authorization: Bearer <billing_admin_token>
Content-Type: application/json
```

约束：

- Token 由 MedEvidence 运维分配，仅保存在收费/充值团队后端，**不允许下发到客户端**。
- 客户端不允许直接调用 `/gateway/admin/billing/v1/*`。
- MedEvidence 支持双 token 并存以实现无中断滚动轮换：轮换窗口内 current 和 next 两个 token 同时有效；运维会提前通知切换计划，切换完成并确认旧 token 无调用后下线。

## 3. 通用约定

### 3.1 幂等

所有写接口必须传 `Idempotency-Key` header。

格式：

```
<provider>:<event_reference>:<event_type>[:<event_discriminator>]
```

约束：

- ASCII，字符集 `[A-Za-z0-9._:-]`，长度 1..200。
- 同一外部业务事件必须用同一 key；不同事件必须不同 key。
- 同一订阅多次续费、暂停、恢复、取消不能复用同一 key。
- 同一充值订单多次 top-up、退款、调整也不能复用同一 key。

推荐模板：

| event_type | 推荐 Key | 说明 |
| --- | --- | --- |
| `create_subject` | `<provider>:<external_user_id>:create_subject` | 同一外部用户的开户事件 |
| `rotate_key` | `<provider>:<subject_id>:rotate_key:<request_id>` | 每次密钥轮换都必须不同 |
| `disable_subject` | `<provider>:<subject_id>:disable_subject:<event_id>` | 用户注销 / 风控停用 |
| `purchase` | `<provider>:<checkout_id>:purchase` | 一次 checkout / payment intent 对应一次购买 |
| `renew` | `<provider>:<subscription_id>:renew:<period_start>` | 每个续费周期必须不同；优先用 period_start |
| `pause` | `<provider>:<subscription_id>:pause:<event_id>` | 每次暂停事件必须不同 |
| `resume` | `<provider>:<subscription_id>:resume:<event_id>` | 每次恢复事件必须不同 |
| `cancel` | `<provider>:<subscription_id>:cancel:<event_id>` | 取消、拒付、退款触发的停权事件 |
| `notice` | `<provider>:<event_id>:notice:<kind>` | 仅记录不应用，必须配合 `apply_mode: "log_only"` |
| `top_up` | `<provider>:<topup_order_id>:top_up` | 一次充值订单 |
| `refund` | `<provider>:<topup_order_id>:refund:<event_id>` | 同一充值的多次退款必须不同 |
| `adjustment` | `<provider>:<adjustment_id>:adjustment` | 人工补偿、促销赠送等 |

如支付 provider 提供全局唯一 webhook event id，可作为最后一段。

幂等行为：

- 同 key + 同 payload：返回历史结果，响应字段 `idempotent_replay: true`。
- 同 key + 不同 payload：返回 `409 idempotency_conflict`，请停止自动重试并人工排查。
- 4xx 前置校验错误不固化 key；前置条件修复后可用同 key 重试。
- 5xx 或网络错误按指数退避重试；多次失败后进入 dead-letter queue。

### 3.2 时间格式

所有时间字段必须是带明确 offset 的 RFC 3339 / ISO 8601 字符串，推荐 UTC `Z`，例如 `2026-05-11T00:00:00.000Z`。MedEvidence 拒绝没有 offset 的本地时间字符串。

`period_end` 必须晚于 `period_start`，否则返回 `400 invalid_period`。

### 3.3 限流

Billing 路由有独立 webhook / 注册限流，超限返回 `429 rate_limited`。请收费团队启用指数退避，并支持 dead-letter queue。注册接口对单 IP / 单 `external_user_id` 还有更紧的速率限制，详见 §4.5。

### 3.4 contract 稳定性

`/v1` 在 P0 定稿后冻结：已有 endpoint 只会新增可选请求/响应字段或新增非破坏性枚举；不会修改字段语义、必填集合、状态码或错误码语义。P1 通过新增 endpoint 和新增可选字段扩展 `/v1`。任何破坏性变更进入 `/v2`，会提前通知。

### 3.5 错误响应

```json
{
  "error": {
    "code": "...",
    "message": "...",
    "request_id": "req-..."
  }
}
```

所有响应（成功或失败）都返回 `x-request-id` header，请保存以便联调对账。

## 4. Subject 开户 API（P0）

收费团队负责注册页 UI、邮箱验证、密码或 SSO、防滥用前置（captcha 等）。注册表单提交后，收费后端调用本节 API 在 MedEvidence 建账并拿到 `subject_id` + opaque key。

### 4.1 角色和概念

- **`external_user_id`**：收费系统对该用户的稳定 ID。同一 `(provider, external_user_id)` 在 MedEvidence 内只对应一个 `subject_id`，**不可重复开户**。
- **`subject_id`**：MedEvidence 内部用户 ID。下单、退款、状态变更、对账、扣费都以此为主键。
- **opaque key**：`cgu_live_*` 前缀的统一凭据，是终端用户调用模型 API 唯一需要的凭据。MedEvidence 在 broker 阶段自动解出底层凭据，收费团队和终端用户都不需要关心组成。
- **key 只在响应里返回一次**：MedEvidence 不存储 key 原文。响应返回后，收费团队**必须立即展示给用户或安全留存**；若遗失只能通过 §4.4 轮换得到新 key。

### 4.2 创建 subject

```http
POST /gateway/admin/billing/v1/subjects
Authorization: Bearer <token>
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
    "signup_source": "web",
    "locale": "zh-CN"
  }
}
```

字段：

| 字段 | 要求 | 说明 |
| --- | --- | --- |
| `provider` | 必填 | 收费系统名，例如 `medevidence_billing`、`stripe` |
| `external_user_id` | 必填 | 收费系统的稳定用户 ID；同 `(provider, external_user_id)` 不允许重复开户 |
| `display_name` | 可选 | 用户昵称或显示名，仅用于 MedEvidence 内部审计和客服排障 |
| `scope_allowlist` | 可选 | API key 允许的 scope，缺省取系统默认；当前 P0 默认 `["code"]` |
| `metadata` | 可选 | 自由字段，限制同 §5.2；禁止落库邮箱、手机号等敏感个人信息 |

注意：**邮箱、手机号、密码等敏感个人信息不要传给 MedEvidence**。MedEvidence 不需要这些字段，也不会代收费团队保管。验证、找回流程在收费团队站点完成。

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

- `credential.key` 是 opaque key 原文，**仅在本次响应返回**。后续接口（包括 §4.3 查询）只能取到 `key_prefix`。
- `idempotent_replay=true` 时不会返回 `credential.key` 原文（只有 `key_prefix`），因为原文已在首次响应里下发；如需新 key 请走轮换。
- `created_at` 是 MedEvidence 内部时间戳，UTC。

### 4.3 查询 subject

按 MedEvidence subject id 查询：

```http
GET /gateway/admin/billing/v1/subjects/{subject_id}
Authorization: Bearer <token>
```

按 `(provider, external_user_id)` 查询：

```http
GET /gateway/admin/billing/v1/subjects?provider=...&external_user_id=...
Authorization: Bearer <token>
```

响应：

```json
{
  "subject": {
    "id": "medevidence-xxx",
    "provider": "medevidence_billing",
    "external_user_id": "bu_abc123",
    "display_name": "Alice",
    "scope_allowlist": ["code"],
    "state": "active",
    "created_at": "2026-05-11T00:00:00.000Z"
  },
  "credentials": [
    {
      "id": "ckey_xxx",
      "key_prefix": "cgu_live_AAAA",
      "issued_at": "2026-05-11T00:00:00.000Z",
      "expires_at": null,
      "state": "active"
    }
  ]
}
```

不返回 key 原文。

### 4.4 轮换 opaque key

```http
POST /gateway/admin/billing/v1/subjects/{subject_id}/keys
Authorization: Bearer <token>
Idempotency-Key: medevidence_billing:medevidence-xxx:rotate_key:req_999
Content-Type: application/json
```

请求：

```json
{
  "reason": "user_lost_key",
  "revoke_previous": true,
  "grace_period_seconds": 0
}
```

字段：

| 字段 | 要求 | 说明 |
| --- | --- | --- |
| `reason` | 可选 | 审计留痕 |
| `revoke_previous` | 默认 `true` | 是否立即吊销现有 active key |
| `grace_period_seconds` | 可选，默认 `0`，最大 `3600` | 旧 key 与新 key 并存的时间窗口，便于客户端切换 |

成功响应字段与 §4.2 `credential` 段相同，包含新 key 原文。

### 4.5 停用 subject

```http
POST /gateway/admin/billing/v1/subjects/{subject_id}/disable
Authorization: Bearer <token>
Idempotency-Key: medevidence_billing:medevidence-xxx:disable_subject:evt_888
Content-Type: application/json
```

请求：

```json
{
  "reason": "user_requested_deletion"
}
```

行为：

- 所有现有 active key 立即吊销。
- 现有 entitlement 转为 `cancelled`（不退费）。
- subject `state` 变为 `disabled`，对应 `external_user_id` 不允许直接复用；如需重新开户必须使用新的 `external_user_id`。
- 已记录的 usage 和 ledger 历史保留，用于对账和合规。

### 4.6 注册限流与防滥用

MedEvidence 后端对注册路径有独立限流：

- **单 IP**：默认 60/小时（按调用方公网 IP 或 `X-Forwarded-For` 第一跳计算）。
- **单 `(provider, external_user_id)`**：3 次/小时（防止收费侧 retry 风暴重复建账）。
- **全局**：MedEvidence 整体注册速率有上限，超过返回 `429 rate_limited`。

收费团队应在自己站点完成 captcha、邮箱验证、风控判定后再调用本接口；MedEvidence 后端不直接对终端用户做人机验证。

### 4.7 失败原子性

注册涉及 MedEvidence 内部多个步骤（建 subject、签发底层凭据、生成 opaque key）。原则：

- 任何一步失败 → 整体回滚，返回 5xx。
- 收费团队使用同一 `Idempotency-Key` 重试即可；MedEvidence 内部会基于 `(provider, external_user_id)` 检测是否已存在，避免重复开户。
- 若 MedEvidence 检测到部分残留（例如内部凭据已签但 opaque key 未生成），按 idempotent replay 修复，响应仍然返回完整对象。

## 5. 套餐与权益 API（P0）

### 5.1 列出可售套餐

```http
GET /gateway/admin/billing/v1/plans
Authorization: Bearer <token>
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

- `token_policy`、`feature_policy` 仅供收费团队展示。下单时只传 `plan_id`，**不允许在请求里覆盖 policy**；真正生效的 quota 来自 MedEvidence 内部 entitlement snapshot。
- Plan 由 MedEvidence 运维统一维护，收费团队不能通过 API 创建或修改。

### 5.2 写入 entitlement event

```http
POST /gateway/admin/billing/v1/entitlement-events
Authorization: Bearer <token>
Idempotency-Key: stripe:checkout_123:purchase
Content-Type: application/json
```

请求示例（购买）：

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
  "replace_paused": false,
  "amount_minor": 1999,
  "currency": "USD",
  "metadata": {
    "sku": "medcode_pro_monthly"
  }
}
```

字段：

| 字段 | 要求 | 说明 |
| --- | --- | --- |
| `event_type` | 必填 | `purchase` / `renew` / `pause` / `resume` / `cancel` / `notice` |
| `apply_mode` | 可选，默认 `apply` | 仅接受 `apply` 或 `log_only`；其他值返回 400 |
| `provider` | 必填 | 支付提供方或收费系统名 |
| `external_order_id` | 必填 | 收费系统订单 ID |
| `external_event_id` | 可选 | webhook 事件 ID |
| `subject_id` | 必填 | MedEvidence 用户 ID，必须已通过 §4 完成开户 |
| `plan_id` | `purchase` / `renew` 必填 | MedEvidence 套餐 ID |
| `period_kind` | `purchase` / `renew` 必填 | `monthly` / `one_off` / `unlimited` |
| `period_start` | 可选；ISO 8601 带 offset | 缺省取服务端当前时间 |
| `period_end` | 按 `period_kind` 决定 | `unlimited` 可为空；其它必须晚于 `period_start` |
| `replace_current` | 默认 `false` | 是否取消当前 active entitlement；不隐式影响 scheduled 或 paused |
| `replace_scheduled` | 默认 `false` | 显式 `true` 才会取消未来 scheduled entitlement |
| `replace_paused` | 默认 `false`，需配合 `replace_current=true` | 是否同时取消 paused entitlement |
| `entitlement_id` | 状态变更事件可选 | 显式指定目标 entitlement |
| `reason` | 状态变更事件可选 | 审计留痕 |
| `amount_minor` | 可选 | 订单金额，最小货币单位；仅审计留痕，不参与权益判定 |
| `currency` | 可选 | ISO 货币码；仅审计留痕，不参与权益判定 |
| `metadata` | 可选 | 自由字段，但有禁用项和大小限制 |

**`metadata` 限制**：

- 禁止落库卡号、CVV、支付账户完整标识、邮箱、手机号、账单地址、发票抬头等支付或个人敏感信息。
- 建议只传 provider、SKU、订单短 ID、非敏感渠道标识。
- JSON 序列化后大小 ≤ 4 KB，超过返回 `400 invalid_request`。

成功响应（`apply_mode=apply`）：

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

- 如果 apply 取消了旧 entitlement，`cancelled_entitlement_ids` 列出被取消的 id；无取消时为空数组。

成功响应（`apply_mode=log_only`，含 `notice` 事件）：

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

收费团队应通过 `billing_event.apply_mode` 和 `billing_event.status` 判断"已生效"与"仅记录"。

### 5.3 查询单个 billing event

```http
GET /gateway/admin/billing/v1/entitlement-events/{idempotency_key}
Authorization: Bearer <token>
```

`idempotency_key` 包含 `:` 等保留字符，path 形式必须 URL-encode。也可使用 query 形式：

```http
GET /gateway/admin/billing/v1/entitlement-events?provider=stripe&external_order_id=pay_123&event_type=purchase
```

### 5.4 列出 billing event

```http
GET /gateway/admin/billing/v1/entitlement-events?subject_id=...&limit=50&cursor=...
Authorization: Bearer <token>
```

- `limit` 默认 50，最大 200。
- `cursor` 由响应中的 `next_cursor` 字段提供，是服务端不透明字符串；末页为 `null`。

### 5.5 查询用户 entitlement

```http
GET /gateway/admin/billing/v1/users/{subject_id}/entitlements?limit=50&cursor=...
Authorization: Bearer <token>
```

响应：

```json
{
  "subject_id": "medevidence-xxx",
  "current": {
    "id": "ent_xxx",
    "plan_id": "plan_paid_monthly_v1",
    "state": "active",
    "period_start": "2026-05-11T00:00:00.000Z",
    "period_end": "2026-06-11T00:00:00.000Z",
    "feature_policy": { "capabilities": ["chat", "tools", "image_generation"] }
  },
  "history": [
    {
      "id": "ent_prev",
      "plan_id": "plan_paid_monthly_v1",
      "state": "expired",
      "period_start": "2026-04-11T00:00:00.000Z",
      "period_end": "2026-05-11T00:00:00.000Z",
      "feature_policy": { "capabilities": ["chat", "tools"] }
    }
  ],
  "next_cursor": null
}
```

- `current` 是当前最有效的 entitlement，不存在时为 `null`。
- `history` 按 `period_start DESC` 排序，分页。

### 5.6 查询 usage 对账

```http
GET /gateway/admin/billing/v1/usage?subject_id=...&from=...&to=...&group_by=day&limit=90&cursor=...
Authorization: Bearer <token>
```

- `subject_id`、`from`、`to` 必填。
- 单次查询时间范围 ≤ 90 天。
- `group_by`：`day` / `month` / `none`。
- `limit` 默认 90，最大 200。

P0 响应只含 token 维度；P1 上线后新增 `image_*` 和 `credit_*` 字段（详见 §8.5）。

```json
{
  "subject_id": "medevidence-xxx",
  "from": "2026-05-01T00:00:00.000Z",
  "to": "2026-06-01T00:00:00.000Z",
  "group_by": "day",
  "rows": [
    {
      "period_start": "2026-05-11T00:00:00.000Z",
      "request_count": 12,
      "success_count": 11,
      "error_count": 1,
      "prompt_tokens": 12000,
      "completion_tokens": 3200,
      "total_tokens": 15200,
      "estimated_tokens": 0
    }
  ],
  "next_cursor": null
}
```

- `estimated_tokens` 表示 provider 未返回 usage 时 MedEvidence 的估算值。
- 不返回 prompt / completion 文本、不返回 API key 原文。

## 6. P0 事件语义

### 6.1 `purchase`

新购套餐。

- 校验 `subject_id`、`plan_id` 存在且 active。
- 已有 active entitlement 且未传 `replace_current=true`：返回 `409 entitlement_already_active`。
- 已有 scheduled entitlement，且新周期 `[period_start, period_end]` 与之重叠，但未传 `replace_scheduled=true`：返回 `409 invalid_entitlement_transition`。
- `replace_current=true` → 取消 active。
- `replace_scheduled=true` → 取消未来 scheduled（仅在与新周期重叠时；如需无条件清掉所有 scheduled，请先发 `cancel`）。
- `replace_paused=true`（仅在 `replace_current=true` 时有效）→ 取消 paused。
- 创建新的 entitlement，响应里返回被取消的 entitlement id 列表。

### 6.2 `renew`

续期。

- 必须用户当前已有 active entitlement，否则返回 `404 entitlement_not_found`。MedEvidence 不会把 `renew` 自动提升为 `purchase`。
- paused 用户不支持续期：请先发 `resume`，再发 `renew`。
- 必须在请求里显式传 `period_start` / `period_end`；MedEvidence 不自动推断自然月或账单锚点。
- `replace_current` / `replace_scheduled` 行为同 `purchase`。

### 6.3 `pause`

暂停权益（账户和历史 usage 保留）。

- 默认对当前 active entitlement 操作；可显式传 `entitlement_id`。
- 已 paused 的 entitlement 再次 pause 返回 `409 invalid_entitlement_transition`，请按幂等 replay 判断是否需要重复发送。

### 6.4 `resume`

恢复 paused entitlement。

- 默认对最近 paused entitlement 操作；可显式传 `entitlement_id`。
- 已 active 或已 cancelled / expired 的 entitlement 调用 resume 返回 `409 invalid_entitlement_transition`。

### 6.5 `cancel`

取消权益。

- 默认对当前 active entitlement 操作；可显式传 `entitlement_id`。
- 已 cancelled / expired 的 entitlement 再次 cancel 返回 `409 invalid_entitlement_transition`。
- **MedEvidence 不会把退款自动解释为取消**。退款后是否停权由收费团队决定并显式发 `cancel` 或 `pause`，部分退款、人工补偿、chargeback 等场景同理。

### 6.6 `notice` / `apply_mode=log_only`

仅记录外部事件，不改变权益。

- `event_type=notice` 必须搭配 `apply_mode: "log_only"`。
- 任何 event_type 都可以用 `apply_mode: "log_only"` 仅记录而不应用。
- 不调用 grant / pause / resume / cancel；响应 `applied: false`、`status: ignored`。
- 未知 `event_type` 或未知 `apply_mode` 一律返回 400，不会被静默接受。

## 7. P0 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `invalid_request` | 字段缺失、格式错、超大、未知枚举值 |
| 400 | `invalid_event_type` | `event_type` 不支持 |
| 400 | `invalid_period` | `period_start` / `period_end` 缺失、格式错或与 `period_kind` 不匹配 |
| 400 | `invalid_external_user_id` | `external_user_id` 长度或字符不合法 |
| 401 | `missing_credential` | 缺少 billing admin token |
| 401 | `invalid_credential` | token 错误或已下线 |
| 404 | `subject_not_found` | 用户不存在或已 disabled |
| 404 | `plan_not_found` | plan 不存在或非 active |
| 404 | `entitlement_not_found` | entitlement 不存在或不在可操作状态 |
| 404 | `credential_not_found` | 指定 key 不存在 |
| 409 | `subject_already_exists` | 同 `(provider, external_user_id)` 已存在但 payload 与历史不一致 |
| 409 | `idempotency_conflict` | 同 key 与历史 payload 冲突 |
| 409 | `entitlement_already_active` | 已有 active entitlement 但未传 `replace_current=true` |
| 409 | `invalid_entitlement_transition` | 状态流转不允许，或 scheduled entitlement 冲突但未传 `replace_scheduled=true` |
| 429 | `rate_limited` | 触发注册或 webhook 限流 |
| 502 | `upstream_unavailable` | MedEvidence 上游依赖暂时失败（仅 §4 注册可能返回）；按指数退避重试同 key |
| 503 | `service_unavailable` | 服务未配置或暂不可用 |

所有错误都带 `x-request-id`，建议入库便于跨团队定位。

## 8. 充值钱包 API（P1）

### 8.1 概念与单位

P1 在 entitlement 之外新增**信用余额账本（credit ledger）**：

- 收费/充值团队通过 API 写入 `top_up`、`refund`、`adjustment` 三类账本条目。
- MedEvidence 内部根据请求实际消费写入 `charge`，按过期规则写入 `expire`；这两类不由外部 API 触发。
- 所有条目按时间顺序追加，**不允许删除**；退款和调整必须用新条目冲正。

**单位约定**：

- 内部统一使用 `credit` 作为扣费单位，token / image / 模型 / 尺寸 / 质量等差异都通过价格表换算成 credit。
- 最小精度：`1 credit = 1,000,000 micro_credit`。所有 API 字段中的 `units_delta`、`balance` 都以 **micro_credit 整数** 传输，避免浮点误差。例如 `1_500_000` 表示 1.5 credit。
- 金额（`amount_minor` / `currency`）只用于审计，与 credit 单位互相独立。换算汇率由收费团队维护，MedEvidence 不做货币换算。

### 8.2 写入 credit event

```http
POST /gateway/admin/billing/v1/credit-events
Authorization: Bearer <token>
Idempotency-Key: stripe:topup_456:top_up
Content-Type: application/json
```

请求示例（充值入账）：

```json
{
  "entry_type": "top_up",
  "provider": "stripe",
  "external_order_id": "topup_456",
  "external_event_id": "evt_456",
  "subject_id": "medevidence-xxx",
  "units_delta": 50000000,
  "expires_at": "2027-05-11T00:00:00.000Z",
  "amount_minor": 5000,
  "currency": "USD",
  "metadata": {
    "sku": "medcode_topup_50credit"
  }
}
```

字段：

| 字段 | 要求 | 说明 |
| --- | --- | --- |
| `entry_type` | 必填 | `top_up` / `refund` / `adjustment`；`charge` 和 `expire` 仅 MedEvidence 内部使用，外部 API 不接受 |
| `provider` | 必填 | 支付提供方或收费系统名 |
| `external_order_id` | 必填 | 充值 / 退款 / 调整对应的外部订单 ID |
| `external_event_id` | 可选 | webhook 事件 ID |
| `subject_id` | 必填 | MedEvidence 用户 ID |
| `units_delta` | 必填，整数 micro_credit | `top_up` / `adjustment(增加)` 为正；`refund` / `adjustment(扣减)` 为负 |
| `expires_at` | `top_up` 可选 | 该笔充值的过期时间；缺省永不过期；`refund` / `adjustment` 不接受此字段 |
| `related_entry_id` | `refund` 必填，`adjustment` 可选 | 退款对应的原始 `top_up` 条目 ID |
| `amount_minor` | 可选 | 金额，最小货币单位，仅审计 |
| `currency` | 可选 | ISO 货币码，仅审计 |
| `reason` | 可选 | 审计留痕 |
| `metadata` | 可选 | 限制同 entitlement event |

`refund` 的 `units_delta` 必须为负，且 `|units_delta|` ≤ 对应 `top_up` 剩余可退额度（已退款部分会被累计）。

成功响应：

```json
{
  "applied": true,
  "idempotent_replay": false,
  "credit_event": {
    "id": "cevt_xxx",
    "entry_id": "ledger_xxx",
    "entry_type": "top_up",
    "status": "applied",
    "subject_id": "medevidence-xxx",
    "units_delta": 50000000,
    "balance_after": 52300000,
    "expires_at": "2027-05-11T00:00:00.000Z"
  }
}
```

- `balance_after` 是该用户在事务提交后的总余额（micro_credit）。
- 退款若导致用户余额变负（已经消费过的部分被退），MedEvidence 仍记录负余额，由收费团队决定后续补偿策略（见 §12 待对齐问题）。

### 8.3 查询余额

```http
GET /gateway/admin/billing/v1/users/{subject_id}/balance
Authorization: Bearer <token>
```

响应：

```json
{
  "subject_id": "medevidence-xxx",
  "balance": 52300000,
  "balance_credits": "52.300000",
  "buckets": [
    {
      "source_entry_id": "ledger_aaa",
      "remaining_units": 48300000,
      "expires_at": "2027-05-11T00:00:00.000Z"
    },
    {
      "source_entry_id": "ledger_bbb",
      "remaining_units": 4000000,
      "expires_at": null
    }
  ],
  "as_of": "2026-05-11T01:23:45.000Z"
}
```

- `balance` 是 micro_credit 整数，`balance_credits` 是按 6 位小数展示的字符串，便于直接渲染。
- `buckets` 按"先过期的先消费"FIFO 顺序排列；客户端余额页可用于展示"X credit 将在 Y 之前过期"。

### 8.4 查询账本

```http
GET /gateway/admin/billing/v1/users/{subject_id}/ledger?from=...&to=...&entry_type=...&limit=100&cursor=...
Authorization: Bearer <token>
```

- `from`、`to` 可选；缺省返回最近 90 天。
- `entry_type` 可选，多值逗号分隔；缺省返回所有类型。
- `limit` 默认 100，最大 500。

响应：

```json
{
  "subject_id": "medevidence-xxx",
  "entries": [
    {
      "id": "ledger_xxx",
      "entry_type": "top_up",
      "units_delta": 50000000,
      "balance_after": 52300000,
      "external_order_id": "topup_456",
      "expires_at": "2027-05-11T00:00:00.000Z",
      "created_at": "2026-05-11T00:00:00.000Z"
    },
    {
      "id": "ledger_yyy",
      "entry_type": "charge",
      "units_delta": -3700,
      "balance_after": 52296300,
      "related_request_id": "req_zzz",
      "unit_kind": "token",
      "price_table_version": "pt_v3",
      "created_at": "2026-05-11T00:01:00.000Z"
    }
  ],
  "next_cursor": null
}
```

- 排序按 `created_at DESC`。
- `charge` 条目的 `related_request_id` 可用于和 §5.6 usage 或客户端日志关联。
- `price_table_version` 让你能复现历史扣费，不会受后续价格调整影响。

### 8.5 image usage 与 credit 字段进入 usage

P1 在 §5.6 `/usage` 响应中新增 image 和 credit 维度的可选字段，不破坏 P0 字段：

```json
{
  "subject_id": "medevidence-xxx",
  "rows": [
    {
      "period_start": "2026-05-11T00:00:00.000Z",
      "request_count": 12,
      "success_count": 11,
      "error_count": 1,
      "prompt_tokens": 12000,
      "completion_tokens": 3200,
      "total_tokens": 15200,
      "estimated_tokens": 0,
      "image_request_count": 3,
      "image_output_count": 5,
      "charged_credits": 7300000,
      "charged_credits_text": "7.300000"
    }
  ]
}
```

- `image_request_count`：调用图片生成 API 的次数；`image_output_count`：实际产出图片张数（含多张/同一请求）。
- `charged_credits` 是该聚合区间内 `charge` 条目总和（micro_credit）。
- 价格表细分（token、模型、尺寸、质量）不直接出现在 usage 响应里；如需还原细分，请查询 §8.4 账本。

### 8.6 价格表与扣费规则

- 价格表由收费团队定义，至少按以下维度：token（input / output）、模型、image（model + size + quality + count）。
- 价格表通过运维流程上载到 MedEvidence；具体上载方式（API、配置文件、admin CLI）在联调期敲定。每个版本一旦使用，不允许修改；历史扣费引用版本号。
- 文本模型扣费：请求完成后按 provider usage × 价格表换算 micro_credit 写 `charge`；provider usage 缺失时按 estimator 兜底，并在账本中标注。
- 图片模型扣费：图片生成成功后按 model / size / quality / count 换算写 `charge`；失败不扣费。
- 余额不足时，模型请求被拒绝（不是 billing API 拒绝），客户端会收到 `402 insufficient_credit`（详见 §10）。
- 套餐 quota 与充值余额同时存在时的优先级由双方约定，是开放问题之一（见 §13）。

## 9. P1 事件语义

### 9.1 `top_up`

充值入账。

- 写入正数 `units_delta` 条目。
- 可选 `expires_at` 表示该笔充值的过期时间；过期未消费的部分会由 MedEvidence 自动写 `expire` 条目扣回。
- 不影响 entitlement 状态。

### 9.2 `refund`

退款冲正。

- 必须传 `related_entry_id` 指向原 `top_up` 条目。
- `units_delta` 必须为负，`|units_delta|` ≤ 该 top_up 剩余可退额度。
- 不删除任何历史条目；冲正后该 top_up 的剩余可退额度同步减少。
- **不会自动改变 entitlement**。如果退款后还需要停用模型能力，请另发 `cancel` 或 `pause` entitlement event。

### 9.3 `adjustment`

人工补偿或扣减（含促销赠送、客服补偿、风控扣减等）。

- `units_delta` 可正可负。
- 可选 `expires_at`（仅当 `units_delta > 0` 时有效）。
- 必填 `reason`，强烈建议详细说明，以便审计。

### 9.4 内部条目：`charge` 和 `expire`

- `charge`：模型请求完成后由 MedEvidence 写入；外部 API 无法写。
- `expire`：充值过期由 MedEvidence 写入。
- 这两类条目仅出现在 §8.4 账本查询响应中。

## 10. P1 错误码增量

P1 在 §7 P0 错误码之外新增：

| HTTP | code | 含义 | 触发面 |
| --- | --- | --- | --- |
| 400 | `invalid_entry_type` | `entry_type` 不支持，或外部 API 试图写 `charge` / `expire` | billing admin API |
| 400 | `invalid_units_delta` | `units_delta` 为 0、方向与 `entry_type` 不符、或超过可退额度 | billing admin API |
| 404 | `related_entry_not_found` | `related_entry_id` 不存在或不属于该用户 | billing admin API |
| 409 | `refund_exceeds_topup` | 退款累计超过原 top_up 金额 | billing admin API |
| 402 | `insufficient_credit` | 用户余额不足以发起模型请求 | 客户端模型 API |
| 402 | `credit_required` | 用户没有可用套餐 quota 且无充值余额 | 客户端模型 API |

`402` 错误返回给客户端模型调用方（不是 billing admin API），收费/充值团队需要设计客户端的提示和充值入口。

## 11. 收费/充值团队待完成工作

### 11.1 P0 必做

1. **注册站点 UI**
   - 邮箱验证、密码或 SSO、captcha 等前置防滥用。
   - 用户提交后调用 §4.2 `POST /subjects` 创建 MedEvidence 账号。
   - **opaque key 只在响应中返回一次**：注册成功页或账户中心必须立即将 key 展示给用户（推荐"复制 + 下载备份"按钮），并提示"如丢失只能轮换"。
   - 找回 key / 重置 key 入口走 §4.4 轮换 API。
2. **用户 ID 映射**
   - 收费系统内部 `user_id` ↔ MedEvidence `subject_id` 双向映射，保存在收费系统数据库。
   - 调用 §5 / §8 任何 API 时直接传 `subject_id`，不要把内部 `user_id` 当 `subject_id`。
3. **SKU ↔ `plan_id` 映射**
   - 客户端选 SKU，收费后端映射到 `plan_id` 再下单；不允许客户端直接传 `plan_id`。
4. **支付订单系统**
   - checkout、provider webhook、订单状态机由收费系统负责。MedEvidence 不保存银行卡、支付账户、发票抬头等敏感信息。
5. **周期计算**
   - 收费系统计算 `period_start` / `period_end`，含月度、年度、试用、赠送时长、优惠延长。
6. **调用 entitlement event**
   - 幂等 key 稳定唯一；后台 token 仅在收费后端使用。
7. **重试策略**
   - 2xx → 记录已应用。
   - `idempotent_replay=true` → 按成功处理。
   - `409 idempotency_conflict` → 停止自动重试，人工排查。
   - `409 entitlement_already_active` / `409 invalid_entitlement_transition` → 业务侧决定是否补 `replace_*=true` 重发，或先发 `cancel`。
   - `404 *_not_found` → 检查前置条件，修复后可同 key 重试。
   - `409 subject_already_exists` → 检查 `(provider, external_user_id)` 的历史记录，与收费系统数据库对齐后再处理。
   - `502 upstream_unavailable`（仅注册）→ 指数退避同 key 重试；持续失败进入告警。
   - 5xx / 429 / 网络失败 → 指数退避，多次失败后 dead-letter。
8. **退款与状态变更**
   - 退款不会自动取消权益；如需停权请显式发 `cancel` 或 `pause`；支付恢复或人工补偿请显式发 `resume` 或新的 `purchase` / `renew`。
9. **账号注销**
   - 用户在收费侧申请注销时，调用 §4.5 `disable_subject` 停用 MedEvidence subject。注销不会自动退费，资金流由收费团队按各自合规要求处理。
10. **对账与排障**
    - 保存响应中的 `subject.id`、`credential.id`、`billing_event.id`、`entitlement.id`、`cancelled_entitlement_ids`、`x-request-id`；对 webhook 失败、5xx、幂等冲突、用户/plan 不存在、限流设置告警。
11. **客户端展示边界**
    - 支付页、订单、发票、退款进度、注册流程、找回 key 都由收费系统提供。
    - 模型是否可用、当前套餐、当前额度，客户端以 `GET /gateway/credentials/current` 为准。

### 11.2 P1 必做

1. **充值订单系统**：创建 top-up SKU 与金额、处理支付成功 / 失败 / 退款 / 拒付。
2. **价格表维护**：定义 token / image / 模型 / 尺寸 / 质量 → cost units 的换算规则；每次发布新版本通过运维流程上载到 MedEvidence；旧版本不可修改，历史账单依赖版本号还原。
3. **调用 credit event**：充值成功调用 `top_up`；退款 / 拒付时调用 `refund` 并传 `related_entry_id`；人工补偿用 `adjustment`。`charge` 和 `expire` 由 MedEvidence 内部写，不要尝试通过 API 写入。
4. **客户端余额展示**：余额页 UI 由收费/充值系统提供，文案、币种、汇率、税费、即将过期提示等都在收费侧渲染；数据来自 §8.3 / §8.4。
5. **低余额客户端流程**：客户端收到 `402 insufficient_credit` 或 `402 credit_required` 时，由收费/充值团队定义提示文案、充值入口和重试流程。
6. **退款冲正规则**：退款不能删除历史账本，只能用 `refund` 条目冲正。已消费部分退款后是否补偿用户、是否允许负余额，由收费团队制定业务规则。
7. **对账与排障**：保存响应中的 `credit_event.entry_id`、`balance_after`；对负余额、退款超额、过期等关键事件设置告警。
8. **客户端展示边界**：余额、即将过期、近期消费由收费/充值系统提供 UI；模型调用配额仍以 `GET /gateway/credentials/current` 为准（P1 上线后该接口会同时返回 entitlement 和余额状态）。

## 12. 上线节奏

- **Phase A：联调环境就位**。MedEvidence 提供测试 token、测试 `plan_id`。收费团队搭好注册页 Mock，跑通"建账 → 拿 opaque key → fake payment event → entitlement 开通"全链路。
- **Phase B：P0 联调**。`plan_id` ↔ SKU 映射敲定。收费团队后端接 provider webhook，转发 entitlement event；客户端通过 `/gateway/credentials/current` 验证 entitlement 已开通。
- **Phase C：P0 生产灰度**。先开少量内部订单。每日核对 subject 注册数、billing event 数、active entitlement 数、usage 聚合。
- **Phase D：P0 严格模式**。MedEvidence 切到强制要求 entitlement 才能调用模型的模式。切换前会单独通知，并确保所有 active 付费用户已具备 entitlement。
- **Phase E：P1 充值联调**。价格表 v1 发布；收费团队接入 `credit-events` API；客户端余额页接入 `balance` / `ledger`；fake top-up 跑通扣费 / 退款 / 过期回归。
- **Phase F：P1 生产灰度**。先开内部用户充值；每日核对 ledger 余额、charge 总额与 usage 是否一致、过期与退款冲正情况；价格表变更走灰度审批。

## 13. 待双方对齐的问题

1. SKU ↔ `plan_id` 映射谁维护、如何发布？
2. 月度周期按哪个时区和哪个账单锚点计算？
3. 支付成功但 MedEvidence apply 失败时，订单页面如何展示？
4. 退款、拒付、风控暂停是否立即影响 MedEvidence entitlement？
5. 用户在收费侧注销账号时，是只停用还是要走数据删除合规流程？MedEvidence 保留多久历史 usage 和 ledger？
6. P1 同一用户同时持有订阅套餐 quota 和充值余额时，先扣哪个？建议默认"先扣套餐 quota，超出再扣余额"，但需要双方确认。
7. P1 退款金额超过用户剩余余额（已消费部分）时，业务策略是允许负余额、拒绝退款、还是补偿后再退？
8. P1 价格表的上载方式（API / 配置文件 / admin CLI）和审批流程？
9. P1 充值过期策略：默认 1 年？是否区分 SKU？过期前几天客户端提示？
10. 是否需要 CSV 财务导出，还是 API 对账足够？
11. 团队订阅、多座位（一次购买 N 个 seat）是否纳入 P0？当前默认不在 P0 范围。
12. opaque key 是否需要支持多把（例如桌面端、CLI 端各持一把）？P0 默认单把 active key；如需多把，需要扩展 §4.4 轮换语义。

## 14. 已决议事项备忘

为方便后续团队成员快速对齐，此处记录与 P0 设计相关、已经达成共识的关键决议：

- **用户 ID 映射**：收费系统 `external_user_id` 与 MedEvidence `subject_id` 通过 §4.2 创建时绑定，收费团队维护双向映射；下单、状态变更、扣费时一律使用 `subject_id`。
- **注册 UI 归属**：注册页 UI、邮箱验证、密码/SSO、captcha 等防滥用前置都在收费团队站点。MedEvidence 不直接面向终端用户提供注册页。
- **用户创建归属**：MedEvidence 后端独占用户建账逻辑，包括内部凭据签发、opaque key 生成、账户状态机。收费团队通过 s2s API 触发，不直接操作 MedEvidence 数据库。
- **凭据形态**：终端用户只持有 opaque `cgu_live_*` key；MedEvidence 内部凭据组成对外不可见。
- **购买时用户不存在**：MedEvidence 返回 `404 subject_not_found`；不做"购买即开户"。注册必须在下单前完成。

---

如对 contract 有任何疑问或希望调整字段，请在联调启动前提出。P0 ship 后 `/v1` 会冻结字段语义，破坏性变更只能进 `/v2`。
