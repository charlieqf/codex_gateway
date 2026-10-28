# 视觉审核补充修复与上线核验（2026-10-28）

已于 2026-10-28 03:17:21 UTC（北京时间 11:17:21）部署
`1efc613f32bbd2a2068d18e1f7cc0639a44a7d03`，03:20:29 UTC 完成最终核验。
previous 为 `007f5073428ead3457c7f786b139aa6a4bddedb2`。生产环境、端口和其他三个容器均未改变。

## 审核意见 2–5

- 操作步骤已整理为[视觉发布 runbook](./cloud-vision-rollout.md)，并从容器部署 runbook 和模型合同链接。
  固定候选路径、准备、Node env-file 预检、`--enable-vision` 部署、`--vision` 公网验收均给出完整顺序。
  视觉已启用的后续代码发布允许候选不变，仍须逐字节核对候选与现场配置。
- 自动适配只选择不高于公共有效档位的最近可用档。视觉只支持 medium/high 时，low 不再升为 high；
  因不存在更低档而返回结构化 400。显式视觉别名也不能导致升档。
- 新错误分支补齐 contractVersion、recommendedAction、recoveryOwner、parameter、requestedValue、supportedValues。
  xAI 缺省能力按视觉 runtime 判定，不再从 Codex 文字 runtime 推断；不带档位的图片请求回归通过。
- 预检与公网 smoke 共用图片构造、请求构造和文本提取，删除重复的七段数字图片和消息组装代码。

## 真实运维验证

实现提交 `acbdab4` 通过 Windows 与 Linux 全部 501 项相关回归，另有 11 项脚本测试通过。
预检包装器的第一次实跑失败，原因经对照确认：Node 24 从 `--env-file` 读入
`NODE_USE_ENV_PROXY=1` 并未启用代理；同一请求显式加 `--use-env-proxy` 后恢复连通。
未因此切换生产或误判为 xAI 故障。修订 `1efc613` 按线上代理开关添加启动参数并记录到 runbook。
它与 `acbdab4` 的差异只有宿主机预检包装器和文档，运行时镜像代码相同，保存了等价性记录。

最终按 runbook 的实际预检命令运行：D、GLM 的 MAX Responses 图片流均成功读出 7319。
候选文件与生效环境 SHA-256 均为
`135040ec8955d035bfea919d198cddfdc9c112d599573177007f28bbe1b99e35`。
DB 备份副本兼容检查通过，仍为 schema 44。只重建 Gateway；20 个受保护文件保持不变。
切换约 61.3 秒；公网采样 49 次 503、3 次 502，非就绪区间为 03:16:22.449–03:17:14.526 UTC，
随后恢复 ready。没有声称零停机。

公网六项全部 HTTP 200、正确内容、完整流终态和账本结算：

| 请求 | request ID |
| --- | --- |
| D 图片 Chat 非流式 MAX | `req-25336b13-d56c-4faa-b546-4c8c73d95ba7` |
| D 图片 Chat 流式 MAX | `req-bee04873-18dc-4e3b-8bd9-60409ab69bd7` |
| D 图片 Responses 非流式 MAX | `req-0cc1e2ac-bf65-4fd3-984a-b26fd8ad0f81` |
| D 图片 Responses 流式 MAX | `req-20fae99b-5e84-402a-ab31-d73ef4510963` |
| GLM 图片 Chat MAX | `req-ff6d7d51-1c61-4ab2-98fb-390f229f6616` |
| D 纯文本 MAX | `req-8ce52f93-618a-4af8-9ce1-472c413c06d2` |

前五项实际 xai/grok-4.5、有效 high、回复 7319；最后一项仍为 tiankuan/deepseek-v4.1-flash、
有效 max、回复 TEXT_OK。测试 Subject 禁用，凭据撤销且公网复核 401，权益取消、Plan 废弃，
测试及过期待结算均为零。临时 DB 副本与容器内测试报告已清理，审计记录保留。
最终 Gateway healthy、零重启/OOM，两个数据库 quick_check=ok、无 FK 违规，日志无 error 级记录。

证据目录：`/opt/codex-gateway-r760/staging/1efc613f32bbd2a2068d18e1f7cc0639a44a7d03`。
数据库备份：`/data/backups/codex-gateway-daily/20261028T031433Z`。
配置/部署备份：`/opt/codex-gateway-r760/backups/release-1efc613f32bb`；候选环境含凭据，未提交。
失败预检证据保留在 `staging/acbdab499262a58896c2d3ae2eb258aad72e9e68`。
