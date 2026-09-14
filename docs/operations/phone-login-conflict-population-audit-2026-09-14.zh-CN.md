# 手机号登录冲突全量排查（2026-09-14）

截至北京时间 2026-09-14 12:16，未发现其他账号存在范银星本次的重复手机号登录冲突，也未发现活跃 Phone identity 的绑定或运行时密钥准备异常。

## 检查结果

R760 唯一权威 Gateway 数据库全量快照：2026-09-14T04:14:10.276Z。

| 项目 | 结果 |
| --- | ---: |
| Subject 总数，包含停用和归档记录 | 967 |
| active Subject | 303 |
| 符合现行大陆手机号规范的 Subject | 262 |
| 规范化后独立手机号 | 262 |
| 重复手机号组 | 0 |
| Phone identity 总数 | 261 |
| active Phone identity | 248 |
| 失败开户后停用、且仍保留有效手机号的记录 | 0 |

手机号规范化严格复用线上规则：大陆 11 位号码及其 `+86` 格式视为同号；没有额外移除空格或标点，也没有忽略停用、归档账号。

最近三天（2026-09-11T04:14:10.276Z 至快照时间）只有两条 `phone_identity_conflict`，均为范银星修复前的登录失败。已保留的全部 Phone Auth 审计记录共 26,407 条，起于 2026-08-21T06:05:13.033Z；其中该错误同样只有这两条。没有 `account_migration_required` 或 `subject_mismatch` 审计事件，这两个错误也会在旧客户端显示“该账户需要管理员处理”。

范银星对应报错请求：`req-c9e4bd0f-4627-4158-980a-a81c01c8937f`。该账号的定向清理及公网登录验证已在上一轮完成。

## 活跃身份复核

2026-09-14T04:16:20.215Z，使用容器内已部署的 `PhoneAuthService.requireReadyAccountForIdentity` 和只读数据访问函数，检查全部 248 个 active Phone identity。248 个均通过身份与运行时密钥检查，异常为 0。

覆盖 Subject 状态、手机号 HMAC 对应关系、全量账号中的手机号唯一性、当前统一 Key 的归属／撤销／有效期／Desktop 类型／可恢复字段，以及 backing credential、模型范围、MedEvidence origin 和加密凭据的解密验证。

本轮未调用登录接口。数据库以 `readOnly: true` 和 `PRAGMA query_only=ON` 打开；在权益访问器入口主动停止，因为正式权益访问器会进行时间状态转换并可能写库。因此，这项复核不代表所有账户的套餐、配额或客户端 GUI 均已验收。

## 后续防复发点

当前 `apps/gateway/src/real-user-issue.ts` 失败补偿只调用 `disableSubject`；范银星事故中，失败开户留下的同手机号停用记录触发了登录的严格唯一性检查。本次全量排查没有发现其他残留，但失败开户的手机号清理与重复开户前置检查仍是后续修复项。本轮未修改该代码或生产控制状态。

## 复核材料与执行方式

- [全量检查脚本](../../scripts/ops/audit-phone-conflicts-r760.mjs)及[统计结果](../../artifacts/phone-auth-audit-2026-09-14/population.json)：重复号及审计窗口统计。
- [身份检查脚本](../../scripts/ops/audit-phone-auth-readiness-r760.mjs)及[检查结果](../../artifacts/phone-auth-audit-2026-09-14/readiness.json)：线上代码的只读身份／运行时检查。

从仓库根目录通过 SSH 标准输入在 R760 Gateway 容器内执行，无需上传脚本或安装依赖：

```powershell
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
foreach ($auditScript in @('scripts/ops/audit-phone-conflicts-r760.mjs', 'scripts/ops/audit-phone-auth-readiness-r760.mjs')) {
  Get-Content -Raw -Encoding UTF8 $auditScript | ssh -p 7723 -i $env:USERPROFILE\.ssh\id_ed25519 -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes root@117.186.49.26 'docker exec -i codex_gateway_r760-gateway-1 node --input-type=module -'
  if ($LASTEXITCODE -ne 0) { throw "Audit failed: $auditScript" }
}
```

身份检查脚本依赖容器内当前构建的私有方法及 `/app` 文件布局；Gateway 升级后应重新检查兼容性。脚本运行时间决定统计窗口，归档 JSON 保存的是本次检查时的结果。

输出材料未包含完整手机号、Phone hash、密钥或访问令牌。
