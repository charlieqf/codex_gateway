# Gateway 超时诊断与告警发布记录

2026-10-12 01:53:23 UTC 部署 `main` 已提交、已推送的 `41e769ce035834fc970ad449828bbcf0df00929d`；01:57:35 UTC 完成运行快照配置加载，01:58:23 UTC 最终验证通过。
当前版本 `41e769c`，前一版本 `1e41c4c55c78d236a07b309e32bb43d4c95d8d91`。本次仅重建 Gateway，其他项目容器 ID 和公开端口保持一致。

## 已上线范围

- 管理端超时触发来源、终止输出阶段与最近收包证据；缺失证据保留 unknown。
- 运维窗口按推算完成时间计数，模型请求单列，超时率排除用户取消。
- 单次、同用户重复及同通道聚合超时告警；长时间等待/截止后清理异常的定时日志。
- 增加运行配置 `GATEWAY_OPS_RUNTIME_SNAPSHOT_PATH=/var/lib/codex-gateway/ops-runtime.json`，快照每 5 秒刷新，健康检查校验时效。
- schema 40 新增完成时间索引，兼容 R760 系统 Python 使用的 SQLite 3.37.2。

公开错误、SSE 协议、重试预算和计费政策未修改。外部通知调度和持久化去重尚未接入；客户端实时进度协议不在本次发布中。

## 验证

- 干净 Git 制品构建 Linux 候选镜像：**1804 passed / 4 skipped**；本地健康报告 Python 测试 7 项通过。
- 备份副本上重复初始化 schema 39→40 幂等；索引创建约 367 ms，增加 4,792,320 字节；10 张业务表行数一致，Node 与系统 Python 的完整性/FK 校验均通过，查询计划确认使用索引。
- 两条历史超时记录分别识别为工具参数未完成、仅推理，均为总截止且近期仍有收包；仅检查计数与诊断，不输出用户内容。
- 公网腾讯非流式文本、天宽流式 required-tool 均成功，分别消耗 136 / 363 tokens；同 Call ID 重放内容一致，账本核对通过。
- 人工设置 1 ms 请求时限，公网返回 `504 upstream_timeout`；管理端关联到该消息，诊断为 `gateway_deadline / awaiting_headers`，运维超时告警中可找到该请求，公开响应不暴露管理端字段。
- 运行快照持续刷新；Gateway healthy、RestartCount=0；gateway、client-events、imaging、aipal、panecho 五个数据库均 quick_check=ok、外键违规为零，pending 计费决策为零。
- 临时测试账号禁用并隐藏，临时凭证撤销（公网再次使用返回 401），entitlement 取消，未结算测试 reservation 为零。仅保留必要审计记录。
- 最终日志 error/fatal=0，warn=1（有意触发短时限超时），存储及快照写入错误为零。公网发布端和工作站外部 TLS 健康检查均通过。

真实上游的十分钟流式截止未在线重演；该形态通过历史记录和单元/集成测试验证。线上短时限测试验证了公开超时、管理端关联、分类与运维快照的完整路径。

## 发布过程与恢复

- 发布前备份 `/data/backups/codex-gateway-daily/20261012T014721Z`，已验证，共 2,234,097,664 字节。
- 镜像 ID：`sha256:44013cdc13ab8f8fa6597f3065fe74cd6b6f84f557a204c838f2c6583ca3233f`。
- 首次排空/切换校验区间 01:53:06.812207–01:53:23.858962 UTC，约 17 秒。
- 为启用此前未配置的运行快照，第二次受控排空/替换区间 01:57:19.372235–01:57:35.111615 UTC，约 15.7 秒。
- 以上不是精确公网中断时长；单实例发布存在维护窗口，不声明零停机。两次均使用 60 秒期限、单次至多 5 秒、间隔 1 秒、连续两次 ready 的公网收敛检查。未发生回滚。
- 自审后的部署检查发现初版索引使用系统 SQLite 不支持的 `unixepoch`，在切换前修复并另行提交为 `41e769c`。初版 `c154940` 未部署。
- 第一轮公网自测的测试账号被管理端 smoke 过滤隐藏，导致关联断言失败；数据实际已正确入库。调整夹具名称后复测通过，未修改过滤规则。两轮临时凭证均已撤销。
- 配置权限检查的最初断言只接受 root 所有文件，后按既有服务挂载允许 uid/gid 999、0400 的密钥；未更改密钥权限。

受保护的恢复材料位于 `/opt/codex-gateway-r760/backups/release-41e769ce0358/`：原 override、快照配置变更前的 Gateway env、部署状态和备份信息。`deployment.json` 与 env 含私有运行配置，不可转发。构建与校验脚本保留在对应不可变发布 staging 中，迁移临时副本已清理。

脱敏证据：[构建](../../artifacts/gateway-timeout-release-41e769c-20261012/build-summary.json)、[迁移演练](../../artifacts/gateway-timeout-release-41e769c-20261012/migration-rehearsal.json)、[公网自测](../../artifacts/gateway-timeout-release-41e769c-20261012/public-smoke.json)、[最终验证](../../artifacts/gateway-timeout-release-41e769c-20261012/final-verification.json)、[首次公网收敛](../../artifacts/gateway-timeout-release-41e769c-20261012/cutover-public-health.json)、[配置加载后公网收敛](../../artifacts/gateway-timeout-release-41e769c-20261012/snapshot-enable-public-health.json)。
