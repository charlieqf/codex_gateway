# MedEvidence Billing P0 联调交付说明（外发版）

更新时间：2026-05-11

本文面向收费/充值团队，描述当前测试环境可联调的 Billing Admin P0 范围。完整接口说明见 `docs/medevidence-billing-integration-guide.external.zh-CN.md`。

## 1. 测试环境

- Base URL：`https://gw.instmarket.com.au`
- Billing Admin 前缀：`/gateway/admin/billing/v1`
- 认证：`Authorization: Bearer <billing-admin-token>`
- Token 由 MedEvidence 通过安全渠道单独交付；不要写入代码库、日志、截图、工单正文或聊天记录。

用户业务 key（包括 `cgu_live_*`）不能访问 Billing Admin API。Billing Admin API 只能由收费/充值团队后端使用。

## 2. 当前可联调范围

已开放：

- `POST /gateway/admin/billing/v1/subjects`
- `GET /gateway/admin/billing/v1/subjects/{subject_id}`
- `GET /gateway/admin/billing/v1/subjects?provider=...&external_user_id=...`
- `POST /gateway/admin/billing/v1/subjects/{subject_id}/keys`
- `POST /gateway/admin/billing/v1/subjects/{subject_id}/disable`
- `GET /gateway/admin/billing/v1/plans`
- `POST /gateway/admin/billing/v1/entitlement-events`
- `GET /gateway/admin/billing/v1/entitlement-events/{idempotency_key}`
- `GET /gateway/admin/billing/v1/entitlement-events?provider=...&external_order_id=...&subject_id=...`
- `GET /gateway/admin/billing/v1/users/{subject_id}/entitlements`
- `GET /gateway/admin/billing/v1/usage?subject_id=...&from=...&to=...&group_by=day`

暂不纳入 P0 联调：

- P1 充值钱包：`credit-events`、`balance`、`ledger`。

当前可以开始受控联调：

```text
开户注册 -> 拿 opaque key -> 支付事件 -> entitlement 生效/暂停/恢复/取消 -> 查询权益和 usage
```

## 3. 初始 plan

测试环境已创建并验证以下 plan：

```text
plan_paid_monthly_v1
```

该 plan 用于 MedCode Pro Monthly 初始月付权益。收费侧 SKU 映射建议先指向这个 `plan_id`。

## 4. 请求约定

所有写入请求必须带 `Idempotency-Key`：

```http
Idempotency-Key: <provider>:<order-or-user-id>:<event-type>:<event-id>
```

示例开户注册：

```http
POST /gateway/admin/billing/v1/subjects
Authorization: Bearer <billing-admin-token>
Idempotency-Key: medevidence_billing:bu_abc123:create_subject
Content-Type: application/json
```

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

示例 purchase：

```http
POST /gateway/admin/billing/v1/entitlement-events
Authorization: Bearer <billing-admin-token>
Idempotency-Key: stripe:checkout_123:purchase
Content-Type: application/json
```

```json
{
  "event_type": "purchase",
  "apply_mode": "apply",
  "provider": "stripe",
  "external_order_id": "pay_123",
  "external_event_id": "evt_123",
  "subject_id": "<subject-id-from-create-subject>",
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

同一个 `Idempotency-Key` 和完全相同 payload 重放应返回 `idempotent_replay: true`；同 key 不同 payload 返回 `409 idempotency_conflict`。

## 5. 建议联调顺序

1. `GET /plans`，确认 `plan_paid_monthly_v1` 存在。
2. `POST /subjects`，使用收费侧测试 `provider + external_user_id` 创建 subject。
3. 保存 `subject.id`、`credential.key_prefix` 和首次返回的 `credential.key`。
4. 使用同一 `Idempotency-Key` 重放 `POST /subjects`，确认只返回 `key_prefix`，不再返回 key 原文。
5. 用新建 `subject_id` 发 `purchase` entitlement event。
6. 重放同一 `purchase`，确认幂等 replay。
7. `GET /users/{subject_id}/entitlements`，确认 current entitlement。
8. 发 `pause`、`resume` 或 `cancel`，确认状态流转。
9. `GET /entitlement-events/{idempotency_key}`，按 key 对账。`idempotency_key` 放在 path 时需要 URL-encode。
10. `GET /usage`，验证 usage 查询格式；没有流量时 rows 可以为空。
11. 测试结束后调用 `POST /subjects/{subject_id}/disable` 清理测试 subject。

## 6. 已完成验证

2026-05-11 测试环境已完成：

- 公网 `https://gw.instmarket.com.au/gateway/health` 通过。
- 未带 billing token 访问 Billing Admin API 返回 401。
- 带 billing token 访问 `/plans` 返回 `plan_paid_monthly_v1`。
- 注册开户链路通过：创建 subject、返回 `cgu_live_*`、幂等 replay、重复 external user 冲突、停用清理。
- Entitlement 链路通过：临时 subject 完成 `purchase`、幂等 replay、`cancel`、entitlements 查询。
- 测试 subject 和测试 key 已清理。

## 7. 对接方注意事项

- Billing Admin token 只能在收费/充值团队后端使用。
- 注册表单中的邮箱、手机号、密码、支付账户、账单地址等敏感信息不要传给 MedEvidence。
- `credential.key` 只在首次创建或轮换响应中返回一次。请在收费侧做好安全展示、复制和备份提示。
- 下单时客户端只选择收费侧 SKU；收费后端负责映射到 MedEvidence `plan_id`。
- 退款不会自动停权。如需停权，收费后端显式发送 `cancel` 或 `pause`。
- 所有响应的 `x-request-id` 建议入库，便于联调和对账排障。
