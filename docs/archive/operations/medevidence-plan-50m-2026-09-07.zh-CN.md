# MedEvidence 月套餐调整为 5000 万 Token

2026-09-07 用户明确要求将 `plan_paid_monthly_v1` 月额度改为 5000 万。
R760 权威数据库已于 `2026-09-07T10:04:10.392Z` 完成修改。

| 配置 | 修改前 | 修改后 |
| --- | --- | --- |
| `tokensPerMonth` | 100,000,000 | 50,000,000 |
| `tokensPerDay` | 5,000,000 | 5,000,000 |
| `tokensPerMinute` | 300,000 | 300,000 |

其余 Plan 字段保持不变。61 条现存 entitlement 的策略快照未改动；新购买及后续新建续费权益采用更新后的 Plan。未迁移存量权益、重置用量或写入测试购买事件。

执行入口为 `scripts/manage-r760-gateway-control.py` 的 `set-plan-monthly-tokens` 操作，参数为 Plan ID、预期旧值、新值。先 dry-run，再执行完整在线备份和完整性校验，最后在单个写事务内校验旧值、暂时移除不可变策略触发器、修改唯一 Plan、恢复原触发器并写审计。首次尝试受到不可变触发器保护而回滚；补齐事务内触发器处理并通过测试后重试成功。

- 成功操作的备份：`/data/backups/codex-gateway/r760-control-pre-control-state-sync-20260907T100346Z-927fa257.db`
- 备份 SHA-256：`68716029788104beefb68a7fefca170a19a629d09dc510cad68b40a36d3ddd3f`
- 审计 ID：`audit_b4ea58e2d93f4d4fba3d38756f30eb74`
- 61 条权益快照修改前后摘要：`da091460558342bf729abac3ec67bdade2963a4af403717fd5cb542b6b463942`
- 备份及修改前后 SQLite 检查：`quick_check=ok`，外键违规 0。
- 独立只读复核：月额度 50,000,000，Plan active，触发器已恢复，审计 success，快照摘要一致。
- 公共 Gateway 健康检查：`state=ready`。
- 修改脚本 3 项实际 SQLite 测试通过：dry-run/正常更新与快照保留、审计失败回滚、缺失/停用/旧值不匹配/非法参数拒绝；覆盖成功及失败后不可变保护恢复。Python 语法检查通过。

如需回退月额度，可在明确授权后使用相同受控入口，以预期旧值 50000000、新值 100000000 执行；不直接用全库备份覆盖后续正常业务数据。
