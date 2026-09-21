# MedEvidence Imaging Gateway 开发、部署与真实 CT 联调回执

日期：2026-09-21。Gateway 已开发并部署，完整公开 CT 经正式 Gateway 的新推理，以及客户端源码普通聊天→影像工具→报告→浏览器复核均通过。原临时测试 Subject 已撤销；随后按用户明确授权应用 Nginx 配置，并为手机号 186****0006 对应账号和王文晟两个现有 Subject 开放试点。新版 Desktop EXE 安装包不属于本回执的通过范围。

## 生产版本与策略

- 运行提交：`a06d5221b1ced1c91d4a1b4fbd2f968ec6b3b131`，已提交并推送至 origin/main。
- 镜像：`sha256:1488bb3ded67e76fd356c489bd6a6c1a4c7554d419a7001ed1a873e7a951135b`。
- 部署时间：2026-09-21T05:59:01.308087+00:00；previous 为 `ca07c41b4f7adaf9c938cc301212d969e9ba1d32`，身份库 schema 仍为 34。
- 公网：`https://goldencode.instmarket.com.au:1443/gateway/imaging/v1`。
- 代码默认 off；当前模式 pilot，白名单仅 `subj_yBZBxNUHIVszGz4BKXaltrw5` 和 `subj__3nJpw9INwhmK4k8Qq4K4jlI`，其他 Subject 不可用。测试限额按 Subject 独立计算：每 UTC 日 10 个任务、同时 1 个未完成任务，不新增收费规则。
- `gpu_seconds` 可空，保持 NULL；未用请求/任务墙钟时间估算 GPU 用时。
- 只切换 Gateway，其他五个容器保持原 ID；未修改 star 服务、模型、驱动或其他应用。
- 保留原有 25 个 tracked 文件的未提交修改及既有 untracked 文件；只在原 main 工作区开发，没有新分支/worktree/开发副本。

当前状态见 [王文晟开通及两账号复验](../../artifacts/imaging-gateway-20260921/pilot-wang-activation.json)，核验时间为 2026-09-21 07:04 UTC。[首次真实账号开通](../../artifacts/imaging-gateway-20260921/real-pilot-activation.json) 对应 06:43 UTC 的单账号白名单。此前临时联调关闭、撤销、健康与数据库检查见 [联调结束审计](../../artifacts/imaging-gateway-20260921/joint-final-audit.json)，对应 06:23 UTC 的关闭状态。[关闭后鉴权检查](../../artifacts/imaging-gateway-20260921/default-off-after-joint.json) 记录撤销测试 Key 前，两名已登录 Subject 均得到 available:false。[首轮发布审计](../../artifacts/imaging-gateway-20260921/final-audit.json) 保留较早的 ca07c41 默认关闭发布证据，不代表最终时点。

## 实现与契约

复用既有凭据/统一 Key 的真实 Subject，逐项校验 study/job/结果归属，不以 session 授权，也不相信客户端 owner/service headers。会话关联和幂等键哈希后持久化；控制库不保存 CT 字节、base64 或文件名。

全部 v1 路由、独立 SQLite 控制与审计、提交前持久意图、请求指纹冲突、稳定幂等重放、恢复对账、取消、先撤权后异步删除、manifest 允许列表已实现。8 MiB 分块、512 MiB 上限、300 秒传输时限、背压、长度/哈希验证及独立并发限制均已接入。访问期 24 小时，控制/审计保留 30 天。

私有 HTTPS 验证证书及 IP；Gateway 构造专用服务凭据，不转发用户 Key。关闭/未准入时明确 unavailable，没有模型回退。配置见 [运维说明](../operations/imaging-v1.md)。

客户端团队已确认并同步 v1 几何澄清：eligible:false 可同时省略尺寸和间距，保留拒绝原因、不补数值；eligible:true 必须有完整有效几何；部分提供或非法值均为协议错误。Gateway 已对齐，时间字段采用 star 的 Unix 秒值。

## 验证与真实 ID

| 层次 | 结果及边界 |
| --- | --- |
| 不可变 Linux 镜像 | 1553 项通过、3 项既有 fixture 测试跳过；82 个文件通过、1 跳过。1592 个 tracked 文件逐项匹配目标 Git blob，不含脏开发树。 |
| 影像专项 | 18 项通过，类型检查通过；覆盖归属、伪造 header、哈希/长度、幂等、限额、取消/删除/到期、恢复、TLS 与审计实际落库。 |
| 数据库/普通接口 | 身份库无 schema 变更；此前候选生产备份独立副本的 26 张表打开两次内容不变；编译后 Chat/Responses、Free/paid smoke 通过。 |
| 私网与权限 | 错误服务凭据拒绝，正确凭据 capabilities 成功，证书/IP 正常校验；秘密文件按 UID/GID 999 逐文件只读挂载。 |
| 最终版本完整公开 CT | 98,330,067 字节、512×512×368，经正式公网 Gateway 鉴权上传、新 GPU 推理完成、15 个资产长度/SHA-256 校验通过。调用方在 star，使用其官方公开样例，经 Gateway 转回 star；不是 Windows 完整大文件网络性能测试。 |
| 生命周期与隔离 | 实际中断分块后续传、块重放、409 冲突、跨 Subject study/job/结果/取消/删除 404、未列出资产拒绝、同时 1 个任务限制 429、显式取消与删除撤权通过。24 小时到期用自动化时钟测试，没有宣称实等 24 小时。 |
| 源码普通聊天 | Windows 实际 imagingClient/imaging 工具，经正式 Gateway，公开 CT 工程降采样副本 1,694,543 字节、128×128×92；新 GPU job、15 个核验下载、自动 skill、HTML 渲染/verify 完成。使用隔离源码运行时和受控测试登录后的运行凭据，不是新版已安装 EXE。 |
| HTML 浏览器 | 146 项评分、12 张真实预览；切片键盘切换、缩放、复核同步、草稿恢复、筛选、JSON/CSV/HTML 导出与独立上下文恢复通过；390 px 无横向溢出，无脚本错误/外部请求。截图已人工查看。 |

修复版完整 CT：

- study：`study_18b674218c6b474bb20b3eb3e02d69de`
- job：`job_eae9682611d740efbfc1caa1eff12608`
- 输入 SHA-256：`8e0e52551b675cb64907bb74506cd9393f195454a6ee7ebf56163e2c136fbabf`
- request ID、manifest 和检查项见 [完整 CT 证据](../../artifacts/imaging-gateway-20260921/public-ct-acceptance-a06.json)。

源码客户端普通聊天：

- session：`ses_f3d72b292ffeTcWmLaJ9I2Cfzf`
- study：`study_4ffc905f0d9849649d1ae73458a45d69`
- job：`job_4094bfd47b544a1a810027bd75a4d9f4`
- 总流程 234 秒是工程链路墙钟时间，**不是 GPU 用时**。
- [agent 记录](../../artifacts/imaging-gateway-20260921/client-agent-acceptance.json)、[HTML](../../artifacts/imaging-gateway-20260921/ct-report.html)、[渲染回执](../../artifacts/imaging-gateway-20260921/ct-report.receipt.json)、[浏览器检查](../../artifacts/imaging-gateway-20260921/browser-verification.json)、[桌面截图](../../artifacts/imaging-gateway-20260921/report-preview.png)、[窄屏截图](../../artifacts/imaging-gateway-20260921/report-narrow.png)。

首轮实际重启恢复：[原始检查](../../artifacts/imaging-gateway-20260921/public-ct-acceptance.json)，job `job_c70a40f8efde44508dd8a2aa85324353`；重启后同一幂等键仍返回该 job，request ID `req-f632decf-6112-446f-98df-58e03f20414f`。该轮对应 ca07c41；修复版另验证持久意图和响应丢失后的同键重放，不声称又做了一次运行中重启。

## 联调发现与修复

首轮发现审计 INSERT 占位符多一个，导致审计未落库。a06d522 修正并新增 HTTP 成功/拒绝操作的持久落库断言，重新全量构建、部署并重跑完整 CT。首轮缺失审计没有事后伪造补写；修复版 200/201/202/404/409/429 审计已独立验证。

测试脚本先后使用了不匹配的通用 gzip 消息附件、CLI 登录初始化和版本头；失败记录保留在隔离试验目录。最终按正式附件的本地文件引用格式，使用经统一 Key 解析验证的运行凭据执行。未关闭生产鉴权/版本检查，也未为测试修改客户端源码。

Windows 脏工作区全量运行曾有 1607 通过、7 失败（计时/性能及 Research 相关），未记作通过。发布门槛采用干净提交的 Linux 构建。本轮建立工程执行与数据一致性，不代表临床准确性、真实医院 DICOM 全兼容或高并发验证。

## 受控文件与清理

交付目录 `/opt/codex-gateway-r760/handoffs/imaging/20260921/` 含 acceptance.md、HANDOFF.md、r760-star-acceptance.json 及更新的 medevidence-imaging-api-v1.md。

证书与专用凭据在 `/opt/codex-gateway-r760/secrets/imaging-star-20260921/` 的 star-ca.pem、star-service.token：文件 root:999 / 0440，父目录 root:root / 0700，仅逐文件只读挂载。证书 DER SHA-256：`4e5c7d1916f850b7c449fca4bfe9867b0c056fcadf46d4e2b0dc4fe3a96c9482`。凭据内容未进入回复或仓库。

发布备份：`/opt/codex-gateway-r760/backups/phone-signup-a06d5221b1ce`。联调备份与恢复配置：`/opt/codex-gateway-r760/backups/imaging-joint-20260921`。恢复只换程序/配置，不用旧数据库覆盖新业务数据。

临时 Subject：`subj_K2e2zGnnhts0fMVOW6VMfJH3`、`subj_NYwjdpSFSlQiz3uDk0CX5A3r`。测试资源通过正式删除接口撤权；账号经有备份的控制 wrapper 禁用，底层凭据和统一 Key 均撤销，测试 entitlement 均取消。旧凭据实际请求返回 401，活动凭据、测试额度及未结算预约均为 0；临时凭据文件已删除。最终独立审计 88 条，待处理动作和未撤权资源均为 0。控制墓碑/审计按保留期保留，公开样例与验收结果保留作证据。

## Nginx 应用与指定账号开通

用户明确授权后，06:36 UTC 应用 [Nginx 配置片段](../../config/nginx/imaging-location.conf)，include 固定到 a06d522 不可变发布目录。原配置与完整 Nginx 目录已备份至 `/opt/codex-gateway-r760/backups/imaging-nginx-20260921T063655Z`。候选及安装后语法检查通过，平滑重载保留 master，确认新 worker 生效。公网健康 200，未鉴权影像请求 401，超过 8 MiB 的请求头由边缘直接返回 413；对普通日志的正向控制可见，而影像路径/查询测试标记在 10 个普通日志中均不可见。详见 [Nginx 验收](../../artifacts/imaging-gateway-20260921/nginx-acceptance.json)。

用户随后指定手机号 186****0006，唯一匹配到 `subj_yBZBxNUHIVszGz4BKXaltrw5`。06:43 UTC 只为该 Subject 启用 pilot，保持每日 10、同时 1 的限额。等待既有请求完成后仅重建 Gateway，继续运行同一 a06d522 镜像；其他五个容器未变，Nginx 配置保留。开通备份 `/opt/codex-gateway-r760/backups/imaging-real-pilot-20260921T064300Z` 包含关闭配置和四个已校验数据库备份。回退开通配置时使用其中 `off.override.yml`，不恢复旧业务数据库，也不移除 Nginx 的日志隔离。

首次开通时，现有统一 Key 解析、账号凭据及普通模型列表均为 200；影像 capabilities 由开通前 available:false 变为 available:true，request ID 为 `req-3d6d0472-bcd5-47e3-8697-a6ba465534db`。证书和专用凭据按文件只读挂载，容器 UID 999 可读不可写；四库完整性及外键检查通过。未新建 Key、entitlement 或推理任务，未占用该账号的影像任务额度；GPU 用时仍为空。

07:04 UTC 按用户追加授权，为唯一匹配的王文晟（`subj__3nJpw9INwhmK4k8Qq4K4jlI`）追加权限。仅变更 `GATEWAY_IMAGING_SUBJECT_IDS`，保留原 Subject 与每用户 10/1 限额；确认普通预约和活动影像任务均为 0 后，只重建同一版本的 Gateway。备份为 `/opt/codex-gateway-r760/backups/imaging-pilot-add-wang-20260921T070402Z`，其中 `previous.override.yml` 可回退到此前单账号名单。两名用户均用现有凭据实测 available:true，王文晟 request ID 为 `req-ba1d55ca-9ea3-49b8-a4d1-be7829074c34`；普通模型列表也正常。四库检查通过，五个其他容器、Nginx 与挂载不变，未新建 Key、entitlement 或任务。

## 尚待事项

1. 新 Desktop EXE 构建/发布与安装包 UI 全流程由客户端团队继续验收；本回执不宣称安装包发布完成。
2. star 可后续补充实际 GPU 时长契约；当前按用户确认保留空值，不估算。
