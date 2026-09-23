# MedEvidence 历史统一 key 认证兼容：Gateway → v2

日期：2026-09-09。本文时间为北京时间 UTC+8。

## 可直接转发的消息

Gateway 已独立完成全量只读核查，与客户端团队统计一致：有手机号、排除明显测试标记的 213 个有效账号中，112 个账号各有一条历史统一 key，其 MedEvidence 子密钥在 CN 验证成功、在 R760 被拒绝。其中 23 条旧 key 最近 7 天有成功 resolve 记录，110 条最近 30 天有记录。这是潜在兼容缺口，实际报错人数尚未确认。

请 v2 团队根据附件 `r760_primary_targets` 的 112 条记录，核对 CN/R760 两侧外部身份与原 principal，提供并执行受控、可审计、幂等的认证兼容恢复。优先核对 `resolved_within_7d=true` 的 23 条，最终覆盖全部 112 条。此前单独处理的一名用户已恢复，本清单不重复包含。

旧子密钥应绑定原有 R760 principal，使用 R760 自己的 pepper 和加密规则，保留到期和撤销约束；不能直接复制 CN 哈希、恢复已失效授权或改动用户权益。明文只通过批准的服务端内存通道流转，不在消息、文件或日志中传递。请先返回身份核对和 dry-run 结果，再按确认范围执行；执行后提供逐条 R760/CN 验证结果及幂等复查结果。

另外，附件 `cn_reverse_compatibility_review` 有 155 条 current key 在 R760 有效、在 CN 被拒绝。当前路由仍会将低于 beta.47 的客户端导向 CN，因此需要联合确认受支持旧版本的兼容方案。这部分列为复核清单，不作为直接批量写入 CN 的指令。

Gateway 负责解析端防护、清单与最终联合验收。客户端可能缓存旧子密钥，所以后续解析检查不能替代 v2 认证兼容恢复；用户无需自行换 key。图片上传 `fetch failed` 仍单独定位。

## 附件与统计口径

- 脱敏记录清单（`medevidence-key-routing-compatibility-inventory-2026-09-09.json`；含 158 个真实 Subject ID，仅本地保存，不进入公开仓库）：仅记录 ID、Subject ID、到期时间、认证状态及近期 resolve 时间，不包含姓名、手机号、完整统一 key、子密钥或密文。
- Gateway 探测时间：11:54:47—11:56:13。线上 release 为 `6640d0eda4db0f90ecf6aa18adbfb95e38b8f251`。
- SQLite 使用只读连接及 `PRAGMA query_only=ON`。筛选 active Subject、未撤销且未过期的统一 key 和同一 Subject 的 backing credential；远端内存解密并校验 backing token hash，再调用两个既有 `/validate-key` 接口。
- 全账户链口径：230 个 Subject、387 条统一 key；按子密钥和入口去重后共 680 次验证，没有验证超时或状态不明的结果。
- 排除 1 条 medical scope 后，code 口径为 229 个 Subject、386 条 key，与客户端报告一致。
- 再按手机号及明显测试标记筛选后为 213 个 Subject、370 条 key；112 条 R760 缺口全部是历史非 current key。全量中另有 2 条 current 异常，但属于测试标记账号，不计入真实用户口径。
- 近期 resolve 仅证明该统一 key 曾被解析，不证明当时客户端版本、真人操作或 MedEvidence 请求已失败。
- 本次没有写入任何线上数据库、发放或撤销 key、修改权益、重启服务或发送外部消息。

## v2 执行与回传要求

1. 用清单内 `unified_key_id`、`subject_id` 精确关联 Gateway 恢复材料。核对两侧 `external_provider`/`external_user_id` 和 principal 状态；不按显示姓名推断归属。
2. 执行前重新确认统一 key、backing credential、Subject 及源端子密钥有效。清单是时间点快照，不是长期有效的写库授权。已撤销、已到期、禁用或身份冲突记录应跳过并回报。
3. 明确子密钥共享于多个统一 key 时的到期、撤销关系；兼容记录不得无条件永久有效，不得复活目标端已经撤销的记录。已有正确兼容记录应识别为已完成，避免重复新增。
4. 使用已验证备份及事务旧值条件；只写本次确认的目标认证记录，绑定原 principal。回滚采用带本次标签的定向撤销，不用整表备份覆盖后续在线数据。
5. 回传脱敏结果：统一 key ID、处理结果、目标 api key/principal ID、有效期、原 key → R760 和 CN 的 HTTP/valid 状态、现有 current key → R760 状态、幂等复查及备份/回滚位置。不能回传明文或密文。

## Gateway 联合验收与发布顺序

1. v2 返回 dry-run，Gateway 复核范围及身份关联。实际恢复仍由负责认证库的 v2 团队按已确认范围执行。
2. v2 恢复后，Gateway 重跑只读认证核查：112 条目标原 key 在 R760 验证通过，CN 原路径仍有效；current key 无回归；失效授权保持拒绝。
3. 明确 155 条反向兼容记录在受支持客户端版本上的处理方式，再验收完整版本矩阵。
4. Gateway 解析防护作为独立候选改动评审、发布。目标明确拒绝时（HTTP 401/403 或 `valid=false`），返回 `409 account_migration_required`，不返回凭证。它尚未上线，不能把提前暴露错误算作用户已恢复。
5. 2026-09-23 评审后修订：验证超时或服务异常时不再阻止解析，照常返回统一凭证并记录告警，因此 MedEvidence 故障不会牵连 GoldenCode 部分。每次解析仍增加最多 3 秒的认证延迟。不得先单独发布防护来宣称本次兼容问题已解决。
6. 客户端验收已缓存旧子密钥的直接重试、重新 resolve、新旧客户端和图片编辑实际流程，确认用户无需手工换 key。
