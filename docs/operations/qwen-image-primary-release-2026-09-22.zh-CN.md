# Qwen-Image-2.1 生图首选切换回执

2026-09-22 01:39 UTC（北京时间 09:39）完成公网验收。用户要求将生图首选从 LLaDA 改为本地 Qwen-Image-2.1；用户另行明确批准在 star `/etc/hosts.allow` 仅增加 `sshd:192.168.77.1`。客户端通知按用户要求输出供转发，未直接发送，也未修改客户端仓库。

## 已部署状态

- Gateway 与 star Qwen 服务源码固定为已测试、已提交并推送到 main 的 `f8c1a943d31769125fb80574b22eab6f6c74b06f`。部署使用 Git archive，不使用带有其他工作中修改的开发目录。
- R760 `current` 指向该版本，`previous` 为 `a06d5221b1ced1c91d4a1b4fbd2f968ec6b3b131`；数据库仍为 schema 34。
- Gateway 镜像：`codex_gateway_r760-gateway:f8c1a943d31769125fb80574b22eab6f6c74b06f`。
- 客户端继续调用 `POST https://goldencode.instmarket.com.au:1443/gateway/images/generations`，模型名继续为 `medcode-image-default`，凭据不变。
- 默认链路：`qwen-image / qwen-image-2.1` → `llada-image-turbo-fp8` → 原有 GPT Image 2 等后备链。
- 配置选择 `MEDCODE_IMAGE_PRIMARY_PROVIDER=qwen`，Qwen 超时为 180 秒；其他业务配置未变。Qwen 原始输出 PNG，由 Gateway 现有编码层生成请求的 JPEG、PNG 或 WebP；`auto` 尺寸映射为 1024×1024。
- star Qwen 保留服务名 `qwen-image-21-eval.service`，以 GPU 1 BF16 CPU offload 运行，现已启用启动鉴权、开机启动和故障自动重启。LLaDA 与 IndexTTS 原进程未变。

## 私有连接与用户批准的白名单

star API 仅监听 `127.0.0.1:8191`。R760 `qwen-image-star-tunnel.service` 在私有 Docker bridge `172.18.0.1:18191` 接入，通过 SSH 加密转发到 star loopback。服务已启用开机启动。

专用 SSH 密钥固定 star host key；authorized_keys 使用 `restrict,port-forwarding,command="/usr/bin/false",permitopen="127.0.0.1:8191"`，禁止交互 shell，并只允许转发到指定 Qwen 端口。生成接口需要独立 Bearer key，未授权请求返回 401。密钥文件权限为 0600，不写入仓库或验收回执。

R760 的内网连接在 star 上显示为 NAT 来源 `192.168.77.1`。经用户明确批准后，仅向 `/etc/hosts.allow` 增加对应注释及 `sshd:192.168.77.1`，保留其他规则和现有密钥认证；未重启 SSH，未开放新的公网端口。

- allowlist 原件及候选件：`/data/apps/qwen-image-21-eval/state/ssh-allow-review-20260922/hosts.allow.original`、`hosts.allow.candidate`。
- 原件 SHA256：`d2b07ded5b67b2e600767d312ce77ef89095b059e9de8a9f44b697dd763fe6d2`。
- 应用后 SHA256：`dd016537e78d7b33bfdfe3cdba0603f479177337f4cf4902c0d1b2f96a2fdb3b`。
- star 私有连接备份：`/data/apps/qwen-image-21-eval/state/pre-primary-link-20260922T012301Z`。
- star API 升级备份：`/data/apps/qwen-image-21-eval/state/pre-primary-api-20260922T013017Z`；部署回执：`/data/apps/qwen-image-21-eval/state/primary-api-deployment.json`。

## 验收证据

| 验收项 | 结果 |
| --- | --- |
| 不可变 Linux 镜像构建及完整测试 | 83 个文件通过，1 个跳过；1,558 项通过，3 个既有外部 fixture 测试跳过 |
| 本地 typecheck / 定向 Gateway 测试 | 通过；3 个文件共 314 项通过 |
| star API 真实 FastAPI 鉴权、忙碌、温度及参数检查 | 3 项通过；不加载 GPU 的隔离测试 |
| Qwen 原生横图预检 | 1536×1024 PNG，HTTP 200，76.730 秒；已查看原图 |
| 公网默认生图 | HTTP 200，57.321 秒，真实 JPEG；已查看原图，中文标题及三个运动图标正常 |
| 实际上游 | `qwen-image / qwen-image-2.1`，按 Gateway 请求记录核验 |
| 普通文本控制请求 | HTTP 200 |
| Gateway 状态 | healthy；验收时重启计数 0 |
| 数据库 | schema 34，quick_check=ok，外键违规 0 |
| 其他运行服务 | R760 其他容器 ID 不变；star LLaDA 和 IndexTTS 进程不变 |
| 测试身份清理 | 临时 key 撤销、权益取消、Subject 禁用；旧 key 再请求返回 401 |
| 应用日志凭据扫描 | clean |

公网图片 request ID：`req-cbbcf0dd-b456-49a2-84f1-13c74c53031b`。普通文本 request ID：`req-8ec875e6-cdc2-45b7-b6f9-d0f8df573d22`。

公网图片 SHA256：`687d1f3b406c3b9083604ba5019881cb3b9f465a43300726094f05c87a2bcd23`。
横图预检 SHA256：`79e97118867638c1f173cf6b58f3b31d2b6e3c7882edd8e8d324c283c63e3a34`。
Gateway 源码归档 SHA256：`162d94820bcbfddc3142de90f5f89b54536b97b7a8d61063539634c7c21331ea`。
star Qwen 源码归档 SHA256：`3735300b366cd56dd5337d2ff6d0b625800c04d8e4668caf5804141dc9b78ffe`。

R760 受保护备份和回执目录：`/data/codex-gateway-r760/backups/pre-qwen-image-primary-20260922T013802Z`。其中 `activation.json`、`public-smoke.json`、`public-qwen-smoke.jpg` 为不含密钥的验收材料，已复制到本地 `C:\work\code\.task-artifacts\qwen-image-primary-20260922`；环境及数据库备份不外传。构建日志位于 `/data/codex-gateway-r760/qwen-image-build-f8c1a94.log`。

## 回退与后续验收

程序回退须成套恢复上述 R760 备份内的 `gateway.container.env`、`compose.r760.override.yml` 和 `rollback.json` 记录的 current/previous 指针，再用原有三个 Compose 文件仅重建 Gateway。保持 Nginx imaging include 指向 a06d522 的现有路径。本次无数据库迁移，程序回退不恢复数据库，以免覆盖新请求和用量。star 旧 Qwen 版本 `a4e3a94cff69907ac92975fe499919a6a1ee3851` 及服务备份保留。

客户端安装版端到端验收尚待 MedEvidence 团队执行。已核对客户端源码继续使用 `medcode-image-default`、210 秒生图超时和 60 秒进度提示。上述 57–77 秒为已测样本耗时，不是时延保证。本次接入范围为现有文生图接口，不表示新增公网图像编辑接口。后备链顺序与错误分类通过自动测试，未人为中断生产 Qwen 以触发实际后备请求。

模型许可沿用此前研究部署评估记录中的 Qwen Research License，本次内部实测接入不构成额外商业许可结论。转发正文见 [MedEvidence 客户端实测通知](../outbox/medevidence-qwen-image-21-primary-test-notice-2026-09-22.zh-CN.md)。
