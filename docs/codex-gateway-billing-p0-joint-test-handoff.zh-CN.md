# Codex Gateway Billing P0 联调交付说明

更新时间：2026-05-11

本文只描述当前测试环境已部署、可联调的 Billing Admin P0 范围。完整设计和后续 P1 钱包说明见 `docs/codex-gateway-billing-integration-guide.zh-CN.md`。

## 1. 测试环境

- Base URL：`https://gw.instmarket.com.au`
- Billing Admin 前缀：`/gateway/admin/billing/v1`
- 认证：`Authorization: Bearer <billing-admin-token>`
- Token 由 Gateway 运维侧通过安全渠道单独交付；不要写入代码库、日志、截图或工单正文。
- 当前部署代码版本：`e1efe72`（2026-05-11）。本次发布由本地打包上传到 VM 后重建容器完成，不要求联调方从 Git 拉代码。
- v2 provisioning 已配置并通过 Gateway 端到端 smoke；收费团队正式接入 `/subjects` 前，建议先完成 v2 侧日志/disabled principal 验收确认。

普通 `cgw.*`、`cmev1.*`、`cgu_live_*` 业务 key 不能访问 Billing Admin API。

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

暂不纳入本轮联调：

- P1 充值钱包：`credit-events`、`balance`、`ledger`。

说明：`/subjects` 已随 Gateway 部署，且 v2 provisioning 已完成 Gateway smoke。收费团队可以开始受控联调“开户注册 -> 拿 opaque key -> 支付事件 -> entitlement 生效/暂停/恢复/取消 -> 查询权益和 usage”的链路。生产灰度前仍建议补完 v2 侧日志确认、disabled principal 行为确认和测试 token 轮换验收。

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

1. `POST /subjects`，使用收费侧测试 `provider + external_user_id` 创建 Gateway subject，保存 `subject.id` 和 `credential.key_prefix`。
2. 确认响应中的 `credential.key` 只出现一次；同一个 `Idempotency-Key` replay 时只应返回 `key_prefix`，不再返回 key 原文。
3. `GET /plans`，确认 `plan_paid_monthly_v1` 存在。
4. 使用新建 `subject_id` 发 `purchase`。
5. 重放同一 `purchase`，确认幂等 replay。
6. `GET /users/{subject_id}/entitlements`，确认 current entitlement。
7. 发 `pause`、`resume` 或 `cancel`，确认状态流转。
8. `GET /entitlement-events/{idempotency_key}`，按 key 对账。
9. `GET /usage`，验证 usage 查询格式；没有流量时 rows 可以为空。
10. 测试结束后调用 `POST /subjects/{subject_id}/disable` 清理测试 subject。

## 6. 已完成冒烟

2026-05-11 测试环境已完成：

- 容器健康检查通过。
- 公网 `https://gw.instmarket.com.au/gateway/health` 通过。
- 未带 billing token 访问 `/plans` 返回 401。
- 带 billing token 访问 `/plans` 返回 `plan_paid_monthly_v1`。
- 临时 subject 完成 `purchase`、幂等 replay、`cancel`、entitlements 查询。
- 临时 key 已撤销，临时用户已禁用。
- Gateway 公网 OpenAI-compatible smoke、`/gateway/credentials/current`、strict tools smoke 均通过。
- v2 自动开户注册 smoke 通过：create subject、v2 create principal/key、opaque `cgu_live_*` resolve、幂等 replay、重复 external user 冲突、disable cleanup。
