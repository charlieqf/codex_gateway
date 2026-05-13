# MedEvidence 收费/充值 API 集成指南（外发版）

日期：2026-05-13
适用：收费、充值团队后端开发与产品

本文给出收费/充值团队接入 MedEvidence 后台 API 所需的接口 contract、事件语义、双方分工、联调顺序和错误处理建议。本文为外发版，只描述对接方需要使用和理解的能力，不包含 MedEvidence 内部实现细节。

说明：当前 P0 联调可用范围、测试环境地址和已完成验证，以 `docs/medevidence-billing-p0-joint-test-handoff.external.zh-CN.md` 为准。

- **P0**：用户开户注册、opaque key 下发、套餐查询、支付事件写入、权益状态变更、token usage 对账。
- **P1**：预付费充值余额、退款冲正、余额过期、token/image 按价格表扣费。P1 为后续阶段，不属于当前 P0 联调必测范围。

## 1. 集成边界

MedEvidence 负责模型访问账号、opaque key、套餐、权益、能力开关和 usage 记录；收费/充值团队负责用户账号体系、支付订单、发票、退款、SKU 和价格展示。

- 收费/充值团队拥有注册页、登录、找回密码、支付页、订单状态机和退款流程。
- 收费/充值团队后端通过服务端接口调用 MedEvidence，不允许客户端直接调用后台接口。
- 用户开户注册时，收费后端调用 MedEvidence 创建 subject，并拿到 `subject_id` 和 opaque `cgu_live_*` key。
- 用户或客户端只需要保存 `cgu_live_*` key。MedEvidence 后端会完成凭据校验和请求路由，底层实现对收费团队和终端用户不可见。
- 付费状态以收费系统订单为准；模型是否可用，以 MedEvidence 返回的 entitlement / quota 状态为准。

## 2. 鉴权

后台接口前缀：

```text
/gateway/admin/billing/v1
```

请求 header：

```http
Authorization: Bearer <billing-admin-token>
Content-Type: application/json
```

要求：

- Token 只保存在收费/充值团队后端，不允许下发到浏览器、App 或客户端。
- 不要把 token 写入代码库、日志、截图、工单正文或聊天记录。
- MedEvidence 支持后台 token 轮换。轮换窗口内会提前通知，旧 token 下线前会确认新 token 已生效。

## 3. 通用约定

### 3.1 幂等

所有写接口必须传 `Idempotency-Key` header。

推荐格式：

```text
<provider>:<event_reference>:<event_type>[:<event_discriminator>]
```

约束：

- ASCII，字符集 `[A-Za-z0-9._:-]`，长度 1..200。
- 同一外部业务事件必须使用同一 key；不同事件必须使用不同 key。
- 同 key + 同 payload：返回历史结果，响应字段 `idempotent_replay: true`。
- 同 key + 不同 payload：返回 `409 idempotency_conflict`，停止自动重试并人工排查。
- 5xx、429 或网络错误：指数退避重试；多次失败后进入 dead-letter queue。

推荐模板：

| 场景 | 推荐 `Idempotency-Key` |
| --- | --- |
| 创建 subject | `<provider>:<external_user_id>:create_subject` |
| 轮换 opaque key | `<provider>:<subject_id>:rotate_key:<request_id>` |
| 停用 subject | `<provider>:<subject_id>:disable_subject:<event_id>` |
| 首次购买 | `<provider>:<checkout_id>:purchase` |
| 续费 | `<provider>:<subscription_id>:renew:<period_start>` |
| 升级 | `<provider>:<subscription_id>:upgrade:<event_id_or_timestamp>` |
| 暂停 | `<provider>:<subscription_id>:pause:<event_id>` |
| 恢复 | `<provider>:<subscription_id>:resume:<event_id>` |
| 取消 | `<provider>:<subscription_id>:cancel:<event_id>` |
| 仅记录通知 | `<provider>:<event_id>:notice:<kind>` |

### 3.2 时间

所有时间字段使用带 offset 的 RFC 3339 / ISO 8601 字符串，推荐 UTC `Z`，例如：

```text
2026-05-11T00:00:00.000Z
```

`period_end` 必须晚于 `period_start`。

### 3.3 错误响应

```json
{
  "error": {
    "code": "invalid_request",
    "message": "provider is required.",
    "request_id": "req_xxx"
  }
}
```

所有响应都会带 `x-request-id` header。请保存 `x-request-id`，用于跨团队排障和对账。

### 3.4 限流

当前测试环境后台接口默认限流：

```text
120 rpm / 10000 rpd / 8 concurrent
```

触发限流返回 `429 rate_limited`，并带 `Retry-After`。

## 4. Subject 开户 API（P0）

收费团队在注册、试用开通或首次购买前调用本接口创建 MedEvidence subject。

### 4.1 创建 subject

```http
POST /gateway/admin/billing/v1/subjects
Authorization: Bearer <billing-admin-token>
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
| `provider` | 必填 | 收费系统或支付系统标识，例如 `medevidence_billing` |
| `external_user_id` | 必填 | 收费系统稳定用户 ID；同 `(provider, external_user_id)` 只能开户注册一次；字符集 `[A-Za-z0-9._-]`，长度 1..128 |
| `display_name` | 可选 | 用户显示名，仅用于客服排障；不要传邮箱、手机号等敏感信息 |
| `scope_allowlist` | 可选 | P0 默认 `["code"]` |
| `metadata` | 可选 | 非敏感上下文字段，JSON 序列化后不超过 4KB |

不要传邮箱、手机号、密码、证件号、支付账户、账单地址、完整 API key 或 token。

成功响应：

```json
{
  "created": true,
  "idempotent_replay": false,
  "subject": {
    "id": "subj_xxx",
    "provider": "medevidence_billing",
    "external_user_id": "bu_abc123",
    "display_name": "Alice",
    "scope_allowlist": ["code"],
    "state": "active",
    "created_at": "2026-05-11T00:00:00.000Z"
  },
  "credential": {
    "id": "uck_xxx",
    "key": "cgu_live_AAAAAAAAAAAA...",
    "key_prefix": "cgu_live_AAAA",
    "issued_at": "2026-05-11T00:00:00.000Z",
    "expires_at": "2027-05-11T00:00:00.000Z",
    "state": "active"
  }
}
```

注意：

- `credential.key` 只在首次成功响应里返回一次。
- 同一 `Idempotency-Key` replay 时只返回 `key_prefix`，不会再次返回 `credential.key` 原文。
- 收费团队必须立即安全展示或保存 key；遗失后只能走轮换。

### 4.2 查询 subject

按 subject id 查询：

```http
GET /gateway/admin/billing/v1/subjects/{subject_id}
Authorization: Bearer <billing-admin-token>
```

按外部用户查询：

```http
GET /gateway/admin/billing/v1/subjects?provider=...&external_user_id=...
Authorization: Bearer <billing-admin-token>
```

查询响应不返回 key 原文，只返回 `key_prefix`。

### 4.3 轮换 opaque key

```http
POST /gateway/admin/billing/v1/subjects/{subject_id}/keys
Authorization: Bearer <billing-admin-token>
Idempotency-Key: medevidence_billing:subj_xxx:rotate_key:req_001
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

成功响应会返回新 key 原文。旧 key 是否立即失效由 `revoke_previous` 和 `grace_period_seconds` 决定。

### 4.4 停用 subject

```http
POST /gateway/admin/billing/v1/subjects/{subject_id}/disable
Authorization: Bearer <billing-admin-token>
Idempotency-Key: medevidence_billing:subj_xxx:disable_subject:evt_001
Content-Type: application/json
```

请求：

```json
{
  "reason": "user_requested_deletion"
}
```

行为：

- subject 变为 `disabled`。
- active opaque key 失效。
- 当前 entitlement 转为取消状态，不自动退款。
- 历史 usage 和账务记录保留，用于对账和合规。

## 5. 套餐与权益 API（P0）

### 5.1 列出可售套餐

```http
GET /gateway/admin/billing/v1/plans
Authorization: Bearer <billing-admin-token>
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

收费侧 SKU 需要映射到 MedEvidence `plan_id`。下单时只传 `plan_id`，不要在请求里覆盖 policy。

说明：上例中的 `plan_paid_monthly_v1` 是当前测试环境初始 plan 示例，不代表三档消费者月订阅的正式 SKU。三档上线后，收费侧 SKU 应映射到三档 `plan_id`；`plan_paid_monthly_v1` 的保留、停售或已有用户迁移策略由 MedEvidence 单独说明。

### 5.1.1 三档月订阅套餐方案（审核稿）

收费/充值团队计划采用按月订阅，初始建议映射为 3 个 MedEvidence plan。价格、SKU 展示、支付、发票、退款和升级差价由收费侧负责；MedEvidence 只以 `plan_id` 对应的 token policy 和 entitlement 状态判断模型访问权益。

| 收费侧档位 | 建议 `plan_id` | 建议展示名 | 月价格 | 月 token 额度 |
| --- | --- | --- | --- | --- |
| 低档 | `plan_basic_monthly_v1` | MedCode Basic Monthly | 50 元/月 | 1,000,000 |
| 中档 | `plan_standard_monthly_v1` | MedCode Standard Monthly | 100 元/月 | 2,000,000 |
| 高档 | `plan_premium_monthly_v1` | MedCode Premium Monthly | 200 元/月 | 3,000,000 |

价格审核备注：以上价格按当前讨论稿记录。高档按 200 元 / 3,000,000 tokens 计算，单价约 66.7 元 / 1,000,000 tokens，高于低档和中档的 50 元 / 1,000,000 tokens。请产品/收费团队在创建正式 plan 前确认这是有意的运营成本定价，还是额度或价格需要调整。

`tokens_per_month` 是月额度主口径。对有 active entitlement 的用户，月额度窗口按该 entitlement 的 `period_start` / `period_end` 计算，不按 UTC 自然月重置；例如 `2026-05-11T00:00:00.000Z` 到 `2026-06-11T00:00:00.000Z` 是一个完整额度窗口。`tokens_per_minute` / `tokens_per_day` 仍按 UTC 自然分钟 / UTC 自然日计算，不绑定 entitlement 周期；它们属于风控保护参数。`max_prompt_tokens_per_request`、`max_total_tokens_per_request` 属于单请求保护参数，正式值由双方在上线前按套餐体验与上游能力确认。

升级规则：

- 只允许同一订阅周期内从低额度套餐升级到高额度套餐。
- 升级后不清零已用量，只扩容总额度。
- 示例：用户低档 1,000,000 tokens 已用 500,000 tokens，升级到中档 2,000,000 tokens 后，当前用量为 500,000 / 2,000,000，剩余额度 1,500,000。
- 升级不自动退款或自动补差价。补差价、优惠、退款、失败回滚等支付策略由收费侧订单系统处理；MedEvidence 只在收到支付成功事件后变更 entitlement。
- 升级后的 entitlement 建议保留原订阅周期的 `period_start` / `period_end`，不要重置周期；续费时再按新套餐创建下一个周期。

实现状态说明：

- 套餐查询、购买、续费、暂停、恢复、取消、usage 对账已属于 P0 contract。
- 三档 plan 配置可以按上述 `plan_id` 增加。
- “升级后保留已用量并扩容总额度”需要 MedEvidence 在替换 entitlement 时把当前周期已用 token 结转到新 entitlement 的 token 窗口。MedEvidence 侧 entitlement 周期 token window 已完成开发和本地自测；三档 plan 创建、测试环境部署和双方联调验证完成前，不作为已开放联调能力。

### 5.2 写入 entitlement event

```http
POST /gateway/admin/billing/v1/entitlement-events
Authorization: Bearer <billing-admin-token>
Idempotency-Key: stripe:checkout_123:purchase
Content-Type: application/json
```

购买示例：

```json
{
  "event_type": "purchase",
  "apply_mode": "apply",
  "provider": "stripe",
  "external_order_id": "pay_123",
  "external_event_id": "evt_123",
  "subject_id": "subj_xxx",
  "plan_id": "plan_paid_monthly_v1",
  "period_kind": "monthly",
  "period_start": "2026-05-11T00:00:00.000Z",
  "period_end": "2026-06-11T00:00:00.000Z",
  "amount_minor": 1999,
  "currency": "USD",
  "metadata": {
    "sku": "medcode_pro_monthly"
  }
}
```

字段要点：

| 字段 | 要求 | 说明 |
| --- | --- | --- |
| `event_type` | 必填 | `purchase` / `renew` / `pause` / `resume` / `cancel` / `notice` |
| `apply_mode` | 可选 | 默认 `apply`；仅记录用 `log_only` |
| `provider` | 必填 | 支付或收费系统标识 |
| `external_order_id` | 必填 | 收费系统订单 ID |
| `external_event_id` | 可选 | webhook 事件 ID |
| `subject_id` | 必填 | MedEvidence subject id |
| `plan_id` | `purchase` / `renew` 必填 | 套餐 ID |
| `period_kind` | `purchase` / `renew` 必填 | `monthly` / `one_off` / `unlimited` |
| `period_start` | 可选 | 缺省为服务端当前时间 |
| `period_end` | 按周期决定 | `monthly` / `one_off` 必填，`unlimited` 可为空 |
| `replace_current` | 升级/替换时可选 | `true` 表示取消当前 active entitlement，并创建新套餐 entitlement |
| `replace_scheduled` | 升级/替换时可选；如 subject 存在 scheduled entitlement 则必传 | `true` 表示同时取消未来 scheduled entitlement |
| `replace_paused` | 升级/替换时可选 | `true` 表示替换时也取消 paused entitlement；仅在 `replace_current=true` 时使用 |
| `entitlement_id` | 状态变更可选 | 显式指定目标 entitlement |
| `reason` | 状态变更可选 | 审计备注 |
| `amount_minor` / `currency` | 可选 | 仅用于审计，不参与权益判定 |
| `metadata` | 可选 | 非敏感字段，JSON 序列化后不超过 4KB |

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
  "subject_id": "subj_xxx",
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

升级扩容示例：

说明：以下示例表示升级事件在 `2026-05-20T10:15:00Z` 发生，沿用原订阅 `sub_123` 在 `2026-05-11T00:00:00.000Z` 到 `2026-06-11T00:00:00.000Z` 的订阅周期。`external_order_id=upgrade_123` 是升级支付订单 ID，`sub_123` 是收费侧订阅 ID。

```http
POST /gateway/admin/billing/v1/entitlement-events
Authorization: Bearer <billing-admin-token>
Idempotency-Key: stripe:sub_123:upgrade:2026-05-20T10:15:00Z
Content-Type: application/json
```

```json
{
  "event_type": "purchase",
  "apply_mode": "apply",
  "provider": "stripe",
  "external_order_id": "upgrade_123",
  "external_event_id": "evt_upgrade_123",
  "subject_id": "subj_xxx",
  "plan_id": "plan_standard_monthly_v1",
  "period_kind": "monthly",
  "period_start": "2026-05-11T00:00:00.000Z",
  "period_end": "2026-06-11T00:00:00.000Z",
  "replace_current": true,
  "amount_minor": 5000,
  "currency": "CNY",
  "metadata": {
    "sku": "medcode_standard_monthly",
    "change_type": "upgrade",
    "from_plan_id": "plan_basic_monthly_v1",
    "to_plan_id": "plan_standard_monthly_v1"
  }
}
```

升级成功后，MedEvidence 返回新的 active entitlement，并在 `cancelled_entitlement_ids` 中返回被替换的旧 entitlement。目标上线版本会保证旧 entitlement 当前周期的 token usage 被结转到新 entitlement，因此客户端和收费侧看到的是“已用量不变、总额度变大”。

升级结转触发口径（已完成本地开发自测，待测试环境部署和联调验证）：

- MedEvidence 应在 `replace_current=true` 且新 `plan_id` 与被替换 entitlement 的 `plan_id` 不同的事件中执行 token usage 结转。
- `metadata.change_type`、`metadata.from_plan_id`、`metadata.to_plan_id` 仅用于 audit、日志和跨团队排障，不作为 MedEvidence 行为触发条件。
- 如当前 subject 已存在未来 scheduled entitlement，收费侧需要同时传 `replace_scheduled=true`；否则 MedEvidence 会返回 `409 invalid_entitlement_transition`，由收费侧人工确认后重试。

### 5.3 查询 billing event

按 idempotency key 查询：

```http
GET /gateway/admin/billing/v1/entitlement-events/{url_encoded_idempotency_key}
Authorization: Bearer <billing-admin-token>
```

按条件列出：

```http
GET /gateway/admin/billing/v1/entitlement-events?provider=stripe&external_order_id=pay_123
Authorization: Bearer <billing-admin-token>
```

### 5.4 查询用户 entitlement

```http
GET /gateway/admin/billing/v1/users/{subject_id}/entitlements?limit=50&cursor=...
Authorization: Bearer <billing-admin-token>
```

`current` 表示当前有效 entitlement；不存在时为 `null`。`history` 为历史记录。

### 5.5 查询 usage 对账

```http
GET /gateway/admin/billing/v1/usage?subject_id=...&from=...&to=...&group_by=day&limit=90&cursor=...
Authorization: Bearer <billing-admin-token>
```

要求：

- `subject_id`、`from`、`to` 必填。
- 单次查询时间范围不超过 90 天。
- `group_by`：`day` / `month` / `none`。

响应只包含统计值，不返回 prompt、completion 文本或 key 原文。

## 6. P0 事件语义

- `purchase`：创建新 entitlement。已有 active entitlement 时，除非双方约定覆盖策略，否则返回冲突。
- `renew`：续期当前 entitlement。
- `pause`：暂停 entitlement。
- `resume`：恢复 paused entitlement。
- `cancel`：取消 entitlement。退款不会自动取消权益；如需停权请显式发 `cancel` 或 `pause`。
- `notice` + `apply_mode=log_only`：仅记录外部事件，不改变权益。

升级建议使用 `purchase` + `replace_current=true` 表达。收费侧必须在支付成功后发送升级事件，并保持同一订阅周期的 `period_start` / `period_end`。目标上线版本中，MedEvidence 侧负责把被替换 entitlement 当前周期已用 token 结转到新 entitlement 的额度窗口，形成“已用量不变、总额度扩容”的效果。

降级（高档到低档）不在 P0 范围。如果在原周期内发起降级，MedEvidence 不保证 token usage 结转行为；降级建议在下一周期续费时通过新 `plan_id` 生效。

## 7. P0 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `invalid_request` | 字段缺失、格式错误、metadata 超限 |
| 400 | `invalid_event_type` | `event_type` 不支持 |
| 400 | `invalid_period` | 周期字段缺失、格式错误或不匹配 |
| 400 | `invalid_external_user_id` | `external_user_id` 不合法 |
| 401 | `missing_credential` | 缺少后台 token |
| 401 | `invalid_credential` | 后台 token 错误或已下线 |
| 404 | `subject_not_found` | subject 不存在或已停用 |
| 404 | `plan_not_found` | plan 不存在或非 active |
| 404 | `entitlement_not_found` | entitlement 不存在或不在可操作状态 |
| 404 | `credential_not_found` | 指定 key 不存在 |
| 409 | `subject_already_exists` | 同一外部用户已开户注册 |
| 409 | `idempotency_conflict` | 同 key 与历史 payload 冲突 |
| 409 | `entitlement_already_active` | 已有 active entitlement |
| 409 | `invalid_entitlement_transition` | 状态流转不允许 |
| 429 | `rate_limited` | 触发限流 |
| 502 | `upstream_unavailable` | MedEvidence 依赖暂时不可用 |
| 503 | `service_unavailable` | 服务暂不可用或未开放 |

## 8. 收费/充值团队 P0 必做

1. 注册页和账号体系：邮箱验证、密码/SSO、captcha、找回密码都在收费侧完成。
2. 开户调用：注册成功后调用 `POST /subjects`，保存 `subject.id`、`credential.key_prefix` 和首次返回的 `credential.key`。
3. Key 展示：`credential.key` 只返回一次。注册成功页或账户中心应提供复制/备份能力，并提示遗失后只能轮换。
4. 用户映射：保存收费系统 `user_id` 与 MedEvidence `subject_id` 的映射。
5. SKU 映射：收费侧 SKU 映射到 MedEvidence `plan_id`。
6. 支付事件：支付成功、续费、暂停、恢复、取消都通过 entitlement event 写入。
7. 升级事件：用户升级套餐且支付成功后，发送 `purchase` + `replace_current=true`，`plan_id` 为升级后的新套餐；metadata 中建议记录 `from_plan_id` / `to_plan_id` 供审计排障。
8. 降级策略：降级不在 P0 范围；如需降级，建议收费侧在下一周期续费时切换 `plan_id`。
9. 周期计算：收费侧计算 `period_start` / `period_end`；升级扩容建议沿用原订阅周期，不重置周期。
10. 重试策略：2xx 和 `idempotent_replay=true` 按成功处理；409 冲突停止自动重试；429/5xx/网络失败指数退避。
11. 退款策略：退款不会自动停权；如需停权请显式发送 `cancel` 或 `pause`。
12. 注销：用户注销时调用 `POST /subjects/{subject_id}/disable`。
13. 对账：保存 `x-request-id`、`billing_event.id`、`entitlement.id`、`subject.id`、`credential.key_prefix`。

## 9. P1 充值钱包预告

P1 会增加 credit ledger、balance、top-up、refund、adjustment、charge 和 expire 等能力。当前 P0 联调不要求接入这些接口。正式开始 P1 前会提供单独 contract 和联调说明。
