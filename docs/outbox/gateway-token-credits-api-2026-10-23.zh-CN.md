# Gateway 赠送／充值 Token 接口

2026-10-23。供身份后端、支付后端接入评审。已上线 Gateway `ea1ca39`，北京时间 2026-10-23 05:49 完成线上验收，可开始联调。

本期确认：每次发放给账户净增加指定数量 Token，永久有效；原免费额度、套餐、已用量、模型 Key 和有效期均保留。套餐日／月 Token 额度不足时，自动使用追加余额。

## 接口与鉴权

统一前缀 `/gateway/admin/billing/v1`，沿用服务端专用 `Authorization: Bearer <billing-admin-token>`。客户端模型 Key 和身份／支付 access_token 不能调用。生产服务地址沿用 `https://goldencode.instmarket.com.au:1443`。

| 用途 | 方法与相对路径 |
| --- | --- |
| 赠送或充值 Token | `POST /token-credit-events` |
| 按幂等键查发放结果 | `GET /token-credit-events/{url_encoded_idempotency_key}` |
| 查追加 Token 的实时余额 | `GET /users/{subject_id}/token-credits` |
| 查账户发放流水 | `GET /users/{subject_id}/token-credit-events?limit=50&cursor=...` |

余额接口只统计新接口的追加 Token。注册免费额度、旧赠送 Plan 和付费套餐额度仍各自记账；不要把追加余额当成账户所有额度的总和。流水按入账顺序分页，limit 默认 50、范围 1–200，后续使用原样返回的 next_cursor，null 表示当前已读完。

## 发放请求

支付后端确认订单成功后调用充值事件；身份后端或运营活动调用赠送事件。同一订单只发放一次 Token。

```http
POST /gateway/admin/billing/v1/token-credit-events
Authorization: Bearer <billing-admin-token>
Idempotency-Key: medevidence_billing:ORDER_123:topup
Content-Type: application/json
```

```json
{
  "subject_id": "<已存在的 Gateway subject_id>",
  "provider": "medevidence_billing",
  "external_event_id": "ORDER_123:token_credit",
  "external_order_id": "ORDER_123",
  "event_type": "topup",
  "tokens": 20000000,
  "reason": "购买 2000 万 Token 加量包"
}
```

赠送示例使用独立幂等键，如 `medevidence_billing:campaign_202610:subject_123`：

```json
{
  "subject_id": "<已存在的 Gateway subject_id>",
  "provider": "medevidence_billing",
  "external_event_id": "campaign_202610:subject_123",
  "event_type": "gift",
  "tokens": 5000000,
  "reason": "活动赠送 500 万 Token"
}
```

| 字段 | 规则 |
| --- | --- |
| Idempotency-Key | 必填；1–200 个 ASCII 字母、数字或 `._:-`；同一次业务重试保持不变 |
| subject_id | 必填；已存在且 active 的 Gateway 账户，不能传手机号代替 |
| provider | 必填；稳定的调用方业务标识，不能在重试时更换 |
| external_event_id | 必填；在 provider 内永久唯一，活动给多个账户发放时须包含账户维度 |
| external_order_id | topup 必填；同 provider 的同一订单只允许一笔 topup。gift 可省略或传 null |
| event_type | 仅 gift 或 topup；两者扣费规则相同，分别记录发放原因 |
| tokens | 正整数 Token 数，不接受字符串、小数、零、负数；单笔和账户累计发放均不得超过 9,007,199,254,740,991 |
| reason | 必填，1–500 字符；写业务原因，不传密钥、验证码或支付敏感信息 |

所有业务标识字段同样限 1–200 个 ASCII 字母、数字或 `._:-`。本期不接受 expires_at、plan_id、replace、refund 等额外字段。示例 subject_id 占位符须替换为真实 ID。

成功 HTTP 200：

```json
{
  "applied": true,
  "idempotent_replay": false,
  "credit_event": {
    "id": "tc_0123456789abcdef0123456789abcdef",
    "idempotency_key": "medevidence_billing:ORDER_123:topup",
    "subject_id": "subj_example",
    "provider": "medevidence_billing",
    "external_event_id": "ORDER_123:token_credit",
    "external_order_id": "ORDER_123",
    "event_type": "topup",
    "tokens": 20000000,
    "reason": "购买 2000 万 Token 加量包",
    "created_at": "2026-10-23T08:00:00.000Z",
    "expires_at": null
  },
  "token_credits": {
    "subject_id": "subj_example",
    "granted_tokens": 20000000,
    "charged_tokens": 0,
    "balance_tokens": 20000000,
    "reserved_tokens": 0,
    "available_tokens": 20000000,
    "expires_at": null
  }
}
```

granted_tokens 为累计追加；charged_tokens 为实际结算净消耗；balance_tokens 为两者之差；reserved_tokens 为在途请求预留；available_tokens 为当前可预留余额，即 `max(0, balance_tokens - reserved_tokens)`。余额查询返回同样的 token_credits 对象。

同幂等键、相同业务字段重试返回原 credit_event 和 `idempotent_replay=true`，不会追加第二次；token_credits 返回查询当时余额，可能因模型调用或后续发放而变化。保存幂等键、provider、业务事件号、订单号和 credit_event.id 对账。

## 扣费、有效期与边界

1. 保持现有免费／旧赠送与套餐的扣费关系：零售用户先用可参与扣费的免费／旧赠送额度，再用当期套餐可用额度，最后用新追加 Token。内部套餐仍沿用其原本是否使用旧赠送额度的规则。追加 Token 使用数量计费，与现有 Token 计数口径一致，不进行金额换算。
2. 当日和当月任一套餐 Token 额度不足，不足部分均可由追加余额支付；套餐额度次日或下周期恢复后，优先用恢复后的套餐额度。一个请求可跨多个额度结算。
3. 例如免费剩 100 万、套餐当日剩 200 万、追加余额 1000 万，一次结算 400 万 Token：分别扣 100 万、200 万、100 万，追加余额剩 900 万。这里只演示账本拆分，实际请求仍须满足每分钟与单次限制。
4. 追加余额不随套餐到期、替换、取消或日／月额度重置而清零。它不延长模型 Key、不解除停用、不发放套餐或图像等能力。调用仍需有效凭据和原有访问权益；正常有注册 Free 的账户在付费到期后可通过该 Free 权益继续消费余额。仅有已到期权益的历史账户须另恢复合法访问权益，余额本身保留。
5. requests/day、请求频率、每分钟 Token、单次输入／总量上限及模型访问权限仍生效。追加余额不足且套餐也不足时拒绝新请求，不会重复消耗同一份预留。
6. 模型结束后按实际应计用量结算，释放多余预留。被现有规则免收的失败尝试不扣追加余额。超时采用原有缺失用量规则暂结，实际用量补回后只校正一次。
7. 上游实际消耗可能超过请求前估算，已发生的超额仍记账，balance_tokens 可能短暂为负，available_tokens 最低为 0；后续发放先抵这部分已发生用量。调用方应展示余额及预留，不把请求前估算视为最终账单。
8. 本期不提供负数发放、退款扣回、过期余额、金额钱包或同周期套餐升级结转。资金退款由支付后端处理；如退款还需撤回 Token，必须另行约定补偿接口，不能用 quota-reset 或取消套餐模拟。

客户端现有 `GET /gateway/credentials/current` 的 `token_usage` 增加 `token_credits`，并在有追加账户时返回 `accounting_mode=free_then_plan_then_credits_v1`。现有 day/month 与 free_allowance 仍表示原账本；账户页中的其他钱包占位字段不代表此余额。

## 错误与重试

| HTTP／错误码 | 处理 |
| --- | --- |
| 400 invalid_request | 修正字段；未到账；不能传负数模拟退款 |
| 401／403 | 核查服务端 Billing Admin 凭据与权限 |
| 404 subject_not_found | 先确认身份后端保存的 Gateway subject_id |
| 404 token_credit_event_not_found | 查询时尚无该幂等键；可重发原始请求，保持原 key 和业务字段 |
| 409 idempotency_conflict | 原 key 的业务字段改变，或换 key 重用了业务事件／充值订单；停止自动重试，核对原事件 |
| 409 account_disabled | 新发放目标不是 active；先处理账户状态。已成功事件仍可按原请求查询／重放 |
| 429 | 管理接口限流，按 Retry-After 重试 |
| 5xx／网络超时 | 结果未知，先查原幂等键，再按原请求重试；不能换 key、业务事件号或订单号 |

模型调用因追加余额不足可返回 `429 token_credit_exhausted`；免费账户也可能沿用 `free_quota_exhausted`。这两类不足不带按日自动恢复的承诺，应查询各账本余额。它们与上述发放接口限流不同。

联调验收应覆盖：同一账户多笔赠送及充值、重复支付回调、换 key 重复订单拦截、原套餐已用量保持、日／月额度耗尽后继续使用、付费到期保留余额、在途预留、实际用量释放、失败免收、超时查询和断线重试。
