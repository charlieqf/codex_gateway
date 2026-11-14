# 短信联调空测试账户重置记录

2026-09-10 02:07:48 UTC（北京时间 10:07:48），按用户明确要求删除
`provider=medevidence_billing / external_user_id=medevidence_test_262`，供身份后端
增加顶层 `phone` 字段后重新测试开户。

这是一次经明确授权、完成备份的空测试账户重置；没有新增公开删除接口，
没有改变五月版开户合同、正常幂等规则或生产账户生命周期规则。

## 范围和执行结果

- 原 Gateway subject：`subj_9SByOERhCrtBYfVrz4anabAz`，创建时间
  `2026-09-10T01:35:41.090Z`；原请求没有登记手机号。
- 删除前核对：无权益、Phone identity、会话、模型用量；关联运行 Key 从未使用。
- Gateway 删除 5 行：subject、access credential、unified key、upstream binding、
  create_subject 幂等事件，各 1 行。
- 关联 MedEvidence 运行库删除 3 行：internal principal、API key、对应
  `medevidence:<subject_id>:create_user` 幂等事件，各 1 行。
  同一外部编号会推导出同一 subject ID，因此运行库这三行也需清理，避免重放旧结果。
- 原 Gateway admin audit 2 条全部保留，另新增
  `audit_test_reset_a558a54eec044a8691105283ae1f9d76`。
- 执行脚本：[限定账户的重置脚本](../../../scripts/ops/reset-unused-billing-test262-20260910.py)。
  默认只读；写入前有精确身份、行数、无用量、外键和备份校验，事务中复核。

## 备份与验收

- Gateway 完整在线备份：
  `/data/backups/codex-gateway/test262-reset-pre-control-state-sync-20260910T020515Z-7687c651.db`
- SHA-256：`5f8d5dd213f1141d2f4bef434dd632e2095e3c779cdcf30844d35e4ea92263f3`。
- 两侧目标行快照及结果：
  `/data/backups/codex-gateway/test262-reset-20260910T020747Z-7faf9a1d/`。
  目录 0700，备份文件 0400；密钥材料仅保存在受保护备份内。
- 快照 SHA-256：`fe7a4251ffb88d61b7488587ad2122f40b97a28ae17e89a925fcecf41d1e4a10`。
- 完成后独立只读查询确认目标开户数据为零；SQLite quick_check=ok，外键违规为零。
- 公网 `GET /gateway/admin/billing/v1/subjects?provider=medevidence_billing&external_user_id=medevidence_test_262`
  返回 `404 subject_not_found`，请求 ID `req-10f950fd-1056-4a8c-9fc0-f40234a24c08`。
- Gateway 容器保持 healthy，重启次数为零；未重新部署或重启服务。

后续由身份后端重新调用 `POST /gateway/admin/billing/v1/subjects`，沿用真实外部用户编号，
并携带顶层 `phone`。这次重置没有主动创建新用户，也未提前发放每日免费额度；
下一次真实开户后再验收手机号登记、可恢复 Key 和每日 100 万 token 权益。
