# 10 月 1 日到期风险关闭记录（2026-09-17）

原批次 **89/89 项成功**，于北京时间 2026-09-17 10:36:43 完成。随后按用户“要完成统一 Key 续期项”的授权，于 **10:44:00** 补齐 9 个统一 Key 的生产续期；10:49:01 完成实际接口验证。此次核查发现的 10 月 1 日到期断点已解除，续期期限为 **2027-01-01 00:00:00 UTC（北京时间 08:00）**。

| 操作 | 调用数 | 实际覆盖与结果 |
| --- | ---: | --- |
| 停用历史测试、诊断及旧试用账号 | 35 | 35/35 Subject 已为 disabled |
| 续接到期权益 | 4 | 52/52 人：9 个遗留账号 + 43 个人工开户账号；新权益衔接旧权益，至 2027 年 1 月 1 日 |
| 更新 Gateway 底层凭据期限 | 50 | 50/50 到期时间与批次参数一致；其中 9 个遗留账号延期至 2027 年 1 月 1 日 |
| 补充统一 Key 续期（原批次之外） | 1 个受控事务 | 9/9 current 统一 Key 从 2026 年 10 月 1 日延至 2027 年 1 月 1 日 |

原批次使用 `scripts/run-r760-control-batch.py --batch .tmp/ops-batch-2026-09-17.json`。历史一次本地编码错误已在同一步重试成功。最终结果经过生产库逐项核对，而非仅看脚本退出码。35、52、50 是不同操作的覆盖数，有人员重叠，不能相加为用户总数。

补充续期涉及王云、沈杰、姚梦晗、许焰、冯骞、张晟、周宇璐、郑蕾、刘卓然。原 `update-key` 只更新 `access_credentials`，未联动 `unified_client_keys`；因此原批次完成时仍有 9 个统一 Key 将于 10 月 1 日失效。

本次在 guarded wrapper 中新增 `extend-unified-key-expiry`，先预览精确名单、验证在线备份，再以一个事务检查原期限、current 状态、身份绑定、底层凭据期限及连续权益，更新期限并逐账号写审计。没有更换或重发 Key，已有 Key 与手机身份继续使用。前后安全元数据对比确认这 9 条 Key 仅到期字段变化，其余目标的凭据、权益及身份绑定未变。

执行命令：

```powershell
python scripts/manage-r760-gateway-control.py --timeout-seconds 120 --what-if -- extend-unified-key-expiry .tmp/unified-key-renewal-2026-09-17.json
python scripts/manage-r760-gateway-control.py --timeout-seconds 120 -- extend-unified-key-expiry .tmp/unified-key-renewal-2026-09-17.json
```

以上已经执行成功，原计划再次执行会因旧期限不匹配而拒绝。

生产备份：`/data/backups/codex-gateway/r760-control-pre-control-state-sync-20260917T024336Z-565c2545.db`，338374656 字节。备份 SHA-256 为 `f19c364f81a6d2ca4641b71efd9b7a23f205565f283d8102b9b0d372ff994556`。执行前后 SQLite quick_check 均为 ok、外键异常为 0，数据库版本保持 30。

| 验收项 | 结果 |
| --- | --- |
| 52 人权益 | 在当前、10 月 1 日 00:00 UTC、当日 03:10:07.005 UTC、12 月 31 日 23:59:59 UTC 均有 code/chat 权益覆盖；9 人续期事务另验证了连续覆盖 |
| 9 人统一 Key | 实际存储期限全部为 2027-01-01T00:00:00.000Z；原 9 个未来 account_migration_required 已消失 |
| 52 人手机运行态 | 上述四个检查时刻均为 51 人通过、1 人原有手机身份缺失；已存在手机身份的 51/51 通过凭据和恢复校验 |
| CN 与 R760 上游数据库 | 两边均找到 52/52 对应 Key，Key 与 principal active，expires_at 为空，无 10 月 1 日定时失效条件 |
| 9 人实际公共接口 | unified-key resolve、Gateway credentials/current、MedEvidence validate-key 共 27/27 次返回 HTTP 200 且业务校验通过 |

未来时间检查使用生产实际记录及已部署的运行态校验函数，只注入校验时间，不修改服务器时钟；权益覆盖另按有效区间检查。当前公共接口验证使用配置要求的 `2.0.0-beta.76` 版本头，9 人实际均解析至 R760 MedEvidence 上游，接口返回的统一 Key 期限也全部匹配。首次不带版本头的探测返回 426，属于现有客户端版本门禁；加入规定版本头后通过。未创建登录会话，未发起模型生成，密钥仅在远程进程内存中使用。

续期操作测试：Node 18/18、Python guarded-control 相关测试 12/12 通过，包括批次原子回滚、旧值冲突、备份顺序及只读预览。

李霞原本没有 active 手机身份，仍需单独处理；本次完成的是到期续期，不代表全部历史登录问题已修复。当前接口验证也不等于完成 SMS 或 Desktop UI 的端到端验收。建议月底复查一次，并提前安排 2027 年 1 月 1 日前的下一轮续期；本次未创建定时提醒任务。

证据：[综合核验 JSON](../../../artifacts/user-accounts-export/oct1-expiry-closure-audit-20260917.json)、[生产续期回执](../../../artifacts/user-accounts-export/unified-key-renewal-result-20260917.json)、[公共接口验证](../../../artifacts/user-accounts-export/unified-key-renewal-validation-20260917.json)、[续期后脱敏快照](../../../artifacts/user-accounts-export/oct1-expiry-post-renewal-snapshot-20260917.json)。
