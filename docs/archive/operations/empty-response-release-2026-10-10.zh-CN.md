# 空响应恢复与失败计费发布记录

2026-10-10 04:27:36 UTC 已将 `main` 已提交并推送的 `1e41c4c55c78d236a07b309e32bb43d4c95d8d91` 部署到 R760；04:29:54 UTC 开始的最终检查通过。
`current=1e41c4c55c78d236a07b309e32bb43d4c95d8d91`，`previous=2378c8e44e0eead62458caa01024e1c1a38ccf9f`。

## 上线行为

- GoldenCode 文本池对符合条件、已结束且无内容/工具/推理输出的空响应，在原请求期限内切换另一个平台重试；沿用现有 failover gate，最多两次上游调用。
- 确认符合条件的空响应不扣用户额度；恢复成功只按成功调用结算，两次均为空时扣费为零。上游观测 usage 与用户计费分开保存。
- schema 39 新增持久化计费决策；结算事务失败时保留 pending 决策，由后续清理恢复，避免重新按估算量扣费；支持幂等、迟到结算与额度重置竞争处理。
- 此规则不覆盖所有失败；部分输出、取消、超时及无法确认的异常保留原有计费规则。客户端 30 秒主动终止仍需客户端调整。

## 验证结果

- 干净 Git archive 构建 Linux 镜像，完整测试 **1795 passed / 4 skipped**。本地额外存在未提交的独立测试，因此本地全量为 1796 passed / 4 skipped；发布以干净源码结果为准。
- 在发布前备份副本上验证 schema 38→39，重复初始化幂等；九张历史业务表行数一致，quick_check=ok、外键违规为零。
- 同一生产候选镜像的隔离实例完成 **32 组故障注入自测**：Chat Completions/Responses、JSON/SSE、文本/工具、一次/连续空响应、有/无 usage；验证跨平台恢复、零计费/仅成功调用计费，以及 Chat Completions 重放不产生新上游调用。
- 公网腾讯文本请求成功，136 tokens；天宽流式 required-tool 请求成功，363 tokens。两次相同 Call ID 重放均与原响应一致，只有两笔 reservation，免费额度账本合计 499 tokens，付费额度扣减为零。
- 测试账号已 disabled，临时凭证已撤销（公网再次使用返回 401），entitlement 已取消，未结算测试 reservation 为零。保留必要审计记录，未修改真实用户额度。
- Gateway healthy / RestartCount=0，schema 39，公网连续两次 200 / ready / 非 draining；工作站外部 HTTPS 也连续两次验证通过。
- gateway、client-events、imaging、aipal、panecho 五个数据库均 quick_check=ok、foreign_key_check=0；pending 计费决策为零。最终检查时尚无线上符合空响应豁免条件的决策记录。
- 切换后日志扫描 error/fatal、warn、SQLite 错误、结算错误均为零；受保护配置与密钥文件权限通过检查。

公网自测验证了真实正常调用与计费/重放；空响应恢复及豁免通过同镜像隔离故障注入验证，未声称真实上游在本次公网自测中复现空响应。

## 发布与恢复证据

发布前备份 `/data/backups/codex-gateway-daily/20261010T041227Z` 已校验，共 2,210,959,360 字节；Gateway 备份 schema 38。
镜像 ID：`sha256:3359442d9ea8002ea781ceca3d1bc2087d1e1fad7afd3878903f8992c9f474ff`。
只重建 Gateway，Research 其他容器 ID、运行环境与端口保持一致。

受控排空/切换校验区间为 04:27:19.752832–04:27:36.611593 UTC（约 16.9 秒）。这不是精确公网中断时长；单实例发布存在维护窗口，不声明零停机。本次没有回滚。
公网收敛使用 60 秒固定期限、每次最长 5 秒、间隔 1 秒且要求连续两次 ready；已保存探测结果。

构建初次验证因基础镜像继承生产环境变量而失败，改为仅在构建测试步骤使用干净测试环境后，全量通过。隔离 smoke 的初始免费计划 ID 不在固定识别列表，修正测试夹具后 32 组通过。最终权限校验初稿未接受既有 root:999 / 0440 服务令牌，按实际受保护挂载规则修正检查后通过；生产权限未修改。这些检查失败均未造成线上回滚。

R760 受保护证据目录：`/opt/codex-gateway-r760/backups/release-1e41c4c55c78/`；其中 `deployment.json` 含私有运行配置，禁止转发。
临时数据库副本已删除，公网 smoke 通过 stdin 执行，无容器内临时脚本或用户输入文件残留。构建与验证脚本作为发布恢复证据保留。

脱敏证据：[最终验证](../../../artifacts/empty-response-release-1e41c4c-20261010/final-verification.json)、[迁移演练](../../../artifacts/empty-response-release-1e41c4c-20261010/migration-rehearsal.json)、[32 组故障注入](../../../artifacts/empty-response-release-1e41c4c-20261010/artifact-smoke.json)、[公网收敛](../../../artifacts/empty-response-release-1e41c4c-20261010/cutover-public-health.json)。
