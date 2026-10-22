# Gateway Token 发放接口供身份后端和支付后端评审

2026-10-22。适用：身份后端、支付后端。

2026-10-23 补充：赠送／充值净追加 Token 功能已在 Gateway `ea1ca39` 上线并通过公网验收，接口合同见[赠送／充值 Token 接口](gateway-token-credits-api-2026-10-23.zh-CN.md)，身份／支付后端可开始联调。

现有接口支持手机号开户并发放注册免费额度、套餐购买与续费、权益状态变更、用量对账和模型 Key 管理。请重点确认双方的用户映射、商品与套餐映射、支付事件处理和额度展示口径。

## 接口清单

服务地址：`https://goldencode.instmarket.com.au:1443`。

下表路径统一加前缀 `/gateway/admin/billing/v1`。均由后端使用专用 Billing Admin 凭据调用：

```http
Authorization: Bearer <billing-admin-token>
Content-Type: application/json
```

Billing Admin 凭据只保存在服务端。它与用户的身份／支付 access_token、客户端模型 Key（`cgu_live_*`）分别管理。

| 用途 | 方法与相对路径 | 对接说明 |
| --- | --- | --- |
| 手机号账户关联 | `POST /subjects/resolve` | 身份后端可选调用；输入 provider、external_user_id、已验证手机号，返回 linked／create_ready／account_pending |
| 开户并发注册免费额度 | `POST /subjects` | 身份后端；手机号新开户自动准备账户、Key、手机号登录和一次性免费额度 |
| 按外部用户查询账户 | `GET /subjects?provider=...&external_user_id=...` | 两端；取回已有 subject.id，处理重复开户 |
| 按 Gateway 账户查询 | `GET /subjects/{subject_id}` | 两端；查询账户状态和凭据摘要，不返回完整 Key |
| 查询套餐 | `GET /plans` | 支付后端；取得 Plan ID 和策略，需按约定的可售商品白名单筛选 |
| 发放及变更权益 | `POST /entitlement-events` | 支付后端；统一处理 purchase／renew／pause／resume／cancel／notice |
| 查询单次发放结果 | `GET /entitlement-events/{url_encoded_idempotency_key}` | 支付后端；超时后确认原业务事件是否已应用 |
| 按订单查询事件 | `GET /entitlement-events?provider=...&external_order_id=...` | 支付后端；支持 subject_id、limit、cursor，用于对账 |
| 查询用户权益 | `GET /users/{subject_id}/entitlements` | 两端；返回 current、可能存在的 free_allowance、history 和 next_cursor |
| 查询模型消耗 | `GET /usage?subject_id=...&from=...&to=...&group_by=...` | 两端；group_by 支持 day／month／none／model，单次最多 90 天，支持分页及 public_model_id 筛选 |
| 轮换模型 Key | `POST /subjects/{subject_id}/keys` | 账户管理；输入 reason、revoke_previous、grace_period_seconds，不增加 Token 额度 |
| 停用账号 | `POST /subjects/{subject_id}/disable` | 账户管理；停用账户、撤销凭据并取消权益，保留历史记录，不自动退款 |

开户、权益事件、Key 轮换、账号停用需传 `Idempotency-Key`；手机号 resolve 不要求该请求头。

## 调用流程

### 手机号开户与注册额度

1. 身份后端完成手机号验证，以稳定的 `provider + external_user_id` 关联用户。生产 external_user_id 沿用 `str(user_id)`，不要因登录入口变化另建用户 ID。
2. 直接调用 `POST /subjects` 并传 phone，无需先 resolve。新用户成功后保存 `subject.id`；所有后续支付和用量查询使用这个 ID。
3. 若返回 `409 subject_already_exists`，按 provider／external_user_id 查询并复用原账户。不要更换用户 ID 或幂等键反复开户。

```http
POST /gateway/admin/billing/v1/subjects
Authorization: Bearer <billing-admin-token>
Idempotency-Key: medevidence_billing:123456789:create_subject
Content-Type: application/json
```

```json
{
  "provider": "medevidence_billing",
  "external_user_id": "123456789",
  "phone": "<已验证的大陆手机号>",
  "scope_allowlist": ["code"],
  "metadata": { "signup_source": "pc" }
}
```

示例用户 ID、手机号和来源须替换为实际值。若使用可选 resolve：linked 表示复用已有账户；create_ready 表示可以开户；account_pending 表示继续原开户事件，保持原请求体和幂等键。

新手机号开户自动发放一次性 **500 万 Token**。重复登录、开户重试和购买套餐不补发、不清零。完全不传 phone、也没有先前 resolve 关联的旧式开户，不自动获得手机号登录能力和注册免费额度。

`credential.key` 只在首次开户成功响应返回，幂等重放不再次返回原文；客户端按既有手机号登录与 bootstrap 流程领取当前 Key。

`metadata.signup_source` 由身份后端按真实来源上报。`pc/yhb/wxapp/web/h5` 的定义需双方确认，Gateway 不据此判断用户已下载或安装客户端。

### 套餐购买与续费

1. 支付后端将已确认的商品 SKU 映射到 Plan ID，并计算本次权益起止时间。
2. 支付成功后发送 `POST /entitlement-events`。首次从免费转付费使用 purchase；已有有效付费权益的下一期使用 renew。
3. 核对 `applied=true`、`billing_event.status=applied`，以及返回的 subject_id、Plan 和周期；保存 billing_event.id、entitlement.id。
4. 超时后先按原幂等键查询，必要时以完全相同的请求重试。

月付购买示例：

```http
POST /gateway/admin/billing/v1/entitlement-events
Authorization: Bearer <billing-admin-token>
Idempotency-Key: medevidence_billing:example-order:purchase
Content-Type: application/json
```

```json
{
  "event_type": "purchase",
  "apply_mode": "apply",
  "provider": "medevidence_billing",
  "external_order_id": "example-order",
  "external_event_id": "example-payment-event",
  "subject_id": "<开户返回的 subject.id>",
  "plan_id": "plan_paid_monthly_v1",
  "period_kind": "monthly",
  "period_start": "2026-10-22T00:00:00.000Z",
  "period_end": "2026-11-22T00:00:00.000Z"
}
```

示例订单、Subject 和日期须替换为实际值。provider、external_order_id、subject_id 必填；应用 purchase／renew 时还需 plan_id 和合法周期。`amount_minor`、`currency`、`metadata` 可用于审计，不能通过金额或请求中的 Token 数量覆盖套餐额度。

| event_type | 业务作用 | 调用规则 |
| --- | --- | --- |
| purchase | 按指定 Plan 创建权益 | 原免费／合规赠送额度与零售月年付并存，先消耗免费／赠送额度，不重新发放免费额度 |
| renew | 创建下一期权益 | 未来开始的权益为 scheduled；默认不能与当前期重叠；免费无限期权益或已无 active 权益的账户不能直接按 renew 处理 |
| pause | 暂停权益 | 不自动暂停扣款，也不延后权益结束时间 |
| resume | 恢复权益 | 遵循合法状态流转，不重新发放额度或重置周期 |
| cancel | 取消权益 | 不自动退款；独立免费额度可能继续可用，取消付费权益不等于停用账号 |
| notice | 记录外部事件 | 必须使用 apply_mode=log_only，不改变权益；其他事件使用 log_only 也仅作记录 |

状态变更可传 `entitlement_id` 明确目标权益，并用 `reason` 记录原因。停止后续自动续费由支付后端处理，不应自动等同于立即 cancel 当前有效权益。

## 关键规则

### 套餐额度与周期

以下为 2026-10-22 已确认的套餐模板。已发放权益按发放时保存的策略执行，新模板不会自动改变历史权益。

| 用途 | Plan ID | Token 额度与周期 |
| --- | --- | --- |
| 注册免费额度 | `plan_free_once_1m_v1` | 一次性 5,000,000，终身有效、不自动重置；无额外日／月上限；ID 中 1m 为历史命名 |
| 零售月付 | `plan_paid_monthly_v1` | 每天 5,000,000，每计费月 150,000,000；period_kind=monthly，传一个月起止时间 |
| 零售年付 | `plan_paid_yearly_v1` | 每天 6,000,000，每个 UTC 自然月 200,000,000，无年度总上限；period_kind=one_off，传一年起止时间 |

日限额按 UTC 自然日；月付月窗口按订阅周期，年付月窗口按 UTC 自然月。月付校验 28–31 天、年付校验 365–366 天，均允许一小时夏令时偏移；月末和闰年日期由支付端计算。以上三个模板当前每分钟上限均为 600,000 Token。

`GET /plans` 包含非销售用途的模板。`active` 表示模板可用，不表示获准销售；支付侧须维护约定的 SKU → Plan 白名单。

月／年付成功购买或续费会按条件延长当前 Desktop 模型 Key 的有效期，以覆盖付费期；不缩短更长有效期，不恢复已撤销 Key。到期 90 天内的当前 Desktop Key 可随付款恢复，超过范围需另行处理凭据恢复。

### 幂等与错误处理

- `Idempotency-Key` 格式为 `[A-Za-z0-9._:-]{1,200}`。同一业务事件始终使用同一个 key 和完全相同的请求体。
- 同 key 同请求返回历史结果；同 key 不同请求返回 `409 idempotency_conflict`，应停止自动重试并核对原事件。
- 权益事件 HTTP 200 后仍须检查 applied 和事件状态；log_only 正常返回 applied=false、status=ignored，不表示发放成功。
- 网络超时或 5xx 后查原事件并按原请求重试；429 遵守 Retry-After。身份冲突、非法字段和非法状态流转先处理原因，不换幂等键重复发放。
- 保存订单号、幂等键、billing_event.id、entitlement.id 和 x-request-id，供双方对账与排障。

### 套餐替换与额度追加

已有付费权益时，应先确定替换规则。`replace_current=true` 会取消旧权益并创建新权益；`replace_scheduled=true` 会取消未来权益；`replace_paused=true` 可配合替换取消暂停权益。不要在冲突后自动开启这些参数。

**不能把套餐替换视为“保留已用量、只追加 Token”。** 本期已上线独立 `POST /token-credit-events`，支持 gift／topup，按正整数净追加、永久有效、套餐日／月额度不足后继续消费；保留原权益和用量。具体字段与幂等规则见[新接口合同](gateway-token-credits-api-2026-10-23.zh-CN.md)。原 `/entitlement-events` 的事件枚举不变；同周期升级结转、upgrade 和 refund 仍未实现。

资金退款由支付后端处理；需要取消或暂停模型权益时，另发对应事件。现有接口尚不支持金额钱包充值、退款冲正或按价格表扣余额。

quota-reset 用于运维清零计数，不能作为充值或赠送接口。

### 用量与余额

`GET /usage` 用于展示时间段内的模型消耗；`GET /users/{subject_id}/entitlements` 用于查询权益及周期。两者都不提供按免费／赠送／付费拆分的准确实时余额，不能直接用“当前套餐模板额度减报表消耗”计算所有账户的可用余额。

客户端已有基于用户模型凭据的额度查询。本期新增 `GET /users/{subject_id}/token-credits`，返回追加 Token 累计发放、结算消耗、余额、在途预留和可用余额；不包括原免费与套餐额度。若支付／会员中心需要全部额度合计，仍需另行约定各账本的统一展示。

## 双方待确认事项

请身份／支付后端按下表回传结论，便于固定对接合同和联调范围。

| 责任方 | 需确认事项 | 回传内容 |
| --- | --- | --- |
| 身份后端 | 稳定用户映射、手机号验证、已有账户复用、注册来源 | provider 和 external_user_id 规则；409 恢复方式；signup_source 枚举及其表示历史来源还是本次开户入口 |
| 支付后端 | 可售套餐、购买与续费周期 | SKU → Plan 对照；月末／闰年、提前续费、过期后再购买的处理规则 |
| 支付后端与 Gateway | 追加 Token 对接、升级、退款 | 追加已确定为永久有效，套餐不足后消费；回传 SKU → Token 数、provider／业务事件号／订单与幂等键规则。升级结转、退款扣回另行约定 |
| 会员中心与 Gateway | 额度展示 | 需要消耗报表还是实时余额；实时余额所需字段和刷新频率 |
| 两端与 Gateway | 管理凭据和接口权限 | 服务端凭据保管与轮换责任、允许调用的接口和 Plan 范围；当前未按 provider／Plan／接口实施细粒度权限隔离 |

建议联调覆盖：首次开户赠送、已有账户复用、重复回调不重复发放、月付与年付周期、提前续费、免费额度与付费并存、取消与退款分离，以及超时后的查询和重试。
