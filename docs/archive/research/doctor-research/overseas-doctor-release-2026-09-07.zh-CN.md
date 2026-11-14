# Doctor Search 海外医生检索修复上线记录（2026-09-07）

修复版本：`ebad087785d4158767bca99c8f841e33df4eca97`。实现与限制见 [修复说明](overseas-doctor-repair-2026-09-07.zh-CN.md)。

## 发布与回归

- 从已推送的提交生成归档并构建镜像，同步更新 R760 Gateway 和 Research Worker。
- Skill `1.6.119`、Workflow `v88`、Validation `v48`、Prompt `v33`。
- 发布前无排队、执行或等待人工确认的旧版本任务。暂停 Gateway 接入并再次确认任务排空后，先更新 Worker，再启动 Gateway。
- 已验证 Gateway、Client Events、Research 三个 SQLite 在线备份；配置备份内容校验一致。备份目录：`/opt/codex-gateway-r760/backups/doctor-overseas-ebad087`。
- 两个目标容器健康、重启次数为 0、镜像 revision 一致。公网 TLS 健康检查返回 `ready`，Worker 心跳为 `ready`；数据库 `quick_check=ok`，外键违规为 0。
- Research LLM Gateway、Research Maintenance、Mihomo、Qwen 容器保持原实例；目标容器环境变量与发布前一致。
- `current` 为本次修复提交；`previous` 为 `840f287b14a9fa7da546dc1213e19e05574bee69`。回滚 Worker 时须使用发布元数据中的旧 Worker 镜像及 Compose 工作目录，并先排空新版本任务，不能只切换 `current`。

提交后 `npm run typecheck` 通过，Research Agent、Worker、Gateway Research 路由与 Store 共 **278 项测试通过，0 失败**。

补做的中国医生真实联网回归在 R760 一次性容器中执行修改后的身份发现和核验代码，不写生产数据库：

| 医生 | 医院 / 科室 | 身份核验 | 匹配来源数 |
| --- | --- | --- | --- |
| 赵玉沛 | 北京协和医院 / 基本外科 | 通过 | 1 |
| 张文宏 | 复旦大学附属华山医院 / 感染科 | 通过 | 2 |
| 乔杰 | 北京大学第三医院 / 妇产科 | 通过 | 3 |

记录：`artifacts/doctor-overseas-2026-09-07/chinese-live-probe.json`、`release-tests.json`。

## 公网验收

使用临时 Research 权益和凭证，经 `https://goldencode.instmarket.com.au:1443` 创建任务、轮询终态、读取结果并下载报告。三位海外医生均使用截图中的原始中文医院、科室，没有手工传入官网链接或外文论文身份。

| 医生 | Run ID | 终态 | 下载校验 |
| --- | --- | --- | --- |
| Felix Mottaghy | `drr_0de90492a7d846babe0814c44b3e2690` | succeeded | 4/4 |
| Markus Schwaiger | `drr_231eb7bb51e0414794ef83099a29f9da` | succeeded | 4/4 |
| Paola Anna Erba | `drr_6f6d73a9708849448a68dad6b9f31bf6` | succeeded | 4/4 |
| 赵玉沛 | `drr_b283ede258804c809943245c73467425` | succeeded | 4/4 |

共 16 份报告通过 manifest、类型、响应头、文件大小与 SHA-256 校验，提问文件通过五行格式检查。公网客户端运行记录：`artifacts/doctor-overseas-2026-09-07/public-release-smoke.json`。测试脚本首次把 `publication_years` 放在请求顶层，4 次 HTTP 400 均未创建任务；修正为 `options.publication_years` 并调用客户端参数校验后，以上四个正式任务全部成功。

四例质量状态均为 `passed_with_warnings`，完整流程成功不代表来源完整、全文覆盖或所有内容都完成严格证据闭合。三位海外医生都带有 `doctor_publication_evidence_not_found`；Felix、Markus 另有 `doctor_research_direction_evidence_not_found`。系统明确说明未确认个人研究方向，领域综述不代表该医生本人的成果或观点。赵玉沛没有上述本人论文/研究方向缺失提示，但仍有摘要来源、引用目标数量不足及 brief 模式校验放宽提示。

复核 Paola 简介：保留了 Pisa 经历的过去时、2016–2022 任职时间及 Bergamo/Bicocca 任职来源。基础档案中的“医院”仍展示用户查询输入“比萨大学医院”，不能据此认定为现职。试用时需结合任职来源和时间核对。

本次为服务端发布，客户端可按原请求格式试用，无需新增字段。

## 收尾

临时测试凭证已撤销，Research 权益已取消，测试用户已禁用，未完成的测试 token reservation 为 0。每次控制操作均使用 R760 guarded wrapper，完成备份及数据库完整性检查。明文凭证、下载目录、16 个服务器测试产物以及本地/远程临时执行脚本、归档包均已移除；测试任务及审计元数据按既有保留策略留存，不删除业务审计。

公网验收后两目标容器仍为 healthy、重启次数 0，Worker 心跳 ready，公网健康检查 HTTP 200 / ready。发布后 Gateway、Worker 结构化日志未出现 warning/error 级别事件。上线状态已同步到运维状态文档。
