# 保留现有权益的一次性赠送

2026-10-22。适用于目标账号已有非 Free 权益、并且没有有效 Free/赠送权益的情况。
正常 `entitlement grant --replace` 会取消当前非零售权益，不能用它直接追加赠送。
此处通过 `manage-r760-gateway-control.py` 的受保护操作增加独立赠送，不修改现有权益和用量。

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- grant-extra-gift <reviewed-plan.json>
python scripts/manage-r760-gateway-control.py -- grant-extra-gift <reviewed-plan.json>
```

计划包含 `version: 1`、`subjectId`、`planId`、`operationId`、`tokens`、`reason`、
`expectedPlanHash` 和 `expectedEntitlementsHash`。planId 必须是有效的 `plan_gift_once_*`，
其快照必须为对应数量的终身总额度，没有日/月总额限制。
预期哈希为 Node SQLite 返回行的 `JSON.stringify` SHA-256：Plan 用 `SELECT * FROM plans WHERE id=?`；
目标既有权益用 `SELECT * FROM entitlements WHERE subject_id=? ORDER BY id`。
原始行和手机号不写入公开文档，计划不含凭据。

wrapper 读取一次计划，先只读预演，再验证在线备份，最后在 `BEGIN IMMEDIATE` 中重查：
subject active、原权益未变、gift 模板未变、没有任何未结算预留、没有有效 Free/gift、
至少有一项现行非 Free 权益。写入一项 active/unlimited、无到期时间的赠送和同事务审计。
任何校验或审计失败整体回滚；operationId 派生确定性 entitlement ID，成功后原计划不能重复发放。
操作只新增赠送，不取消原权益，不修改模板、凭据或历史账本。wrapper 随后检查 integrity/FK。

该操作不改变模型扣费优先级：现有内部高额度权益仍为主权益；非零售内部权益期间，赠送保留，
不会额外提高该内部权益原来的每日/月限额。原权益结束后可使用无到期时间的赠送。
零售月付/年付的赠送扣费顺序沿用既有 free-then-paid 规则。

若账号只有 signup Free，使用正常 `entitlement grant --replace --carry-current-usage`：
例如原终身上限 500 万再赠送 2000 万，换成 `plan_gift_once_25m_v1` 并迁移既有用量，
净增加恰好 2000 万，不清空历史用量、不吞掉原余额。
应用前确认原快照上限和未结算预留，事后验证原账本与新账本、净增加量和生效权益。

验证入口：`node --test scripts/gateway-extra-gift.test.cjs`（实际 SQLite store）、
`python -m unittest discover -s tests -p test_manage_r760_gateway_control.py`。
这是管理员工具，不需要重启或重新部署 Gateway。
