# MedEvidence 付费 Plan 额度调整（月付 1.5 亿 / 年付日月月封顶）

2026-09-11 需求变更：月付 `plan_paid_monthly_v1` 维持每日 5,000,000 token，月额度从 50,000,000 调整为
150,000,000；年付 `plan_paid_yearly_v1` 从不设上限调整为每日 6,000,000、每个 UTC 日历月 200,000,000，
年额度不设上限。基础 Free 每日额度（`plan_free_daily_100k_v1`，100,000/日）独立保留，不受本次调整影响。

## 配额语义

| Plan | tokensPerDay | tokensPerMonth | 说明 |
| --- | --- | --- | --- |
| 月付 `plan_paid_monthly_v1` | 5,000,000（不变） | 50,000,000 → 150,000,000 | 月窗口锚定计费周期（购买日起一个月） |
| 年付 `plan_paid_yearly_v1` | null → 6,000,000 | null → 200,000,000 | 月窗口按 UTC 日历月逐月重置；无年度累计窗口，年额度不限 |

关键代码变更：`packages/store-sqlite/src/token-budget.ts` 的月窗口规则调整——`monthly` 权益仍锚定
计费周期；`one_off` 权益（年付）改为按 UTC 日历月开窗，使 `tokensPerMonth` 表示"每自然月 2 亿"，
而不是整个一年周期的累计上限。年付模板留档 `config/medevidence.paid-yearly.token-policy.json` 已同步。

存量权益保留原策略快照：已发放的年付权益在快照更新前仍为不限额；新购买和续费采用新 Plan 模板。

## 生产操作（R760 权威库）

部署顺序：先发布包含日历月窗口的 Gateway 镜像，再执行年付 Plan 修改；否则旧的整年月窗口会把
200,000,000 当作全年累计上限。

执行入口为 `scripts/manage-r760-gateway-control.py` 的 `set-plan-token-limits` 操作（原
`set-plan-monthly-tokens` 的泛化，支持 `none` 表示不限额，可选日额度新旧值对）。先 dry-run 再执行，
每次执行都经过完整在线备份与完整性校验，单事务内校验旧值、暂时移除不可变策略触发器、更新唯一
Plan、恢复触发器并写审计。

月付（日额度不变，仅改月额度）：

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- set-plan-token-limits plan_paid_monthly_v1 50000000 150000000
python scripts/manage-r760-gateway-control.py -- set-plan-token-limits plan_paid_monthly_v1 50000000 150000000
```

年付（月、日额度同时从不限额改为 2 亿 / 600 万）：

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- set-plan-token-limits plan_paid_yearly_v1 none 200000000 none 6000000
python scripts/manage-r760-gateway-control.py -- set-plan-token-limits plan_paid_yearly_v1 none 200000000 none 6000000
```

回退使用相同入口，把预期旧值与新值互换（例如年付回退为 `200000000 none 6000000 none`）。

## 验证

- `packages/store-sqlite/src/free-paid-quota.test.ts` 新增两条窗口语义测试：monthly 权益跨日历月仍按
  计费周期累计；one_off 年付权益在 UTC 日历月边界重置月额度。
- `scripts/gateway-plan-token-policy.test.cjs` 覆盖：月付单字段更新、年付月+日联合更新与恢复、
  审计失败回滚、旧值不匹配/缺失/停用/非法参数拒绝、null 期望值校验。
- `scripts/ops/billing-quota-review-public-smoke.mjs` 年付断言改为日 6,000,000、月 200,000,000。
