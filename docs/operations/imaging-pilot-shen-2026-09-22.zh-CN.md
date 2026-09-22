# CT 读片试点：沈杰开通回执

2026-09-22 06:25 UTC（北京时间 14:25）按用户明确要求完成开通。姓名沈杰、手机号 177****9293 唯一匹配到活动 Subject `medevidence-76650ea38feb47f4b259e1b065151696`，对应 Phone identity 正常。

## 变更

- 仅向 `GATEWAY_IMAGING_SUBJECT_IDS` 追加沈杰，保留 `subj_yBZBxNUHIVszGz4BKXaltrw5` 和 `subj__3nJpw9INwhmK4k8Qq4K4jlI`，共三名试点用户。
- 维持 pilot 模式，每 Subject 每 UTC 日 10 个任务、同时 1 个未完成任务。未列入名单的账号仍不可用。
- 已 fetch；本地 main 与 origin/main 同为 `c581f2d9f419ad50144dda3c1f02316c11596cec`，生产提交为其祖先。本次保留生产 `f8c1a943d31769125fb80574b22eab6f6c74b06f` 和镜像 `sha256:e26de5b180c24b8a7a78e231852adcd19202c952fea2f7275e3da1ee98957005`，未部署开发树。
- 持有生产部署锁，确认普通 token 预约和活动影像任务均为零后，仅按线上原 Compose 文件重建 Gateway。运行环境逐项比较，只有上述名单字段变化；current/previous、其他五个容器、挂载、端口和 Nginx 配置均未改变。

## 验证

三名用户均通过现有统一 Key 解析、`/gateway/credentials/current` 与 `/v1/models` 检查，全部 HTTP 200。沈杰的 `/gateway/imaging/v1/capabilities` 从 `available:false` 变为 `available:true`，原两人保持可用。沈杰开通后的能力检查 request ID：`req-129420a8-6ac5-40a8-ba61-d6e940b4b3e4`。

公网健康 ready，Gateway healthy、重启计数 0；Gateway、client-events、imaging-control、research 四库 `quick_check=ok`、外键违规 0。专用服务凭据和证书在运行 UID 下可读不可写。日志检查见普通业务的 tool-loop shadow 与客户端遥测速率警告，未发现 JSON error 级别记录。

本次未新建 Key、entitlement 或 CT 推理任务，未消耗用户的影像任务额度。验证范围为账号准入及普通接口回归，不代表另做了 CT 推理或 Desktop UI 验收。

完整脱敏证据：[activation.json](../../artifacts/imaging-pilot-shen-20260922/activation.json)。

## 备份与回退

受保护备份：`/opt/codex-gateway-r760/backups/imaging-pilot-add-shen-20260922T062100Z`。包含原 Compose override、环境文件及四个通过完整性和外键检查的在线数据库备份，文件权限 0600、目录 0700；秘密内容未输出。

如需撤销此次开通，可受控恢复 `previous.override.yml` 并按相同生产版本只重建 Gateway；不可用旧数据库覆盖新增业务数据。保留 Nginx 影像日志隔离和原两名用户的权限。
