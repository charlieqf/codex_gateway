# Gateway 运行状态与 900 秒预算发布记录

北京时间 2026-10-13 08:28:52，Gateway 已部署 `94b60aec5974e0aafadf0aeeba05fe045b745da2`。代码已推送 main；从干净的提交归档构建并发布，只重建 Gateway。Research Worker 保持 `088f11ad8b97afedb72699be5018420d8a10d51e`，其他服务容器和端口核对未变。

## 生效范围

- 现有模型调用回执在 running 时可选提供六个 progress 字段，终态清理；字段定义见[契约](../coordination/model-call-progress-v1.zh-CN.md)。状态仅保存在现有活动回执的内存对象中，没有新增数据库表、定时器或 SSE 事件。
- `models.goldencode` 总预算为 `900000` 毫秒，天宽与腾讯适配器上限均为 `900000` 毫秒。其他模型默认 `600000` 毫秒保持不变。客户端指定更短期限仍受其约束，内部重试不重置原预算。
- 心跳、查询、role、usage、DONE 不更新模型活动时间；progress 不代表整个客户端任务完成比例，也不会加快上游推理。

## 验证结果

本地类型检查和 9 个相关文件的 490 项测试通过。干净 Linux 构建及全量测试通过：1860 项通过、4 项跳过。数据库 schema 保持 41。

公网自测使用临时测试主体和凭据：

- 腾讯非流式调用和天宽流式工具调用均成功；实际运行回执确认 900000 毫秒预算。
- 额外天宽调用观察到 waiting_upstream、reasoning 及非空 last_model_activity_at；没有在本次线上采样中捕获 generating、validating 或 retrying，其他阶段和活动过滤由自动化测试覆盖。
- GET 恢复结果与原响应哈希一致；同 ID 重放结果一致，未增加模型预留记录；其他主体无法读取回执或 progress。
- 1 毫秒短预算实际返回 HTTP 504 / upstream_timeout，失败回执不含 progress；主动断开原请求后活动快照清除。
- 所有 7 个测试主体已禁用，有效凭据和未结束预留均为 0；测试授权已撤销，撤销凭据访问公网返回 401。保留必要审计记录。

Gateway 健康，重启次数 0，公网 ready。六个数据库 quick_check 均为 ok、外键违规数均为 0。00:32:04 UTC 的日志核查中 error/fatal 均为 0。最终清理核验时间为 00:35:11 UTC。

900 秒边界使用虚拟时钟测试，线上验证实际预算与短期限终止；本次没有故意运行持续 15 分钟的付费调用，也没有证明上游不存在更短的独立限制。Desktop 的 UI 展示与长任务端到端行为仍需客户端验收。

## 发布与恢复依据

前版本为 `088f11ad8b97afedb72699be5018420d8a10d51e`，已确认它是本次提交祖先。镜像为 `sha256:d0339c9f93d8553bca8afc192fab23c45fb0a61ade5e29bed67d19f364fc1872`，current 指向 `/opt/codex-gateway-r760/releases/94b60aec5974e0aafadf0aeeba05fe045b745da2`。

数据库备份位于 `/data/backups/codex-gateway-daily/20261013T002323Z`，已验证三个备份数据库。受保护的旧配置和发布恢复材料位于 `/opt/codex-gateway-r760/backups/release-94b60aec5974/`；含凭据的材料仅留服务器，不进入仓库。

切换使用部署锁、排空、固定镜像及受控回滚流程。00:28:34.546 至 00:28:52.833 UTC 的约 18.3 秒包括排空、替换和验证，不等同于精确中断时长。切换后限时公网探针连续两次 HTTP 200 / ready，无需回滚。

自测准备阶段曾因测试主体 scope 与 Plan 不匹配而停止，修正后继续；另一次模型在 948 毫秒完成，1 秒轮询未捕获 running，缩短测试采样间隔后通过。清理审计发现 upsertSubject 不更新已有主体状态，改用 setSubjectState 并核验全部禁用。这些问题均已在测试流程中解决，未改动生产业务代码或客户端查询频率建议。

## 脱敏证据

- [构建与测试](../../artifacts/gateway-progress-release-94b60ae-20261013/build-summary.json)
- [切换结果](../../artifacts/gateway-progress-release-94b60ae-20261013/cutover-summary.json)
- [切换后的公网收敛](../../artifacts/gateway-progress-release-94b60ae-20261013/cutover-public-health.json)
- [公网功能自测](../../artifacts/gateway-progress-release-94b60ae-20261013/public-smoke.json)
- [真实模型活动自测](../../artifacts/gateway-progress-release-94b60ae-20261013/semantic-smoke.json)
- [健康、配置、数据库与清理核验](../../artifacts/gateway-progress-release-94b60ae-20261013/final-verification.json)
