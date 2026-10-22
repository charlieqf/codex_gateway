# 文献提取 Gateway 接入与发布

2026-10-22。此文档描述候选实现及已核验的私网依赖，不是公网发布回执。
客户端需求来源：`C:\work\code\medevidence-opencode-stable\docs\literature-gateway-handoff-20261022.zh-CN.md`。

## 接入契约

公网前缀为 `/gateway/documents/v1`。复用现有 credential / Desktop unified key 鉴权；
配置好私有 worker 后，所有 active subject 均可访问，包括之后注册的账号。
旧草稿的 `CODEX_DOCUMENT_EVIDENCE_SUBJECTS`、`CODEX_DOCUMENT_EVIDENCE_ALL_AUTHENTICATED`
不再参与授权。文献路由不创建 LLM token reservation、不计入模型请求额度、不需要 turn headers。
模型 GLM-5.3 调用、Plan、token 结算与 provider 路由保持原契约。

| 方法及相对路径 | 契约 |
| --- | --- |
| `POST /documents` | `application/pdf` 原始字节和小写 `X-Content-SHA256`；50 MiB，Gateway 校验 PDF 签名及哈希 |
| `GET /documents/{id}` | 任务状态；64 位小写十六进制 ID |
| `GET /documents/{id}/catalog` | 来源与素材目录 |
| `GET /documents/{id}/assets/{asset_id}.png` | 24 位小写十六进制素材 ID；PNG 字节保真 |
| `POST /documents/{id}/refine` | JSON `asset_id` |
| `POST /documents/{id}/select` | JSON `asset_id`, `rows`, `columns`；非空正整数数组，1-based |
| `DELETE /documents/{id}` | worker 清理当前 owner 下的非运行任务 |

owner 延续草稿算法 `SHA256("medevidence-documents-v1:subject:" + subject.id)`，
同账号换 Key 后不变。Gateway 丢弃所有 `X-Document-*`、`X-Service-*` 客户端头，
不透传用户 Authorization；控制 JSON 仅传契约字段。worker 按 owner 隔离存储，
跨账号操作返回 404，避免泄露其他账号是否存在该文件。

控制请求上限 8 KiB，JSON 响应 8 MiB，PNG 响应 20 MiB；声明长度和实际响应流均检查。
Gateway 在读取上传正文前执行全局 8、每 subject 2 个并发请求限制。
成功、解析失败、断连、worker 超时后释放名额；断连会取消上游 HTTP 请求。
85 秒总请求上限短于客户端 90 秒预算，允许以 `CODEX_DOCUMENT_EVIDENCE_TIMEOUT_MS`
调低但不允许超过 85 秒。提取异步执行，轮询请求不占用整个提取过程的 HTTP 名额。

worker 自身负责 200 页上限、串行提取、最多 8 个 pending 任务、每 owner 32 份文档、
24 小时有效期和每 300 秒清理。取消 HTTP 不等于取消已提交的异步提取；客户端重传同源
PDF 可命中原任务。不存在/过期按 worker 当前契约统一返回 404 `not_found`。

错误保留 400/404/409/413/429；队列满为 429 `queue_full`，Gateway 并发满为 429
`document_request_limit`，附 `Retry-After: 2`。配置不可用/传输失败返回 503；
内部鉴权失败、非契约响应、过大的上游响应返回 502。内部 5xx 详细消息不透传。
worker 当前每 owner 容量满仍返回 400 `owner_document_limit`，Gateway 保留该契约。
文献成功路径关闭请求日志，未匹配路径及鉴权失败日志只记录归一化路径，不记录原文、
文件名、查询参数、敏感请求头或内部异常。

## 私网依赖核验

2026-10-22 只读核验：

- Gateway 线上 revision `8d55a638ec30753094802a063c771b28ee358f17`，healthy、零重启。
  当前 main `f8b817b` 仅增加该发布回执；已 fetch，main 与 origin/main 一致，线上 revision
  是 main 祖先。发布前必须再次核验，不能将此快照当作实时证明。
- worker current 指向 `/data/medevidence-document-evidence/releases/772bafd882883270ed8a9b6415a8a9b136077e1a`。
  systemd 为 active/running，账号 `medevidence-documents`，CPUQuota 400%，MemoryMax 8 GiB。
- 只监听 `172.18.0.1:8101`，已从正在运行的 Gateway 容器读取 `/health`，HTTP 200。
  引擎指纹 `305c296223106db764978454e94c14d5c2b2117ae42291e2d271324600a6931d`。
- worker 令牌 `/etc/medevidence-document-evidence/service.token` 为 root:993、0440；
  Gateway 副本 `/opt/codex-gateway-r760/secrets/documents/service.token` 为 root:999、0440。
  未读取或输出令牌值；候选配置通过只读目录挂载读取文件。
- worker 的 110 个 Python 包与 `requirements.lock.txt` 完全一致。`server.py`、`engine.py`
  和 lock 文件规范化 CRLF 后均与客户端当前工作区一致。
- `/opt/medevidence-document-evidence/install-receipt.json` 尚不存在。私网健康不等于正式
  端到端验收，发布时仍需记录 worker 版本、离线引擎指纹与实际 PDF 测试。
- Nginx 的现有公共入口全局上限为 20 MiB；必须加载独立文献 location 才支持 50 MiB。

## 配置和发布步骤

示例文件：`config/compose.r760.documents.override.example.yml`、
`config/nginx/documents-location.conf`。两者已在 R760 临时目录执行独立
`docker compose config --quiet` 和 `nginx -t`，均通过；未更改运行配置或 reload。
URL 仅接受指定 RFC1918/IPv4 loopback 地址，不接受公网地址、域名、用户信息或查询参数。
无配置或配置错误仅关闭文献服务，其他 Gateway 功能继续运行。

`CODEX_DOCUMENT_EVIDENCE_TOKEN_FILE` 优先于兼容的服务器端 TOKEN 环境变量；
指定文件不可读时不回退，Linux 拒绝 other 可读文件。正式发布使用 TOKEN_FILE。
不得把令牌放入 Git、安装包、命令行输出或客户端环境变量。

本地验证：`npm run build` 通过；完整 Vitest 首轮为 1935 passed / 1 failed / 4 skipped，
唯一失败是新增测试用 `upsertSubject` 尝试禁用账号，而此 API 保留原状态。
改为正式的 `setSubjectState` 后，15 项文献专项全部通过；另有 332 项模型/鉴权/限流/
生命周期回归通过。`documents-gateway-cutover.test.py` 的 3 项配置边界测试通过。
正式发布仍须对已提交的不可变归档执行 Linux 构建和完整测试。

按 `container-deploy.md` 发布，发布审批的具体范围为：推送已测试的 main revision、
在 R760 用不可变归档构建、备份并合并现有 Gateway override 的两个环境变量及只读 mount、
等待自然空闲后 drain/recreate Gateway、在现有 TLS server 增加文献 location include 并 reload Nginx。
不需要新公开端口，不变更 worker 服务、模型 provider 或数据库 schema。

1. 重新 fetch 并确认 local main、origin/main、线上 revision；检查共享工作区和并发发布锁。
   只提交本功能文件，保留其他会话的修改，归档必须来自已提交 main。
2. 使用现有 prepare/backup 流程创建不可变 release，记录旧容器 image、current/previous、
   Compose 标签和其他容器 ID。备份受影响的 override、Nginx 配置及相关 SQLite，验证权限与可恢复性。
3. 使用专用 `scripts/ops/documents-gateway-cutover.py <revision>` 合并配置。
   它只允许本文的两个环境变量和一个只读 mount，保留现有 image/env/mount/network
   的其他设置。通用历史 cutover 不适用于本次配置变更。
4. 构建提交 revision；使用实际 overlay 执行 `config --quiet`。确认容器 uid/gid 999 可读
   token 文件，私网健康正常，令牌副本一致（只报告布尔结果）。
5. 先等待 30 秒连续自然空闲，再关闭新请求、排空活跃工作，替换 Gateway。Nginx include
   使用此次不可变 release 路径，执行 `nginx -t` 后 reload。记录维护开始/结束。
6. 60 秒单调时钟截止内轮询公网 health，每次超时最多 5 秒、间隔 1 秒，要求连续两次
   200/ready 且非 draining；另核验容器 revision/零重启，不以单次即时探测决定回滚。
7. 走正常公网 HTTPS，用正常权限的两个临时账号完成真实 PDF 上传、completed、catalog、
   原图及 refine 下载和 SHA-256 校验；验证原有模型接口、未登录/过期凭据拒绝、伪造 owner
   无效、跨账号 status/catalog/assets/refine/select/delete 拒绝、50 MiB/8 KiB 超限响应。
   上限与队列满的破坏性负载测试放在隔离测试环境，不向生产灌满任务队列。
8. 清理临时账号凭据和文献任务，验证数据库 integrity/FK、其他容器和端口未变。
   失败时恢复配置/原镜像/current，按同样的公网收敛检查确认回滚。

只有这些公网验证完成后，才向客户端回传正式部署 revision、UTC 时间、文件/图片哈希、
隔离与容量结果及模型回归结果；客户端随后执行安装 EXE 的两个独立会话验收。
