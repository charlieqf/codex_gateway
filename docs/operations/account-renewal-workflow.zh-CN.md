# 日常内部账号续期

自 2026-11-12 起，日常内部账号续期使用 `renew-accounts`，不再拆成
`entitlement grant`、`update-key` 和多次统一 Key 延期，也不以全库备份或全库完整性扫描为前置条件。
新开户继续使用 `issue-real-user-cgu-key.py` / 现有真实用户开户 API；它具有持久任务和恢复机制。
不要通过重复开户来给已有账号续期。

## 执行

先按手机号只读查到唯一 Subject、最新内部套餐以及当前有效期。一般“续期 N 个月”从现有
到期日按日历月顺延；已到期则从明确指定的办理时间起算。月底日期取目标月最后一天。
用户明确要求“从今天起一年”等期限时按用户指示计算，不能缩短既有权益。

在 Git 外的受限目录保存清单，使用一次操作始终不变的 `operationId`：

```json
{
  "version": 1,
  "operationId": "internal-renewal-20261112-example",
  "reason": "用户授权原内部套餐续期六个月",
  "items": [{
    "subjectId": "<精确 Subject ID>",
    "entitlementId": "<当前套餐或最新待接续套餐 ID>",
    "expiresAt": "2028-03-10T02:19:34.469Z"
  }]
}
```

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- renew-accounts <manifest.json>
python scripts/manage-r760-gateway-control.py -- renew-accounts <manifest.json> <plan.revision>
```

预览只读。执行必须带该预览的 revision，在写锁内重新核对账号、套餐、全部凭据和身份绑定。
一个清单最多 100 个明确的账号，整批在同一事务内提交。

- 当前套餐未到期：追加紧接原周期的同套餐续期，保留原政策快照和历史用量。
- 已有待接续套餐：以该套餐 ID 为源延长其终点，不产生第二个冲突的待接续周期。
- 已到期：清单额外提供固定的 `startsAt`，介于原到期时间与办理时间之间；旧周期正常过期，
  新周期激活。不默认补发过去时段，也不重置历史额度。
- 同时延长未吊销的底层凭据、现用 Key 和匹配的旧 Key。原期限更长的凭据保持原期限。
  不重发 Key，不改变手机号、凭据类别、权限或速率覆盖设置，不恢复已吊销凭据。
- 仅接受可续期的 `plan_internal_*` 套餐、code 范围、无一次性总量额度的账号。
  暂停、冲突套餐、身份绑定异常须先查明；零售购买、赠送、团队套餐沿用各自业务流程。

## 事务、恢复与重试

账号变更、受影响字段的前后值及审计回执在同一 SQLite 事务内写入。
审计失败也会回滚整批；记录中不复制完整 Key、密文或手机号。
外键约束和受影响记录读回检查始终启用，校验工作只针对本次账号。
周期性数据库备份、恢复演练及重大迁移前备份继续负责灾难恢复，不挂在日常账号请求上。

如果网络断开或客户端丢失响应，用**原清单、原 operationId、原 revision**重试。
已提交的操作会返回原回执，不重复加套餐或延期。同 ID 更换参数被拒绝。
若提交后账号已发生其他控制变更，程序明确报告已提交但状态随后变化，须核对原审计回执；
不要更换 operationId 盲目重做。

提交后检查 `authority_result.applied` 和 `audit_id`，再只读核对连续权益、凭据有效期、
原 Key 的 resolve、credentials/current 和选定上游的 validate-key。手机号绑定相关操作可补做
login/start、bootstrap、account/current，并注销专用诊断会话。无需重启或部署 Gateway。

## 按账号撤销

确实需要撤销且已获相应授权时，提供另一个稳定操作 ID 和原续期 ID：

```json
{
  "version": 1,
  "operationId": "undo-internal-renewal-example",
  "renewalOperationId": "internal-renewal-20261112-example",
  "reason": "授权撤销误操作",
  "subjectIds": ["<只撤销该账号>"]
}
```

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- undo-account-renewal <undo.json>
python scripts/manage-r760-gateway-control.py -- undo-account-renewal <undo.json> <plan.revision>
```

仅允许账号仍符合提交后的记录，且续期权益没有产生用量或预留记录时自动撤销。
新套餐改为取消而非删除；恢复本次更改的期限，保留审计和其他账号数据。
原有待接续周期的延期也可撤销，但已经进入延长区间时拒绝自动撤销。
已经使用权益、之后修改绑定/套餐/凭据等情况须做针对性处理，禁止恢复整个线上数据库。

## 边界与验证

通用管理命令、全局配额改写、结构迁移及服务发布仍使用各自维护流程。
`run-r760-control-batch.py` 的共享备份能力保留给这些维护工作，不用于日常开户/续期。
`extend-unified-key-expiry` 保留作为明确的分步修复工具，不能再作为常规完整续期流程。

回归验证：`node --import tsx --test scripts/gateway-account-renewal.test.cjs` 和
`python -m unittest discover -s scripts -p test_account_renewal_control.py`。
测试使用实际 SQLite schema，覆盖整批回滚、丢响应重试、预览失效、并发写锁、连续权益切换、
定向撤销及用量保护；Python 路由测试禁止日常续期触发全库备份/完整性扫描。

2026-11-12 已在 R760 对一个用户授权的内部账号执行六个月续期：提交用时 5.3 秒
（包含远程连接），同一操作重试返回原回执，未重复延期。实际权益、原 Key、上游鉴权、
手机号授权链路和诊断会话清理均通过；1,506 条历史用量记录未变。
测试通过 30 项账号事务测试、7 项路由测试及 12 项原维护批次回归测试。
账号标识、精确期限和完整回执保留在受限运维目录，不写入公共文档。
手机号诊断请求须使用接口要求的 11 位号码；Subjects 中的 `+86` 存储形式需先规范化。
