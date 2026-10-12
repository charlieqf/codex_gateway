# 人物研究输入扩展发布回执

2026-10-12 09:10:54 UTC 完成切换，09:20:35 UTC 完成最终验证。

## 发布范围

- Gateway、Research Worker 均为 `088f11ad8b97afedb72699be5018420d8a10d51e`，使用已推送 `main` 的干净源码快照构建。镜像 ID：`sha256:03576460978cfc25342414fdcd473f250dd4da823b1a485ada0478fcf9c8edb9`。
- 所属机构可为医院、药企、学会、大学或研究所；科室可省略或为 `null`，新增采访主题及重点字段。旧请求保持兼容。
- 身份核验不再要求无科室人物提供科室证据；修正身份失败文案及配置错配日志，公共错误不暴露内部配置名。历史失败记录未回写。
- 保留现有 120 秒相关单次调用预算、完整任务预算及限额。Gateway schema 仍为 41，未增加数据库迁移。
- 仅按 worker、Gateway 的顺序更新两项服务。环境除 worker 版本标记外未变，挂载、端口、maintenance 和私有 LLM 服务均保留。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 干净 Linux 构建及全量测试 | 1855 项通过、4 项跳过 |
| 公网健康 | 切换后及最终复核均连续两次 ready，未处于排空状态 |
| 旧嵌套请求 | 创建返回 202，同幂等键重放返回同一任务，取消成功；未执行完整旧格式生成 |
| 新平铺请求 | 翟一帆／亚盛医药／采访主题“淋巴瘤”／省略科室，完整生成成功 |
| 幂等规则 | 同键补传 `department: null` 重放成功，同键改采访主题返回 409 |
| 返回结构 | `department: null`，`matched_by: ["institution"]`，五组问答，结果版本仍为 v1 |
| 四份文件 | 人物简介、综述、问题、问答均通过公网下载、字节数和 SHA-256 校验 |
| 运行状态 | Gateway、worker healthy，RestartCount 均为 0；worker 心跳正常 |
| 数据库 | 6 个数据库 quick_check=ok，外键违规均为 0 |
| 发布后日志 | 截至最终复核，Gateway、worker 警告、错误及存储错误均为 0 |

新格式案例用时 **298 秒**，记录了 10 次模型调用，单次最大约 67.1 秒，未记录调用错误。120 秒不是整项任务时限，调用方继续使用异步创建和轮询。

旧格式任务：`drr_64f4cffe31424028aca35002f10d089e`；新格式任务：`drr_954b7f56df91420dbb82a6b724aa7b38`。上述测试任务已过期处理，不能作为调用方下载入口。

生成结果为 `passed_with_warnings`，包含 `practical_profile_scope_limited`。本次证明公开接口及完整执行链路可用，不等于六个案例的内容均已通过人工验收，也不保证后续每次任务的耗时。调用方自身的空科室解析、`matched_by` 长度假设和界面仍须联调。详见[字段方案](../outbox/person-research-input-fields-proposal-2026-10-12.zh-CN.md)和[六案例记录](../outbox/person-research-six-cases-validation-2026-10-12.zh-CN.md)。

## 备份、切换及清理

发布前核对线上 Gateway `c69e3ed`、worker `cdd6a69` 均已包含在本次提交中。备份目录为 `/opt/codex-gateway-r760/backups/release-088f11ad8b97`；Gateway 例行备份为 `/data/backups/codex-gateway-daily/20261012T090438Z`，另对 research.db 做在线备份。配置复制校验、数据库备份校验及受保护文件权限检查通过。

研究任务为空后排空网关，再切换 worker 和 Gateway；未触发回滚。`current` 指向本次版本，`previous` 指向 `c69e3ed38aacd2020744a1fa0fda870a4b5578ca`。worker 原镜像及发布前配置另保存在受保护部署记录中，回滚时须分别恢复两项服务。

临时测试凭证全部撤销、主体停用、权益取消；新旧两个测试任务均终止并过期，四份测试文件及对应结果／中间数据已清理。保留审计记录及过期任务记录，未绕过审计保留约束。自测脚本最初的套餐、幂等头设置及临时文件属主问题均已修正，不涉及生产代码或运行配置变更。

脱敏证据：[构建](../../artifacts/person-research-release-088f11a-20261012/build-summary.json)、[切换](../../artifacts/person-research-release-088f11a-20261012/person-cutover.json)、[公网健康](../../artifacts/person-research-release-088f11a-20261012/cutover-public-health.json)、[公网自测](../../artifacts/person-research-release-088f11a-20261012/public-smoke.json)、[调用耗时](../../artifacts/person-research-release-088f11a-20261012/smoke-telemetry.json)、[最终复核](../../artifacts/person-research-release-088f11a-20261012/final-verification.json)。
