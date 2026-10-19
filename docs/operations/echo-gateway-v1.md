# EchoNet / EchoNext Gateway 接入

2026-10-19。复用 clinical 持久任务协议；仅供学习测试，保留上游研究属性及模型来源。

| 模式 | 公网前缀 | profile | 上游 |
| --- | --- | --- | --- |
| EchoNet-Dynamic | `/gateway/echonet/v1` | `echonet-a4c-research-v1` | `https://192.168.77.7:7446/internal/echonet/v1` |
| EchoNext-Mini | `/gateway/echonext/v1` | `echonext-mini-ecg-research-v1` | `https://192.168.77.7:7447/internal/echonext/v1` |

沿用 [clinical API](./clinical-models-v1.md) 的 capabilities、jobs、input、complete、result、artifacts、cancel、delete、source 接口及用户鉴权。
创建成功 201，相同幂等请求 200，异请求同键 409。上传使用 `X-Chunk-SHA256`；续传返回 `job_id,chunk_bytes,state,parts`，每块固定 8 MiB（末块除外）。

EchoNet 输入是在 PanEcho 视频输入上增加 `view:a4c`、`view_confirmation:human`、`cine_count:1`；仍支持 video/video_zip/dicom_zip，最大 512 MiB，要求人工确认 ROI。
EchoNext 输入字段为 `format:ge_muse_xml`、size、sha256、`acquisition:resting_12_lead_ecg`、`recording_count:1`、`quality_confirmation:human_reviewed_nonpaced`；最大 16 MiB。
两种请求均要求 session_id、正确 analysis_profile、data_policy:public_or_deidentified，拒绝未知字段。

EchoNet 产物必须完整包含 result.json、report.csv、preview.png、overlay.mp4、contours.json；EchoNext 为前三项。每文件不超过 32 MiB。
下载校验大小和 SHA256，禁止重定向或内容编码，响应 `Cache-Control: no-store, no-transform`。
结果校验输入散列、job/profile、研究属性、模型来源；EchoNet 校验有限 EF 0–100、63–512 帧及分割帧数；EchoNext 校验固定顺序的 12 个独立分数（各 0–1，不要求总和为 1），thresholds 必须为 null。

## 访问策略与配置

用户明确要求向所有现有和未来注册账号开放，两种新服务使用 `GATEWAY_ECHONET_MODE=authenticated` / `GATEWAY_ECHONEXT_MODE=authenticated`。
该模式依赖现有 Gateway 用户凭证鉴权，新账号自动获得访问权限；未登录、停用账号或失效凭证仍被拒绝。任务始终按实际 Subject 隔离，客户端不能指定 owner。
不改变既有 AIPAL / PanEcho 的 pilot 白名单。所有模式也保留 off 和 pilot 配置；空 pilot 白名单仍拒绝访问，禁止使用 `*`。

每个新服务默认每用户每 UTC 日 10 个新任务、1 个活动任务；不扣聊天 token。输入和访问保留 24 小时，执行失败不自动重新推理。
环境变量沿用 clinical 后缀：SQLITE_PATH、STAR_URL、STAR_CA_FILE、STAR_TOKEN_FILE、DAILY_JOBS、ACTIVE_JOBS、CONTROL_TIMEOUT_MS、TRANSFER_TIMEOUT_MS。
两套独立数据库使用 `/var/lib/codex-gateway/clinical/{echonet,echonext}.db`，启动检查所有 clinical/identity/client-events/imaging 库不能共用路径或 inode。
证书和令牌分别从 star 私有配置安全复制，只读挂载；不复制 TLS 私钥。配置及部署脚本不包含密钥值。

发布按 `echo-gateway-cutover.py`：已提交主线制品、备份、Compose 校验、等待自然空闲 30 秒、drain、仅替换 Gateway、受限更新既有 Nginx clinical include、两次公网健康检查及数据库完整性检查；失败恢复原配置和镜像。
该文档是接口与部署约束，实际部署及公网实推理结果另记验收回执。
