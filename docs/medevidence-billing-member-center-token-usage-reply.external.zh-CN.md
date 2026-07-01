# MedEvidence 会员中心 Token 用量查询说明

日期：2026-05-26

本文用于“给一个查询用户单月消耗 token 的接口，可以放到会员中心展示给客户”。

## 1. 接入边界

- 会员中心前端不要直接请求 MedEvidence Billing Admin API。
- Billing Admin token 只允许保存在收费支付团队后端。
- 收费支付后端负责校验当前登录用户身份，并根据自己的用户 ID 查到对应的 MedEvidence `subject_id`。
- MedEvidence usage 接口只返回聚合统计值，不返回 prompt、completion 文本，也不返回 API key 原文。

如果收费系统本地已经保存了开户时返回的 `subject.id`，请直接使用该 `subject_id` 查询 usage。

如果只保存了收费侧用户 ID，可以先通过外部用户 ID 查询 subject：

```http
GET /gateway/admin/billing/v1/subjects?provider=medevidence_billing&external_user_id=<external_user_id>
Authorization: Bearer <billing-admin-token>
```

## 2. 推荐展示口径

会员中心建议展示“当前订阅周期已用量”，而不是简单按自然月展示。原因是 MedEvidence 的月 token 额度按用户 active entitlement 的 `period_start` / `period_end` 计算，不一定等于自然月。

推荐流程：

1. 查询用户当前 entitlement，拿到 `period_start`、`period_end` 和 `plan_id`。
2. 用 `period_start` / `period_end` 查询 usage。
3. 会员中心展示 `total_tokens` 作为已用 token。
4. 总额度使用该 `plan_id` 对应的 `tokens_per_month`。
5. 剩余额度由收费支付团队后端计算：`remaining = max(tokens_per_month - total_tokens, 0)`。

如果产品明确需要“自然月报表”，也可以按自然月传 `from` / `to` 查询。

## 3. 查询当前 entitlement

```http
GET /gateway/admin/billing/v1/users/{subject_id}/entitlements?limit=10
Authorization: Bearer <billing-admin-token>
```

响应中 `current` 表示当前有效权益。示例：

```json
{
  "subject_id": "subj_xxx",
  "current": {
    "id": "ent_xxx",
    "plan_id": "plan_standard_monthly_v1",
    "state": "active",
    "period_kind": "monthly",
    "period_start": "2026-05-11T00:00:00.000Z",
    "period_end": "2026-06-11T00:00:00.000Z"
  },
  "history": [],
  "next_cursor": null
}
```

如果 `current` 为 `null`，说明该用户当前没有 active entitlement。会员中心可以展示为未开通、已过期或无可用套餐，具体文案由收费支付团队按订单状态决定。

## 4. 查询当前订阅周期 token 用量

使用上一步拿到的 `period_start` / `period_end`：

```http
GET /gateway/admin/billing/v1/usage?subject_id=subj_xxx&from=2026-05-11T00:00:00.000Z&to=2026-06-11T00:00:00.000Z&group_by=none
Authorization: Bearer <billing-admin-token>
```

示例响应：

```json
{
  "subject_id": "subj_xxx",
  "from": "2026-05-11T00:00:00.000Z",
  "to": "2026-06-11T00:00:00.000Z",
  "group_by": "none",
  "rows": [
    {
      "period_start": null,
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

字段说明：

- `total_tokens`：建议作为会员中心“已用 token”的主展示值。
- `prompt_tokens` / `completion_tokens`：输入和输出 token，用于明细展示或内部对账。
- `estimated_tokens`：当上游没有返回精确 usage 时，MedEvidence 记录的估算部分；它是辅助说明字段。若该值大于 0，可以在内部对账中标注“其中包含估算量”。
- `request_count`：该周期内记录到的请求数。
- `success_count` / `error_count`：成功和失败请求数。

如果 `rows` 为空，表示该周期内没有记录到 token 消耗，会员中心可以按 0 展示。

## 5. 查询自然月用量

如果会员中心或报表确实要展示自然月，例如 2026 年 5 月：

```http
GET /gateway/admin/billing/v1/usage?subject_id=subj_xxx&from=2026-05-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z&group_by=none
Authorization: Bearer <billing-admin-token>
```

如果需要一次查询多个月并按月分组，可以使用 `group_by=month`：

```http
GET /gateway/admin/billing/v1/usage?subject_id=subj_xxx&from=2026-05-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z&group_by=month
Authorization: Bearer <billing-admin-token>
```

注意：单次查询时间范围不能超过 90 天。

## 6. 查询套餐额度

如果收费支付后端已经保存了 SKU 到 `plan_id` 和月额度的映射，可以直接使用本地配置计算剩余额度。

如果希望从 MedEvidence 获取当前 plan 配置，可以查询：

```http
GET /gateway/admin/billing/v1/plans
Authorization: Bearer <billing-admin-token>
```

plan 中的 `token_policy.tokens_per_month` 是该套餐月 token 额度。会员中心展示可按以下方式组装：

```json
{
  "subject_id": "subj_xxx",
  "plan_id": "plan_standard_monthly_v1",
  "period_start": "2026-05-11T00:00:00.000Z",
  "period_end": "2026-06-11T00:00:00.000Z",
  "used_tokens": 15200,
  "tokens_per_month": 2000000,
  "remaining_tokens": 1984800,
  "request_count": 12
}
```

## 7. 收费支付后端建议封装

建议收费支付后端封装一个面向会员中心的接口，例如：

```http
GET /api/member/medcode/token-usage/current
Cookie: <member-session>
```

收费支付团队后端内部处理：

1. 根据登录态确认当前用户。
2. 通过本地映射找到 MedEvidence `subject_id`。
3. 调 MedEvidence `GET /users/{subject_id}/entitlements` 获取当前周期。
4. 调 MedEvidence `GET /usage` 获取当前周期 token 消耗。
5. 根据 plan 月额度计算剩余额度。
6. 返回会员中心前端需要展示的精简字段。

前端不需要知道 Billing Admin token，也不需要知道 MedEvidence 内部 subject 查询过程。

## 8. 错误处理建议

- `401 missing_credential` / `401 invalid_credential`：Billing Admin token 缺失、错误或已失效；后端应告警，不应透传给用户。
- `404 subject_not_found`：用户还没有在 MedEvidence 开户，或 subject 已停用；会员中心可展示未开通或联系支持。
- `400 invalid_request`：`subject_id`、`from`、`to` 或 `group_by` 参数错误；后端应记录日志并修正调用。
- `429 rate_limited`：触发后台限流；后端应做缓存和退避重试。
- `5xx`：临时服务错误；会员中心可以展示“用量暂时无法获取，请稍后刷新”。
