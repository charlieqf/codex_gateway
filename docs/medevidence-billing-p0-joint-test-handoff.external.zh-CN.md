# MedEvidence Billing P0 联调交付说明（外发版）

更新时间：2026-05-13

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

待审核/待补齐后联调：

- 三档月订阅：低档 50 元 / 1,000,000 tokens，中档 100 元 / 2,000,000 tokens，高档 200 元 / 3,000,000 tokens。
- 升级扩容：同一订阅周期内升级套餐时不清零已用量，只扩容总额度。例如低档已用 500,000 tokens 后升级中档，升级后用量应显示为 500,000 / 2,000,000。
- 该升级扩容语义需要 MedEvidence 在替换 entitlement 时把旧 entitlement 当前周期 token usage 结转到新 entitlement 的 token 窗口；MedEvidence 侧 entitlement 周期 token window 已完成开发和本地自测，完成测试环境部署和双方联调验证前，不作为已开放联调能力。
- 升级扩容属于 P0 范围内的能力增强，基于现有 entitlement model，不依赖 P1 充值钱包；当前待补齐的是三档 plan 创建、测试环境部署验证和双方联调验证。

当前可以开始受控联调：

```text
开户注册 -> 拿 opaque key -> 支付事件 -> entitlement 生效/暂停/恢复/取消 -> 查询权益和 usage
```

## 3. 初始 plan 与三档套餐审核稿

测试环境已创建并验证以下 plan：

```text
plan_paid_monthly_v1
```

该 plan 用于 MedCode Pro Monthly 初始月付权益。收费侧 SKU 映射建议先指向这个 `plan_id`。

三档上线后，`plan_paid_monthly_v1` 的处理（保留为内部测试、停售、企业/特殊 plan，或迁移已有用户）由 MedEvidence 单独说明；收费侧消费者 SKU 不再映射到该 plan。

三档月订阅目标配置如下，待双方审核后创建并联调：

| 收费侧档位 | 建议 `plan_id` | 月价格 | 月 token 额度 |
| --- | --- | --- | --- |
| 低档 | `plan_basic_monthly_v1` | 50 元/月 | 1,000,000 |
| 中档 | `plan_standard_monthly_v1` | 100 元/月 | 2,000,000 |
| 高档 | `plan_premium_monthly_v1` | 200 元/月 | 3,000,000 |

价格审核备注：以上价格按当前讨论稿记录。高档按 200 元 / 3,000,000 tokens 计算，单价约 66.7 元 / 1,000,000 tokens，高于低档和中档的 50 元 / 1,000,000 tokens。请产品/收费团队在创建正式 plan 前确认这是有意的运营成本定价，还是额度或价格需要调整。

价格、订单、发票、退款、升级补差价由收费侧处理；MedEvidence 只根据 `plan_id`、entitlement 状态和 token usage 判断模型访问权益。

月额度口径：对有 active entitlement 的用户，`tokens_per_month` 按该 entitlement 的 `period_start` / `period_end` 作为额度窗口，不按 UTC 自然月重置。例如 `2026-05-11T00:00:00.000Z` 到 `2026-06-11T00:00:00.000Z` 是一个完整额度窗口。`tokens_per_minute` / `tokens_per_day` 仍按 UTC 自然分钟 / UTC 自然日计算，不绑定 entitlement 周期；它们属于风控保护参数。

## 4. 请求约定

所有写入请求必须带 `Idempotency-Key`。完整推荐模板见 `docs/medevidence-billing-integration-guide.external.zh-CN.md` 的“3.1 幂等”；本交付说明只列出本轮联调会用到的具体例子。

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

`external_user_id` 只能使用 `[A-Za-z0-9._-]`，长度 1..128。

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

示例升级扩容：

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
  "subject_id": "<subject-id-from-create-subject>",
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

升级扩容建议沿用原订阅周期的 `period_start` / `period_end`，不要重置周期。收费侧在支付成功后发送升级事件；目标上线版本中，MedEvidence 侧负责把旧套餐当前周期已用 token 结转到新套餐额度窗口。

升级结转触发口径（已完成本地开发自测，待测试环境部署和联调验证）：

- MedEvidence 应在 `replace_current=true` 且新 `plan_id` 与被替换 entitlement 的 `plan_id` 不同的事件中执行 token usage 结转。
- `metadata.change_type`、`metadata.from_plan_id`、`metadata.to_plan_id` 仅用于 audit、日志和跨团队排障，不作为 MedEvidence 行为触发条件。
- 如当前 subject 已存在未来 scheduled entitlement，收费侧需要同时传 `replace_scheduled=true`；否则 MedEvidence 会返回 `409 invalid_entitlement_transition`，由收费侧人工确认后重试。
- 降级（高档到低档）不在 P0 范围；降级建议在下一周期续费时通过新 `plan_id` 生效。

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

三档月订阅和升级扩容联调建议在上述基础链路通过后追加：

12. `GET /plans`，确认 `plan_basic_monthly_v1`、`plan_standard_monthly_v1`、`plan_premium_monthly_v1` 已创建。
13. 创建测试 subject，购买低档 `plan_basic_monthly_v1`。
14. 产生或模拟同周期 token usage，例如 500,000 tokens。
15. 发送升级事件：`purchase` + `replace_current=true`，新 `plan_id=plan_standard_monthly_v1`，周期沿用原 `period_start` / `period_end`。
16. 查询 `GET /gateway/admin/billing/v1/users/{subject_id}/entitlements`，确认 `current.plan_id` 已切到新档；查询 `GET /gateway/admin/billing/v1/usage?subject_id=...&from=...&to=...&group_by=none`，确认周期内 token 用量仍为 500,000。升级后剩余额度应按新套餐月额度 2,000,000 减去已用 500,000 计算，即 1,500,000。

## 6. 已完成验证

2026-05-11 测试环境已完成：

- 公网 `https://gw.instmarket.com.au/gateway/health` 通过。
- 未带 billing token 访问 Billing Admin API 返回 401。
- 带 billing token 访问 `/plans` 返回 `plan_paid_monthly_v1`。
- 注册开户链路通过：创建 subject、返回 `cgu_live_*`、幂等 replay、重复 external user 冲突、停用清理。
- Entitlement 链路通过：临时 subject 完成 `purchase`、幂等 replay、`cancel`、entitlements 查询。
- 测试 subject 和测试 key 已清理。

截至 2026-05-13，三档月订阅 plan 仍处于方案审核/创建前阶段；“升级扩容保留已用量”的 entitlement 周期 token window 已完成本地开发自测，但尚未作为测试环境已验证能力对外开放。

2026-05-13 本地开发自测已完成：entitlement 周期 token window 已支持跨 UTC 自然月不重置；例如 5 月 31 日产生的同一 entitlement 周期 usage，会在 6 月 1 日继续计入 `2026-05-11` 到 `2026-06-11` 的额度窗口。该能力仍需完成测试环境部署和双方联调验证后再开放给收费/充值团队联调。

## 7. 对接方注意事项

- Billing Admin token 只能在收费/充值团队后端使用。
- 注册表单中的邮箱、手机号、密码、支付账户、账单地址等敏感信息不要传给 MedEvidence。
- `credential.key` 只在首次创建或轮换响应中返回一次。请在收费侧做好安全展示、复制和备份提示。
- 下单时客户端只选择收费侧 SKU；收费后端负责映射到 MedEvidence `plan_id`。
- 升级套餐时，收费后端负责订单、补差价和支付成功判定；支付成功后再发送升级 entitlement event。
- 升级扩容不清零已用量，建议沿用原订阅周期；周期重置和退款后是否停权需另行明确产品规则。
- 降级不在 P0 范围；如需降级，建议在下一周期续费时切换 `plan_id`。
- 退款不会自动停权。如需停权，收费后端显式发送 `cancel` 或 `pause`。
- 所有响应的 `x-request-id` 建议入库，便于联调和对账排障。
