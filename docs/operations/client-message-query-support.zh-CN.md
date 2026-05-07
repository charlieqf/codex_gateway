# Desktop 用户消息查询排障交接说明

本文说明 Gateway 团队应承接的 Desktop 用户消息查询和排障工作。核心原则：凡是依赖 `gw.instmarket.com.au` 的用户身份、API key、Desktop 上传消息或客户端诊断事件的数据查询，都应由 Gateway 运维侧提供稳定、只读、可审计的入口，而不是由 App 或 MedEvidence v2 团队临时 SSH 到生产环境执行 ad-hoc SQL。

## 背景

Desktop 会把用户本轮原始问题上传到 Codex/MedCode Gateway：

- endpoint: `POST /gateway/client-events/messages`
- 主身份库: `/var/lib/codex-gateway/gateway.db`，这是 gateway 容器内路径
- 客户端事件库: `/var/lib/codex-gateway/client-events.db`，这是 gateway 容器内路径
- 消息表: `client_message_events`
- 诊断表: `client_diagnostic_events`

因此，类似“查用户杜衡在 Desktop app 里最近一个问题”这类支持请求，事实数据源在 Gateway，而不是 MedEvidence v2 的 `requests` 表。MedEvidence v2 只能回答 evidence service 请求本身，例如 `/ask/async` 的 request/job 状态；无法可靠还原 Desktop 用户发给 MedCode agent 的原始消息。

当前 Gateway 生产形态是部署在 Azure VM `4.242.58.89` 上的 Docker Compose 容器：

- 公开入口: `https://gw.instmarket.com.au`，由 VM 主机 Nginx 代理到 `127.0.0.1:18787`
- compose project: `codex_gateway_test`
- gateway container: `codex_gateway_test-gateway-1`
- Docker volume: `codex_gateway_test_gateway_state`
- 容器内数据目录: `/var/lib/codex-gateway`
- VM 主机实际 volume 目录: `/var/lib/docker/volumes/codex_gateway_test_gateway_state/_data`

不要把 VM 主机上的 `/var/lib/codex-gateway` 当成生产路径；当前主机上没有这个目录是正常的。也不要把 `~/codex-gateway-state/gateway.db` 当成当前生产库；这是早期 native/smoke 验证留下的用户目录状态，不承载当前 `gw.instmarket.com.au` 生产流量。

部署状态：新版 admin CLI 已于 2026-05-07 部署到 Azure VM 的 Gateway 容器。容器内 `codex-gateway-admin --help` 已包含 `--client-events-db`、`client-messages`、`client-diagnostics`，并已用生产 `client-events.db` 验证可按用户真实姓名查询 Desktop 消息。

## Gateway 团队应承接的查询

Gateway 运维提供稳定只读命令，覆盖以下常见支持问题：

1. 按用户显示名、subject id、API key prefix 或 unified key 查询最近 N 条 Desktop 用户消息。
2. 按 Desktop `session_id` 或 `message_id` 查询对应的用户消息、agent、model、engine、app version 和上传时间。
3. 用 unified key 定位 Gateway credential 与 subject，但命令不得打印 full key。
4. 查询某用户/API key 是否 active、expired、revoked、disabled，及其 scope、过期时间和限流配置。
5. 按 `request_id` 查询一次 client message ingest 是否成功写入、是否重复、是否触发限流。
6. 查询同一用户最近的 `client_diagnostic_events`，用于关联 prompt submit、provider stream、MedEvidence tool call、polling 和 error/timeout。
7. 按 MedEvidence diagnostic metadata 中的 `request_id` 或 `article_id` 反查对应 Desktop session/message，辅助判断是 Desktop 渲染问题、Gateway/MedCode 问题，还是 MedEvidence v2 问题。
8. 查询 message upload 健康情况，例如最近成功上传时间、失败诊断、缺失 credential、上传被关闭、429/5xx、idempotency conflict。

## 命令入口

优先使用 admin/ops 只读命令，而不是让操作者手写 SQL。生产查询应进入当前 gateway 容器执行，让 CLI 看到容器内的 `/var/lib/codex-gateway` 挂载路径。默认情况下，`--client-events-db` 会从 `--db` 所在目录推导为同级 `client-events.db`；生产排障建议显式传入，避免误查：

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  --client-events-db /var/lib/codex-gateway/client-events.db \
  client-messages --user "杜衡" --limit 5
```

消息查询参数：

```text
--user <display-name-or-subject-id>
--subject-id <id>
--credential-prefix <prefix>
--unified-key-env <env-name>
--session-id <id>
--message-id <id>
--request-id <id>
--limit <n>
--json
--include-text
--preview-chars <n>
--since <iso-or-local-time>
--timezone <iana-zone>
```

诊断查询入口：

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  --client-events-db /var/lib/codex-gateway/client-events.db \
  client-diagnostics --user "杜衡" --session-id <id> --message-id <id> --limit 50
```

诊断查询额外支持：

```text
--tool-call-id <id>
--article-id <id>
--category <category>
--action <action>
--status <started|ok|error|aborted|timeout|queued|dropped>
--include-metadata
```

`client-diagnostics --request-id <id>` 会同时匹配 Gateway ingest `request_id` 和 `metadata.request_id`，用于反查 MedEvidence diagnostic metadata 中的 request id。

处理 unified key 时，不要把完整 key 放进命令行历史。使用环境变量或 stdin：

```bash
export SUPPORT_UNIFIED_KEY='cmev1...'
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  --client-events-db /var/lib/codex-gateway/client-events.db \
  client-messages --unified-key-env SUPPORT_UNIFIED_KEY --limit 5
```

命令内部只应使用 MedCode half 计算 credential prefix/hash，并在输出中最多显示 prefix。不得输出 MedCode key、MedEvidence key 或完整 unified key。

## 输出要求

默认输出应足够支持排障，但避免不必要泄露：

- subject id、用户显示名、credential prefix、credential 状态
- message id、session id、Gateway ingest request id
- created_at、received_at，必须明确时区
- agent、provider_id、model_id、engine
- app_name、app_version
- 默认只显示 prompt preview；需要完整正文时显式加 `--include-text`
- JSON 模式用于进一步机器处理

示例输出字段：

```json
{
  "subject": {
    "id": "medcode-trial-user-1",
    "name": "杜衡",
    "state": "active"
  },
  "credential": {
    "prefix": "0ZLslPJ_XNKMXA",
    "scope": "code",
    "expires_at": "2026-07-01T00:00:00.000Z",
    "revoked_at": null
  },
  "messages": [
    {
      "received_at": "2026-05-07T03:31:19.227Z",
      "received_at_local": "2026-05-07 11:31:19 Asia/Shanghai",
      "session_id": "ses_...",
      "message_id": "msg_...",
      "agent": "general",
      "engine": "agent",
      "text_preview": "请不要调用 MedEvidence..."
    }
  ]
}
```

## 隐私和安全要求

- 不得在日志、stdout、审计事件或文档中打印 full API key、unified key、token ciphertext、`CODEX_HOME/auth.json` 或 browser/device auth token。
- 不得把完整用户 prompt 写入普通运维日志。命令 stdout 可以在操作者显式请求 `--include-text` 时返回正文，但该输出应视为敏感支持材料。
- 查询命令必须只读打开 SQLite，不能执行 migration、VACUUM、prune、update、delete 或任何 schema 变更。
- 不要通过 `docker compose down`、重启 gateway、修改 Nginx 或改环境变量来完成查询。
- 查询 full text 前应有明确支持原因，例如用户报障、内部试用复盘、或产品质量分析。长期应在 admin audit 中记录 operator、目标 subject/credential、查询类型、ticket/reason，但 audit 中不得保存 prompt 正文。
- 如果需要把结果发给 App/MedEvidence 团队，应只发必要片段；优先发 message id、request id、时间、agent、状态和脱敏 prompt 摘要。

## 排障分工

Gateway 团队负责：

- Gateway subject/API key 到用户的映射。
- Desktop message upload 和 diagnostic upload 是否入库。
- client-events SQLite schema、索引、查询命令和权限控制。
- API key 状态、限流、credential auth、ingest request id 和 gateway access 日志关联。
- MedCode provider 请求链路、OpenAI-compatible `/v1/chat/completions` 请求事件和 usage 事件。

App/Desktop 团队负责：

- Desktop 是否按约定上传用户原始 text parts。
- app_name/app_version/session_id/message_id/agent/model/engine 字段是否正确。
- 上传失败不得影响用户主流程。
- renderer/sidecar 本地 UI、消息保存、诊断事件采集和字段传播。

MedEvidence v2 团队负责：

- `/ask/async`、`/request/<request_id>`、worker/job/account 状态。
- MedEvidence rich asset、structured_article、polling 和 evidence service 结果。
- 当 Gateway diagnostic metadata 中存在 MedEvidence `request_id` 或 `article_id` 时，继续做 evidence service 侧排障。

## 已补齐的交付物

Gateway 团队已把以下能力产品化：

1. `client-messages` 只读 admin CLI 命令，支持按 user、credential prefix、unified key env、session/message/request id 查询。
2. `client-diagnostics` 只读 admin CLI 命令，支持按 user/session/message/tool_call/request id、metadata request id、article id 查询。
3. 命令只读打开主 `gateway.db` 和 `client-events.db`，不执行 migration 或 schema 变更。
4. 默认只输出 prompt preview；显式 `--include-text` 才输出完整正文。
5. 单元测试覆盖 unified key env 解析不泄露、preview/full text 开关、跨库关联、diagnostic metadata 查询。
6. 生产 runbook 示例命令，避免操作者临时拼 SQL。

仍需运维流程长期补齐：

1. 用户报障时应收集时间、用户、问题摘要、session/message/request id、是否 Desktop、是否 MedEvidence direct/tool。
2. 查询 full text 的长期 operator/ticket/reason 审计，但 audit 中不得保存 prompt 正文。

不要把临时 SQL 或一次性脚本作为常态支持路径；如果现有命令无法覆盖新的排障场景，应优先补 CLI 参数和测试，再更新本 runbook。
