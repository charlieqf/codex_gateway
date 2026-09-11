# MedEvidence 免费额度一次性化合同修订 v2（2026-09-11）

本文修订[独立记账合同](./medevidence-free-paid-quota-contract-2026-09-10.zh-CN.md)中的免费额度语义。除下列变更外，其余合同条款（记账、取消、重置冲突、购买/续费流程）不变。

## 语义变更

| 项 | v1（2026-09-10） | v2（本修订） |
| --- | --- | --- |
| 免费额度 | 每日重置（10,000/日） | 注册一次性发放 1,000,000 token，终身有效 |
| 重置 | UTC 00:00 恢复 | 不重置；用完即止 |
| plan_id | `plan_free_daily_10k_v1` | `plan_free_once_1m_v1` |
| 耗尽行为 | `429 rate_limited` + `retry_after`（次日） | `429 free_quota_exhausted`，无 `retry_after` |
| 付费用户 | 购买时补发基础 Free | 不再补发；注册时的一次性额度是唯一免费来源 |

## Desktop 需要的配合

1. **错误码处理**：`free_quota_exhausted` 出现时提示"免费额度已用完，请购买月付或年付套餐"，不展示倒计时重试。
2. **用量展示**：`token_usage.free_allowance` 新增 `total` 窗口对象（`limit`/`used`/`reserved`/`remaining`），替代"每日免费"语义；`day` 字段保留但值为历史遗留（limit 为 null）。建议 UI 改为"剩余免费额度 X / 1,000,000"。
3. **存量用户**：已注册用户的每日权益自动迁移为一次性 1,000,000，历史已用量结转（例：已用 30,000 → 剩余 970,000）。用户可能感知"每日额度消失"，建议公告说明。

## 投影示例

```json
{
  "accounting_mode": "free_then_paid_v1",
  "free_allowance": {
    "entitlement_id": "ent_free",
    "plan_id": "plan_free_once_1m_v1",
    "total": { "limit": 1000000, "used": 30000, "reserved": 0, "remaining": 970000 }
  }
}
```

## 耗尽响应示例

```json
{
  "error": {
    "code": "free_quota_exhausted",
    "message": "Free token allowance exhausted: purchase a monthly or yearly plan to continue.",
    "http_status": 429
  }
}
```

## 迁移与生效

- 存量 25 个 active 每日 Free 权益随 schema 30 迁移：plan 指向 `plan_free_once_1m_v1`，快照改为一次性 1,000,000，历史 day/month 窗口用量合计结转进单一 `period` 终身窗口；已取消/过期的历史权益保留原快照供审计。
- 月付/年付购买不再触发补发 Free（`ensureFreeAllowance` 移除）；仅修复旧替换流误取消的存量免费权益。
- 已于 2026-09-11 10:37 UTC（北京时间 18:37）随 Gateway `45465ee` 上线，25 条存量每日 Free 权益已迁移；
  发布验收见[发布记录](../operations/r760-free-once-release-2026-09-11.zh-CN.md)。
