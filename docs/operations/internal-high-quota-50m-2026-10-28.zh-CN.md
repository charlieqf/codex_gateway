# 内部高额度每日 5000 万与万怡名单开通记录

2026-10-28 03:43 UTC 已完成 R760 线上变更及验证。输入文件为 `万怡内部高额度账号开通.xlsx`，包含 29 个唯一手机号，均唯一匹配到 active 账号。原文件未修改，本文不记录手机号或密钥。

## 结果

- 原 `plan_internal_high_quota_v1` 和 `plan_internal_high_quota_image_v1` 均为每日 20,000,000、每月 500,000,000 token。两份模板及 234 个账号的 235 份未到期 active/paused/scheduled 权益，已将每日额度改为 50,000,000。其余策略、期限、功能、已用量和积分不变。
- 名单中 15 个既有内部图片账号随上述变更升级；2 个已有 `plan_internal_elevated_quota_image_v1`，本来就是每日 5000 万且可生成图片，保留其更高的每月 10 亿和每分钟 200 万额度。
- 另 12 个账号原为 10 个 Free、1 个赠送、1 个无有效权益，已批量开通 `plan_internal_high_quota_image_v1`。11 个账号的原用量完整复制至新权益；有效期按现有 Key 覆盖范围设置，没有修改现有统一 Key。
- 无有效权益的账号还有一份过期的底层凭据，已续至其现有统一 Key 的到期日 2027-07-17。账号绑定、Key 内容、手机号身份未改动。
- 最终 29 个账号均有每日 5000 万的有效内部图片权益和有效凭据。上述两个常规内部 Plan 现共有 246 个账号、247 份未到期权益，日额度均为 5000 万。

按用户要求，只对 2 个账号执行公网图片权限抽查，没有逐个请求图片权限，也没有生成测试图片。样本为表格第 10 行（Free 升级）和第 24 行（恢复过期凭据）。两者 `/gateway/credentials/current` 均返回 HTTP 200、有效权益、日额度 5000 万、`image_generation.enabled=true`，允许 `medcode-image-default`。

公网请求 ID：

- `req-9811b7b3-12de-487e-b0d5-e0272503b1f4`
- `req-4cb841e8-cbbb-4280-af15-6171830f9ee6`

## 控制面操作与备份

全部变更由 `scripts/manage-r760-gateway-control.py` 执行，写入前完成在线备份及 SHA-256 校验，写入后 `quick_check=ok`、外键错误为 0。没有部署或重启 Gateway。

| 操作 | 完成时间 UTC | 备份（`/data/backups/codex-gateway/`） | 审计 ID |
| --- | --- | --- | --- |
| 内部日额度提升 | 03:36:50 | `r760-control-pre-control-state-sync-20261028T033618Z-e6435511.db` | `audit_622cb77714454955b48d439e3f3bc7e2` |
| 12 个图片权益与 1 个凭据恢复 | 03:42:28 | `r760-control-pre-control-state-sync-20261028T034159Z-0ad8494b.db` | `audit_b7e11f8c8033428e96f288af772dc9d4` |

首个批量预检因存在未结算请求而拒绝执行；请求结算后重试成功，没有跳过保护条件。

## 可复用操作入口

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- raise-internal-daily-limits "<reason>"
python scripts/manage-r760-gateway-control.py -- raise-internal-daily-limits "<reason>" <preview-revision>

python scripts/manage-r760-gateway-control.py --what-if -- grant-internal-image-batch <reviewed-plan.json>
python scripts/manage-r760-gateway-control.py -- grant-internal-image-batch <reviewed-plan.json>
```

`raise-internal-daily-limits` 只处理上述两个常规内部 Plan，将 2000 万提升到 5000 万；原有更高凭据日额度保留，其他较低覆盖值会要求单独审查。预览版本覆盖模板、有效权益和未撤销凭据。应用时原子更新模板及快照，恢复原不可变触发器，写入完整前后审计；不重复应用已完成的变更。

`grant-internal-image-batch` 的 JSON 含 `version: 1`、`reason`、预检返回的 `expectedRevision`、`targets`。每个目标含 `subjectId`、`expectedEntitlementId`、`expectedPlanId`、UTC `periodEnd`；无有效权益时前两个预期权益字段为 null。只有明确恢复过期底层凭据时，才提供 `credentialExtension: {id, expectedExpiresAt}`。

批量入口只允许从指定 Free/赠送或无有效权益状态转入每日 5000 万的内部图片 Plan。它验证唯一当前可恢复 Key、active 手机身份、凭据归属及有效期覆盖，并拒绝未结算请求。使用现有 `grantInTransaction` 逻辑，在同一事务内复制用量、替换权益、恢复明确列出的过期凭据及写审计；任一目标失败则全批回滚。私有名单和候选 JSON 不应提交到 Git。

验证：8 项日额度测试、4 项批量开通测试、9 项现有 wrapper 测试通过，覆盖实际限额执行、用量继承、月额度保留、并发状态变更拒绝、审计失败整体回滚及过期凭据恢复。Python wrapper 编译检查通过。
