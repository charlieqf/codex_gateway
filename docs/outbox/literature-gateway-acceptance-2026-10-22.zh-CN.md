# 文献提取正式接入回执

Gateway revision：`a259d29d378a6748d2227ce8a0cb8680a5373c87`。
部署时间：2026-10-22 01:56:53 UTC；最终核验：01:59:47 UTC。
公开接口已可用：`https://goldencode.instmarket.com.au:1443/gateway/documents/v1`。

正常 credential / Desktop unified key 均可使用；当前与之后注册的账号不需要白名单、
客户端环境变量、SSH 隧道或内部服务令牌。现有 GLM 模型调用、额度和计费合同保留。

## 公网验收

验收通过正常 Billing 新注册两个临时账号取得 unified key，全程使用正式 HTTPS 地址。

| 检查 | 结果 |
| --- | --- |
| 真实 Buccella PDF 上传、异步状态与目录 | 202 → running → completed；9.685 秒，3 个原始素材 |
| PDF 指纹 | `5dd3f59b20f9ea45548a0854ca266d4af332c9adb32f2bc4f8d16d5e7ccb5794` |
| 原图下载 | 3 个 PNG 均与目录 SHA-256 一致 |
| refine | 返回 1 个候选，table grid 为 located；候选 PNG 哈希一致 |
| select | 正文第 1 行、第 1/2 列成功；选取图片哈希一致 |
| select 图片指纹 | `b9e4fd66958afb0e135d6ee20150f5d2da91ef85c79416e2e0d9bafc43fcdacd` |
| 重复上传 | cache_hit=true，任务 ID 不变 |
| 未登录 | 401 |
| 伪造 owner / 内部 token | 无效；正常上传仍绑定认证 subject |
| 跨账号状态、目录、原图、refine、select、delete | 全部 404 |
| 50 MiB 上传边界 | 正好 50 MiB 到达 Gateway；故意错误的哈希返回明确 400；超过 50 MiB 返回 JSON 413 request_size_limit |
| 控制 JSON 超过 8 KiB | 413 |
| 文献请求的模型 token reservation 增量 | 0 |
| 既有 `/v1/models` | 200 |
| 真实 `goldencode` / low 模型请求 | 200；1 个 choice，132 input + 3 output = 135 token |

并发/队列满等容量校验在隔离自动化中覆盖，未向生产填满队列。
Gateway 全局并发 8、每账号 2，限制发生在读取上传正文之前；worker 串行提取、pending 8、
每 owner 最多 32 份、200 页上限、24 小时缓存及定时清理。

## 运行与发布验证

- 私有 worker：`172.18.0.1:8101`，非 root，4 CPU/8 GiB，无新增公开端口。
  worker revision `772bafd882883270ed8a9b6415a8a9b136077e1a`；引擎指纹
  `305c296223106db764978454e94c14d5c2b2117ae42291e2d271324600a6931d`。
- 内部令牌通过只读受保护文件挂载，未向客户端下发。Gateway 从现有 subject 派生 owner。
- 新增文献专用 HTTPS location，50 MiB/90 秒，关闭相关内容日志、缓存和压缩。
- 从已提交 main 的不可变归档构建；Linux **1935 passed / 4 skipped**，构建成功。
- 已验证发布前备份；自然空闲连续 30.31 秒后 drain/recreate，记录维护窗口，未声称零停机。
- 公网 health 在固定截止内连续两次 200/ready；线上镜像 revision 匹配、零重启。
- 9 个现用数据库 integrity/FK 全部通过；8 份原受保护输入、其他服务容器和端口保留。
- 两个临时账号已禁用、凭据已撤销、未结算预留为零；文献任务、空 owner 目录和 3 个容器烟测文件已清理。

详细运行步骤见 [文献接入运维文档](../operations/document-evidence-gateway-v1.zh-CN.md)。
完整验收证据保存在 R760 `staging/a259d29d378a6748d2227ce8a0cb8680a5373c87/` 的
`public-smoke-report.json`、`final-verification.json`；备份记录位于对应 `backups/release-a259d29d378a/`。

Gateway 正式链路验收已完成。客户端可按交接约定执行安装 EXE、正常登录、两个独立空会话的
GLM-5.3/low 验收，继续核对父子会话 token、指定 PPT 页数、正文图片和 PowerPoint 渲染。
本回执不代替客户端 UI/PPT 端到端验收。
