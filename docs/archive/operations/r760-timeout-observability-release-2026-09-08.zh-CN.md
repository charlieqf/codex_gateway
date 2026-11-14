# R760 异常流统计与超时分类发布验收

2026-09-08 北京时间 19:11:13，Gateway 修复 `6640d0eda4db0f90ecf6aa18adbfb95e38b8f251` 已部署。19:19:46 完成最终检查，公网健康、异常流自测、实际请求统计和管理员接口验收均通过。

## 发布结果

- `current`：`6640d0eda4db0f90ecf6aa18adbfb95e38b8f251`。
- `previous`：`ebad087785d4158767bca99c8f841e33df4eca97`。
- 镜像：`sha256:474c620d9604bda01644223ca101b868beb454db5922198cd1e46aff21078d70`。
- 备份及验收证据：`/opt/codex-gateway-r760/backups/timeout-observability-6640d0e`。
- 原始 Git 归档 SHA-256：`b44bdb78a11ad28d72f8517c44aee2207c64159c1930f82df45472c5138f8b3e`。

从已推送提交的归档进行干净 Linux 构建、安装锁定依赖并执行测试。运行镜像基于原生产镜像，只覆盖本次涉及的 Gateway 与 Core 模块；依赖和其他运行模块保持原样。本次没有数据库迁移。

切换前对 Gateway、客户端事件和 Research 数据库做在线备份，逐一验证 `quick_check=ok`、外键违规为 0，并记录备份哈希。配置副本已校验哈希；环境文件为 root 所有、权限 0600，挂载凭据权限为 0400。切换前未结算请求预留为 0。

使用运行容器标签确认的 Compose 文件和环境文件，仅重建 Gateway。发布后环境指纹、配置哈希均保持一致；Research Worker、Research LLM Gateway、Research maintenance、Mihomo 和 Qwen 的容器 ID 均未变化且健康。Gateway 继续只发布 `127.0.0.1:18787->8787`，重启计数为 0。

## 验收证据

干净 Linux 构建中 7 个相关测试文件、448 项测试通过，覆盖超时分类、异常统计、HTTP 路由、SQLite、管理员 JSON 和重试边界。

人工 SSE 自测在构建阶段、候选镜像和已上线容器中均通过。上线容器使用实际编译模块，在独立进程注入响应，不连接生产数据库或真实供应商：

| 场景 | 上线容器结果 |
| --- | --- |
| 总期限超时 | `deadline_exceeded`，保留 HTTP 200、请求 ID、已收到的 1,392 字节及未完成工具参数统计，完整工具交付数为 0 |
| 响应体超时 | `body_timeout` / `UND_ERR_BODY_TIMEOUT`，对外 `upstream_timeout`，保留 HTTP 200 和 429 字节流进度，完整工具交付数为 0 |
| 正常完成 | 保留 633 字节流进度，正常交付 1 个完整工具调用 |

期限场景的帧数随调度略有变化；断言检查统计与实际注入内容一致，不固定帧数。

公网测试使用临时测试凭据和模拟 Desktop 消息协议，直接读取实际 HTTPS 响应：

| 场景 | 结果 | 请求 ID |
| --- | --- | --- |
| 正常流式工具调用 | HTTP 200，5,203 ms，腾讯 1 次尝试；交付 `multiply(2,3)`，保存 3,012 字节、12 个 SSE 数据事件、13 字节工具参数 | `req-46e9c794-2af0-4b30-91cd-20945dd447ca` |
| 请求总期限 200 ms | HTTP 504，219 ms，腾讯 1 次尝试；`deadline_exceeded / gateway_deadline`，保留停止自动重试契约，无成功 `[DONE]` | `req-4ab55506-5a75-46c2-9856-4f7d756a1d1c` |

正常请求首末读取时间有效、取消标记均为 false。200 ms 请求在收到上游字节前结束，因此流进度为 0，未虚构上游响应统计。普通推理响应未暴露 `streamProgress` 或底层 `UND_ERR_*` 信息。

管理员页面按既有规则隐藏 smoke 测试账号。首次验收脚本错误地要求该账号在管理员查询中可见，原结果保留在 `public-smoke-fixture-filter.json`；调整测试预期后复验通过，没有修改生产过滤规则。

管理员链路另用上线后普通用户的请求 `req-8042e48c-cc3e-4dae-8aa3-fee2e04a1495` 做只读核验：精确关联原客户端消息，`stream_progress` 的八项字段均与 SQLite 中对应尝试的 `streamProgress` 一致。核验没有输出该用户的消息正文、手机号或凭据。

两批测试用户均已停用、凭据已撤销、未结算预留为 0，临时凭据目录已删除；撤销后的凭据访问返回 HTTP 401。最终三个数据库均通过 `quick_check` 和外键检查，Gateway schema 保持 27。上线后日志扫描未发现 error/fatal、未捕获异常或未处理 Promise 拒绝。

主要证据文件：`deployment.json`、`build.log`、`candidate-synthetic.json`、`deployed-synthetic.json`、`public-smoke.json`、`live-admin-correlation.json`、`final-audit.json`。

提交归档和构建文件已核验后保留在备份目录，远端部署暂存目录已清理；当前发布、上一发布及回滚镜像保留。

## 自测与回滚

重复自测命令及验收字段见[修复与自测说明](../outbox/r760-medcode-timeout-observability-fix-2026-09-08.zh-CN.md)。管理员页面隐藏 smoke 账号；验证公网管理员关联时，应对普通用户的上线后请求做受限只读查询。

若需回滚，使用备份记录中的原镜像、发布目录和相同 Compose 组合，仅重建 Gateway；不恢复数据库覆盖新增业务记录。保留原有总期限、供应商读取期限、路由和重试配置。

本次上线修复统计缺失和超时误分类。响应体超时通过人工异常验证；没有人为让生产供应商连接空闲五分钟。修复不保证供应商长请求不再超时，历史已丢失的异常流统计也无法补回。
