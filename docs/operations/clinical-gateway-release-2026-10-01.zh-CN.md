# AIPAL / PanEcho Gateway 上线与客户端交接

2026-10-01（Sydney）。最终公网与数据库验证完成于 2026-09-30 23:46:44 UTC；star 物理清理确认完成于 23:47:15 UTC。

Gateway 已上线 `/gateway/aipal/v1`、`/gateway/panecho/v1`。
客户端开发以 [clinical-models-v1.md](./clinical-models-v1.md) 的 v1 契约为准：创建、查询、取消、删除、结构化结果、产物下载及 PanEcho 分块上传均已实现。
公网 origin 为 `https://goldencode.instmarket.com.au:1443`，沿用现有用户 Key。

## 上线范围

| 项目 | 最终状态 |
| --- | --- |
| Gateway 运行版本 | `abffeaf723f72c20ba11e4c6468b21a1c9de7b29`，已提交并推送 main |
| current / previous | `abffeaf723f72c20ba11e4c6468b21a1c9de7b29` / `45487aa94d81688a1b8c6e50ebb7e940a05415d8` |
| AIPAL / PanEcho | 分别经校验证书的 HTTPS 连接 star 7444 / 7445 |
| 试点用户 | 两项服务均沿用现有 CT 的 3 个 Subject |
| 每项服务额度 | 每 Subject 每 UTC 日 10 个新任务，最多 1 个未完成任务；幂等重放不重复占次数 |
| 计费 | 临床任务不进入聊天 token 计费流程 |
| 输入保留 | 最多 24 小时；独立输入表，secure_delete 与 WAL 清理；输入不进入长期控制记录和日备份 |
| 私有凭据 | 独立服务 token / CA 文件仅由 R760 运行环境持有，容器只读挂载 |
| 健康 | 公网连续两次 ready，容器 healthy、RestartCount=0，身份库 schema 38 |

默认关闭、按 Subject 放行；两项服务分别配置开关、额度、并发、数据库及后台凭据。
Gateway 使用真实认证 Subject 生成不同服务的 owner，丢弃客户端伪造的内部 owner/token 请求头。
临床任务采用直接任务适配层，复用 CT 的私有 HTTPS 传输与完整性校验，不依赖 CT study/series。
提交、取消、删除及上传完成意图均先持久化；恢复沿用原后台幂等键，不自动重跑明确失败的推理。

## 验证结果

最终干净源码构建完成 `npm ci`、TypeScript build 和完整测试：**1730 passed / 4 skipped**；另有 6 项发布脚本测试通过。
临床专项 18 项测试覆盖身份隔离、服务关闭、输入单位和必填项、独立额度、超时恢复、取消/删除恢复、分块校验、数据库路径保护、日志脱敏和实际 SQLite/WAL 输入清理。

使用两个已有 CT 试点用户的真实 Key，经公网进行了 79 条检查记录，pre 与 resume 阶段全部通过。
Key 仅在容器内存中恢复使用，没有写入脚本、报告或日志，也没有新建/修改用户及 Plan。

| 公网流程 | 结果 |
| --- | --- |
| 两项 capabilities / source | 已认证请求 200，源码 ZIP 的 SHA256 校验通过；无 Key 为 401 |
| AIPAL 十项合成检验值 | 真实 CPU 推理完成，ALL / AML / APL 三项概率返回，JSON / CSV 下载完整性通过 |
| 输入校验 | PT_percent 使用 INR 单位被 422 拒绝 |
| 幂等恢复 | 丢弃 AIPAL 已接受响应后，同 key 重放返回原任务；改变输入 409；删除后同 key 404 |
| 跨用户访问 | 查询、结果、产物、取消和删除均 404；伪造 owner 不能越权 |
| PanEcho 分块 | 上传中断未提交部分块；查询后重传成功；相同块重放成功；未完成任务占用时新建 429 |
| Gateway 重建 | uploading 任务和块清单跨实际容器替换保留；原 key 返回原任务；complete 重放成功 |
| PanEcho 真实 GPU 推理 | 公开心超视频返回 40 项输出；JSON / CSV / PNG 的清单大小、响应头及文件 SHA256 全部一致 |
| 取消与删除 | 运行中任务取消后变为 cancelled；删除立即禁止查询/下载；已完成任务删除后可立即新建下一任务 |
| 既有接口 | `/v1/models` 和 CT capabilities 公网回归 200；CT 传输与接口专项测试通过 |

PanEcho 公网样本为公开 ECHOpedia A4CTTS 视频（595712 字节，ROI `[0.24,0.21,0.78,0.8]`）；AIPAL 使用合成数值，没有真实患者数据。
首次发布验收覆盖 video；2026-10-01 已补齐 video_zip / dicom_zip 公网实推理及两个 DICOM 反例，119 条检查记录全部通过，见 [格式补充验收](./clinical-panecho-formats-acceptance-2026-10-01.zh-CN.md)。
24 小时清理通过可控时钟与真实 SQLite/WAL 文件回归验证，未等待线上满 24 小时。
每日 10 次上限通过持久化回归及线上配置确认，未耗尽试点用户的当日额度。
Desktop 工具和结果界面的安装包验收由客户端团队继续完成。

## 发布与恢复记录

发布使用 main 的已提交 Git bundle、干净不可变源码与镜像，保留全部已有运行配置。
切换前完成验证备份，最终备份为 `/data/backups/codex-gateway-daily/20260930T233719Z`，总计 2167402496 字节。
首次开发前的工作树备份位于 `C:/work/backups/codex-gateway/pre-clinical-20260930T224707Z/working-changes.zip`；既有无关修改未纳入功能提交。
仅替换 Gateway；Research LLM Gateway、Worker、Maintenance 的容器 ID 与部署前一致。
GoldenCode Nginx 仅新增临床路由，关闭该路径的 access/error 日志，允许 8 MiB 分块并关闭代理缓冲。
最终临床 include 保留在 `45487aa` 不可变目录，内容与最终版本一致；回退/清理发布目录时需保留该引用。

过程中修正并记录了三类问题：

- 首次配置预验证发现现场 YAML 使用不同的列表缩进；在任何 drain/切换前中止，修复后重新发布。
- 首次 PanEcho 实推理后发现 star 删除已完成任务仍携带 result_revision=1，Gateway 原解析拒绝该响应。修复并新增两项回归后重新构建、发布、完成全流程。
- 重建自测按数组顺序比较 Docker Mounts 触发断言，执行恢复并确认健康。按 Destination 核对后确认挂载内容及全部环境变量完全一致，列表顺序变化；最终重建与续传验收通过。

另外补齐提前删除/失效输入后的 WAL checkpoint，后台会重试繁忙的 checkpoint，避免已删除检验值残留在 WAL。
单实例 drain 与容器重建存在维护窗口；公网收敛按 60 秒期限、最多 5 秒单次探测、连续两次 ready 验证，不声明零停机。

最终五个数据库均 `quick_check=ok`、foreign_key_check=0；两个临床库为 UID 999 / 0600，输入表为空且没有待恢复操作。
近期应用日志检查未发现后台 token、检验值或测试 session。
正常及编码路径的脱敏探针均 401，标记未进入应用及 Nginx access 日志。
全部本次测试任务在 star 已进入 deleted，输入和产物目录已物理删除；Gateway 测试视频、状态文件和执行脚本已清理。

## star 侧交接

star 需继续保持 `/internal/aipal/v1` 与 `/internal/panecho/v1` 的版本化直接任务协议，接受 R760 专用 Bearer token 和 X-Clinical-Owner，保证同 owner / 幂等键不会重复推理，并持续支持查询、取消、删除及 PanEcho 块清单恢复。结果清单须提供不可变 `{name,size,sha256}`，产物下载须同时返回正确 Content-Length 和 X-Content-SHA256；输入、视频、结果及执行日志按 24 小时物理清理，删除/过期墓碑不保留原始输入。当前联调版本已补齐下载散列头并通过实际下载与清理验证；后续更换模型或升级服务时，需保留这些契约及 owner 隔离、取消语义和 GPU 调度行为。

## 证据路径

R760 受保护发布证据：`/opt/codex-gateway-r760/backups/release-abffeaf723f7/`，包含构建日志、pre/resume/cleanup 报告、重建、公网收敛、日志与最终数据库验证。
其中 deployment.json 含运行配置，禁止将其内容转发给客户端或打印。
脱敏验证副本位于本地 `artifacts/clinical-gateway-20261001/`；客户端公共接口只需上述契约文档，后台凭据和私有地址不进入客户端配置。
