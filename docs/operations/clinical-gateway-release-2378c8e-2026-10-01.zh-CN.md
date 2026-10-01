# Gateway 2378c8e 发布记录

2026-10-01 02:25:43 UTC 完成 Gateway 最终验证；02:27:03 UTC 确认 star 测试任务物理清理。

已将 `origin/main` 的已提交版本 `2378c8e44e0eead62458caa01024e1c1a38ccf9f` 部署到 R760。
`current=2378c8e44e0eead62458caa01024e1c1a38ccf9f`，`previous=abffeaf723f72c20ba11e4c6468b21a1c9de7b29`。
此版本收录客户端契约、发布验收及 ZIP/DICOM 补充验收脚本/记录；与上一运行版本的 apps、packages、config 业务源码一致。
发布镜像来自干净 Git archive，未部署脏工作树；原有无关工作树修改保留。

## 发布和测试

- local TypeScript typecheck、39 项临床/CT 专项、6 项发布脚本测试通过。
- R760 干净源码镜像完成 npm ci、TypeScript build 和完整测试：1730 passed / 4 skipped；94 个测试文件通过，2 个文件跳过。
- 发布前验证备份：`/data/backups/codex-gateway-daily/20261001T021726Z`，2168082432 字节。
- controlled drain、Compose 配置预验证及 Gateway-only 重建完成；Nginx 临床 include 内容保持一致。
- 公网在 60 秒期限内连续两次 ready，工作站外部 HTTPS 探测同样两次 200 / ready。
- 切换前 33 项、切换后 45 项公网流程检查通过，另有 4 项清理确认。

切换前用真实试点 Key 完成 AIPAL 的创建、原键恢复、真实 CPU 推理、JSON/CSV 大小和 SHA256 校验、跨用户拒绝与删除。
同时创建 PanEcho 上传任务并验证中断分块、相同块重传和块清单；任务保留在 uploading 跨本次实际部署。
新容器使用原 key 恢复同一任务，完成真实 GPU 推理、40 项输出及 JSON/CSV/PNG 大小和 SHA256 校验，运行中取消和删除通过。
`/v1/models` 与 CT capabilities 公网回归均 200。
ZIP/DICOM 的 119 项实推理/反例补充验收已在前一版本完成；两版业务源码一致，详见 [格式验收](./clinical-panecho-formats-acceptance-2026-10-01.zh-CN.md)。

## 运行状态与清理

Gateway healthy，RestartCount=0，schema 38。环境变量、端口、原有挂载均保留；Research LLM Gateway、Worker、Maintenance 的容器 ID 保持不变。
既有 CT 的三个试点 Subject、每项服务每天 10 个新任务 / 最多 1 个未完成任务及不扣聊天 token 的规则保留。
五个数据库均 quick_check=ok、foreign_key_check=0；临床数据库 UID 999 / 0600，输入表为空，pending_action=0。
日志扫描没有发现后台 token、测试 session 或检验值。
三个本次测试任务在 star 均已 deleted，输入及产物/执行目录已物理清理；R760、容器和本地临时样本/状态/执行脚本已删除。
保留受保护发布和恢复记录，不删除长期控制墓碑，也未修改用户、Key、Plan 或额度。

首次准备发布时，严格预检发现前轮只读验收导入 Python 模块生成了未跟踪 pyc 缓存，尚未开始 drain 或切换。
已验证并归档该缓存至 `/opt/codex-gateway-r760/backups/release-hygiene-2378c8e-20261001/`，源码未改变。
重新准备后通过；本轮所有发布目录的 Python 验证使用 `-B`，最终发布目录没有新增缓存文件。
本次单实例 drain / 重建有维护窗口，不声明零停机；没有执行回滚。

R760 受保护证据目录：`/opt/codex-gateway-r760/backups/release-2378c8e44e0e/`。
deployment.json 含私有运行配置，禁止打印或转发给客户端。
脱敏本地证据：[final-verification.json](../../artifacts/clinical-gateway-release-2378c8e-20261001/final-verification.json)。
客户端继续以 [v1 接口契约](./clinical-models-v1.md) 为准；本次发布后的记录提交只更新运维文档。
