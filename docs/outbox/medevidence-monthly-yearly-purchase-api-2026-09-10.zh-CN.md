# 月付与年付购买：Gateway 接口接入说明

日期：2026-09-10。年付 Plan 已于北京时间 19:07 创建并生效，公网套餐查询已验证。
本批沿用现有 Billing v1 接口，没有新增支付页面或修改客户端。

**后续确认的月付要求：保留 Free 每日免费额度，月付额度另行记账。**
以下接口表和 purchase 示例说明现有接口能力，不代表该新增双额度需求已经实现。
现有 replace_current 升级会替换免费权益，不能直接当作满足本次月付产品需求的实现。

## 当前三个对外档位

| 产品 | plan_id | token 总量策略 | 支付事件周期 |
| --- | --- | --- | --- |
| Free | plan_free_daily_10k_v1 | 新用户每日 10,000 token；无额外月总量上限 | 免费开户流程发放 |
| 月付 | plan_paid_monthly_v1 | 现有模板每日 5,000,000、每月 50,000,000 token；保留独立 Free 额度的需求待实现 | monthly，明确一个月起止时间 |
| 年付 | plan_paid_yearly_v1 | 无每日、每月或年度累计 token 上限 | one_off，明确一年起止时间 |

月付和年付都允许首次购买；续费是同一产品的后续权益事件，不是另一个对外等级。
年付显示名为 MedCode Pro Yearly，状态 active；功能范围沿用月付的 chat、tools、image_generation。
年付 tokens_per_day=null、tokens_per_month=null，不应显示为 0 或余额不足。
仍保留每分钟 300,000 token、单次输入 200,000／总量 300,000 token 的技术限制；
实际模型上下文和凭据现有请求频率、并发限制仍适用。

Gateway 的管理目录还包含内部、测试和历史 Plan。支付端按上表的明确映射呈现三档商品，
不能把 GET /plans 返回的全部 active 模板都直接上架。旧免费和其他历史权益不迁移。

## 月付保留 Free 基础额度的需求

Free 每日额度在购买月付后继续存在，不能转为付费额度、一次性加入月额度或被付费套餐覆盖。
按当前新用户 Free 每日 10,000 token 举例，扣减方案为优先使用当天免费额度，免费部分用尽后
再消耗月付额度：某天合计使用 20,000 token，免费消耗 10,000、月付消耗 10,000。
次日免费额度独立重置，未使用部分不累积，月付已使用量不因此重置。
存量用户原有免费权益版本不能被这次说明自动降额。

该模型需要把基础免费额度与付费额度分开记账，并在同一次模型请求的预留／结算中正确分配，
包括跨两部分额度的请求、并发扣量、失败结算与重复事件。当前单一 active entitlement、按
entitlement 计量和 replace_current 的行为尚不支持这一产品语义。
把月付 tokensPerDay 改为 10,000 会限制整个付费账户；改成 5,010,000 也不能形成独立免费额度。
本次没有修改现有月付 Plan 或用户权益来代替这项开发。

## 已提供的接口

统一入口：`https://goldencode.instmarket.com.au:1443`。
以下接口由支付／身份服务端调用，使用其现有 `Authorization: Bearer <billing-admin-token>`。

| 接口 | 用途 | 状态 |
| --- | --- | --- |
| GET /gateway/admin/billing/v1/plans | 获取 Plan、额度和功能；已包含新年付 Plan | 已提供，年付公网可见已验证 |
| GET /gateway/admin/billing/v1/subjects?provider=medevidence_billing&external_user_id=... | 查回账户与 subject.id | 已提供 |
| POST /gateway/admin/billing/v1/subjects | 仅首次开户；已有账户不要重复创建 | 已提供，保留五月规范及可选 phone 扩展 |
| POST /gateway/admin/billing/v1/entitlement-events | 支付成功后开通购买或续费权益 | 已提供，支持月付和明确一年期限 |
| GET /gateway/admin/billing/v1/subjects/{subject_id} | 查询用户当前账户及权益状态 | 已提供 |
| GET /gateway/admin/billing/v1/entitlement-events/{idempotencyKey} | 按 URL 编码后的业务幂等键查询事件结果 | 已提供 |

支付页面、订单、SKU、金额计算、收款和支付结果确认由支付团队负责。
Gateway 接收真实支付结果并管理模型权益，不提供面向用户的收款／创建订单接口。

## 支付成功后开通年付

以下示例针对**当前为 Free 的用户升级年付**。时间、订单号、账户必须替换为真实订单值；
传 subject.id（subj_...），不是 credential.id、Key 或 key_prefix。

```http
POST /gateway/admin/billing/v1/entitlement-events
Authorization: Bearer <billing-admin-token>
Idempotency-Key: medevidence_billing:ORDER_YEAR_001:purchase
Content-Type: application/json
```

```json
{
  "event_type": "purchase",
  "apply_mode": "apply",
  "provider": "medevidence_billing",
  "external_order_id": "ORDER_YEAR_001",
  "external_event_id": "evt_ORDER_YEAR_001",
  "subject_id": "subj_example",
  "plan_id": "plan_paid_yearly_v1",
  "period_kind": "one_off",
  "period_start": "2026-09-10T19:00:00+08:00",
  "period_end": "2027-09-10T19:00:00+08:00",
  "replace_current": true
}
```

`replace_current=true` 用于将当前免费权益替换为付费权益。不存在当前权益的首次购买
可不传该字段；已有付费用户须按实际升级或续费业务处理，不能无条件覆盖。
`amount_minor`、`currency` 可按实际订单补充，CNY 的金额单位为分；本文不替支付团队设定价格。

成功返回 HTTP 200，主要字段为：

```json
{
  "applied": true,
  "idempotent_replay": false,
  "subject_id": "subj_example",
  "plan": { "id": "plan_paid_yearly_v1", "display_name": "MedCode Pro Yearly" },
  "entitlement": {
    "id": "ent_example",
    "plan_id": "plan_paid_yearly_v1",
    "state": "active",
    "period_kind": "one_off",
    "period_start": "2026-09-10T11:00:00.000Z",
    "period_end": "2027-09-10T11:00:00.000Z"
  }
}
```

示例省略 billing_event、cancelled_entitlement_ids 及功能字段。
这一步复用已存在的 subject；权益购买接口不会返回新模型 Key。

## 月付、续费与恢复

- 月付购买使用同一个接口和 purchase，把 plan_id 换为 plan_paid_monthly_v1，period_kind
  换为 monthly，period_end 由支付团队按一个月计算。这是现有接口的字段用法；当前用
  replace_current 升级不会保留独立 Free 额度，月付新需求验收须等待额度模型调整。
  不要使用内部 CLI 的自然月续费代替支付事件。
- 已有有效付费周期的续费使用 renew，period_start 从原到期时间起算，period_end 顺延一个月
  或一年。年付仍使用 one_off。当前只支持一个 scheduled 后续权益，重复提前购买不能随意叠加。
- 当前没有 yearly 枚举。one_off 在这里表示具有明确结束时间的一段权益，支持 365／366 天；
  unlimited 表示无到期日，不能表达年付。Gateway 检查有效起止时间，支付团队负责自然月、
  自然年及闰年的具体日期计算，Plan 自身不自动补出一年期限。
- 对同一业务事件重试时，Idempotency-Key 和完整 body 必须保持一致；响应丢失可查事件或原样重试。
  同 key 不同 body 会冲突。不要为了重试购买重新 POST /subjects。
- Gateway 原始错误结构是 error.code（字符串）、error.message、error.request_id；对方反馈的
  `{ "code": 500, "msg": "续费套餐无法单独购买" }` 不是 Gateway 原始文案／响应结构。

## 年付正式交易仍需核对的生命周期事项

年付 Plan 和购买／续费事件已具备，但不能仅凭 Plan 创建成功认定完整支付链路已验收：

1. **Key 到期时间。** 当前开户／轮换签发的模型凭据与统一 Key 是签发时刻加 365 天，
   entitlement-events 只更新权益，不自动延长旧 Key。旧用户稍后购买一年或提前续年付时，
   付费权益可能晚于 Key 到期。正式年付联调须保证统一 Key、backing credential 和对应运行凭据
   的有效期覆盖付费期；本次只新增 Plan，没有全局修改任何用户 Key。
2. **旧凭据的更严格额度。** Plan 与凭据 token override 仍按更严格者合并；购买方应回读实际
   生效策略，若个别历史 Key 仍有累计限额，由 Gateway 按明确目标用户处理，不进行批量迁移。
3. **到期行为。** 本次验证的是年付权益按期失效；付费期满自动回 Free 尚未增加。
4. **真实收款验收。** 本次执行了隔离的购买、免费升级、幂等重放、跨闰年续费和到期测试；
   未创建真实支付订单、未为真实用户试发一年权益，也未修改或发布客户端 EXE。
5. **月付保留基础免费额度。** 现有 purchase + replace_current 测试仅验证权益替换，
   不验证免费与付费双额度；后续须实现独立记账并验证扣减、每日重置和并发行为。

## 操作证据

- R760 创建时间：2026-09-10T11:07:20.624Z；Gateway 运行提交保持 8dab89d，没有重启。
- 公网 GET /plans 验证：2026-09-10T11:08:18.764Z，HTTP 200，
  request_id=req-8497a992-9bb9-4330-8370-e140e851e88b，年付 Plan 为 active。
- 通过管理包装器先 dry-run、在线备份，再执行 plan create；schema 28，前后 quick_check=ok，外键违规为 0。
- 前 13 个 Plan、939 个 Subject、948 个模型凭据、450 个统一 Key、592 条权益、240 个 Phone identity
  与写入前备份逐条比较均无变化。现有 14 个 Plan 记录中 9 个 active，包含内部模板。
- 备份：`/data/backups/codex-gateway/r760-control-pre-control-state-sync-20260910T110649Z-ad212dfe.db`。
  SHA-256：`34c338192983356924ec1c85d559d17f635f4cdc7b70a34a982309d4af3e0872`。
- 配置留档：config/medevidence.paid-yearly.token-policy.json、config/medevidence.paid-yearly.feature-policy.json。
