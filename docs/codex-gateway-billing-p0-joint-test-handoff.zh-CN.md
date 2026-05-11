# Codex Gateway Billing P0 联调交付说明

更新时间：2026-05-11

本文只描述当前测试环境已部署、可联调的 Billing Admin P0 范围。完整设计和后续 P1 钱包说明见 `docs/codex-gateway-billing-integration-guide.zh-CN.md`。

## 1. 测试环境

- Base URL：`https://gw.instmarket.com.au`
- Billing Admin 前缀：`/gateway/admin/billing/v1`
- 认证：`Authorization: Bearer <billing-admin-token>`
- Token 由 Gateway 运维侧通过安全渠道单独交付；不要写入代码库、日志、截图或工单正文。

普通 `cgw.*`、`cmev1.*`、`cgu_live_*` 业务 key 不能访问 Billing Admin API。

## 2. 当前可联调范围

已开放：

- `GET /gateway/admin/billing/v1/plans`
- `POST /gateway/admin/billing/v1/entitlement-events`
- `GET /gateway/admin/billing/v1/entitlement-events/{idempotency_key}`
- `GET /gateway/admin/billing/v1/entitlement-events?provider=...&external_order_id=...&subject_id=...`
- `GET /gateway/admin/billing/v1/users/{subject_id}/entitlements`
- `GET /gateway/admin/billing/v1/usage?subject_id=...&from=...&to=...&group_by=day`

暂未开放：

- `/subjects` 注册、查询、禁用接口。
- `/subjects/{subject_id}/keys` 发 key 接口。
- P1 充值钱包：`credit-events`、`balance`、`ledger`。

因此当前 P0 联调前提是：`subject_id` 已由 Gateway 侧或现有注册流程创建。收费团队可以先联调“支付事件 -> entitlement 生效/暂停/恢复/取消 -> 查询权益和 usage”的链路。

## 3. 初始计划

测试环境已创建并验证以下 plan：

```text
plan_paid_monthly_v1
```

该 plan 用于 MedCode Pro Monthly 初始月付权益。收费侧 SKU 映射建议先指向这个 `plan_id`。

## 4. 关键请求约定

所有写入请求必须带 `Idempotency-Key`：

```http
Idempotency-Key: <provider>:<order-or-subscription-id>:<event-type>:<event-id>
```

示例 purchase：

```json
{
  "event_type": "purchase",
  "apply_mode": "apply",
  "provider": "stripe",
  "external_order_id": "pay_123",
  "external_event_id": "evt_123",
  "subject_id": "<gateway-subject-id>",
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
2. 使用 Gateway 侧提供的测试 `subject_id` 发 `purchase`。
3. 重放同一 `purchase`，确认幂等 replay。
4. `GET /users/{subject_id}/entitlements`，确认 current entitlement。
5. 发 `pause`、`resume` 或 `cancel`，确认状态流转。
6. `GET /entitlement-events/{idempotency_key}`，按 key 对账。
7. `GET /usage`，验证 usage 查询格式；没有流量时 rows 可以为空。

## 6. 已完成冒烟

2026-05-11 测试环境已完成：

- 容器健康检查通过。
- 公网 `https://gw.instmarket.com.au/gateway/health` 通过。
- 未带 billing token 访问 `/plans` 返回 401。
- 带 billing token 访问 `/plans` 返回 `plan_paid_monthly_v1`。
- 临时 subject 完成 `purchase`、幂等 replay、`cancel`、entitlements 查询。
- 临时 key 已撤销，临时用户已禁用。
