# 免费与付费额度独立记账：Gateway 合同

日期：2026-09-10。已于北京时间 20:10 部署 R760，并通过公网 Billing 与运行验收。
证据见[发布验收记录](../operations/r760-free-paid-quota-release-2026-09-10.zh-CN.md)。

## 产品规则

- Free 是基础权益。新用户每天 10,000 token；存量 Free（包括每日 1,000,000 版本）保留原快照。
- 月付 `plan_paid_monthly_v1` 在 Free 之外提供付费额度；现有月付模板仍为每日 5,000,000、
  每付费周期 50,000,000 token，历史付费快照不变。
- 年付 `plan_paid_yearly_v1` 的付费累计额度不设上限，基础 Free 同样保留。
- 先扣当天免费余额，再扣付费额度。一天用 20,000 token，免费扣 10,000、付费扣 10,000。
  免费消耗不计入付费日／周期额度。付费额度耗尽后，次日仍能使用新的免费额度。
- 免费日额度沿用既有 **UTC 00:00（北京时间 08:00）** 重置规则，不累积到以后；
  付费周期用量不因每日免费重置而清零。跨午夜的请求按预留时所属日期入账。
- 购买或续费保留同一个 Free entitlement、快照及账本；不会再次发放当天免费额度。
  付费期满、暂停或取消后，可继续使用仍有效的 Free。明确停用的账户及明确暂停／取消的
  Free 权益不因此重新启用。

## 支付接口

入口仍为 `https://goldencode.instmarket.com.au:1443`，身份／支付服务端沿用现有 Billing 管理令牌。

支付成功仍调用 `POST /gateway/admin/billing/v1/entitlement-events`，首次购买为 `purchase`，
后续有效付费期续期为 `renew`。月付 `period_kind=monthly`，年付 `period_kind=one_off`；
支付后端传入准确的一个月／一年起止时间。此接口不负责创建收款订单。

当前只有 Free 时，购买这两个付费 Plan 不必传 `replace_current`；为兼容现有接入，传
`replace_current=true` 也会保留 Free。已有付费权益时，该字段仍表示替换当前付费权益，
不能在重复付款通知或普通续费中无条件覆盖。业务幂等键和请求体保持一致。

`GET /gateway/admin/billing/v1/users/{subject_id}/entitlements` 增加 `free_allowance`：

```json
{
  "current": { "id": "ent_paid", "plan_id": "plan_paid_monthly_v1", "state": "active" },
  "free_allowance": { "id": "ent_free", "plan_id": "plan_free_daily_10k_v1", "state": "active" },
  "history": [],
  "next_cursor": null
}
```

上述省略其他既有字段。`GET /subjects/{subject_id}` 查询的是账户和凭据，权益请使用上面的
`/users/{subject_id}/entitlements`，不要把两个路径的用途混淆。

## 客户端用量展示

已有 `GET /gateway/credentials/current` 的 `token_usage` 新增字段；完整请求用量仍只记一次：

```json
{
  "accounting_mode": "free_then_paid_v1",
  "day": { "limit": 5000000, "used": 10000, "remaining": 4990000 },
  "month": { "limit": 50000000, "used": 10000, "remaining": 49990000 },
  "free_allowance": {
    "entitlement_id": "ent_free",
    "plan_id": "plan_free_daily_10k_v1",
    "day": { "limit": 10000, "used": 10000, "remaining": 0 }
  }
}
```

示例省略 `source`、`reserved`、窗口起止时间、minute 及免费月窗口统计。出现
`free_then_paid_v1` 时，顶层 day/month 是付费账本，free_allowance 是独立免费账本；
minute 仍按该请求完整 token 用量执行技术限速。累计不限量仍以 `limit=null` 表达。
客户端应分别展示免费和付费余额，不能仅凭付费 remaining=0 判断用户完全不可用。
服务端扣量已由 Gateway 统一执行，本批不修改客户端代码。

## 结算、迁移和验证边界

请求在 SQLite 同一写事务中预留两部分余额，最终按模型实际用量结算；并发请求不能重复
预留免费余额。结算保护其他尚未结束的请求预留，释放的余额可供后续请求使用。重复结算
不重复扣量，失败缺失用量沿用该请求的 missing-usage 策略；当前公开 Free／付费模板为 none。
预留估算和单次最终用量超出估算的既有语义仍适用，真实使用量不会因为达到余额而被抹去。

Migration 29 增加每请求的免费 entitlement、预留快照以及最终免费／付费 token 字段。
已有有效公开月／年付账户若从未有过 Free，将补充当前每日 10,000 的基础免费权益；
若原 Free 被旧版 replaced 流程取消，则恢复其原记录和账本。明确行政取消／暂停不恢复。
现存 Subject、Key、Plan 和付费额度快照不改；切换前的历史用量不重算、不退回付费额度。
内部及测试 Plan 不自动获得额外 Free。

本批测试覆盖免费升级、跨两种额度、并发、预留失败／超时、幂等、日切、老 1M 快照、
付费额度耗尽、暂停／取消、续费激活、到期回 Free，以及真实 HTTP 路由的四种传输模式。
独立运行镜像测试使用内存数据库和本机模拟模型，不消费生产用户额度或真实模型服务。

数据库同时存在基础 Free 和付费权益后，旧程序不能正确处理权益选择和账本。上线后应使用
支持双额度的版本修复或回退；禁止直接恢复旧库覆盖新账本，部署采用 forward-only 保护。
历史 usage transfer 工具对双额度记录明确拒绝导入，避免按旧规则重复扣付费额度。

年付 Key 签发 365 天与付费到期日覆盖的问题仍属于独立的凭据生命周期事项，本批未修改
任何 Key 到期时间；真实收款及客户端余额展示需相关团队联合验收。
