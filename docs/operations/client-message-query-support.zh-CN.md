# Desktop 用户消息查询

最后更新：2026-08-31。

本说明只覆盖 Gateway 中的 Desktop 用户消息。标准查询应在十几秒内完成；
只有无结果、用户重名或关联缺失时才进入进一步排障。

## 快速查询

查询指定用户最近 48 小时消息：

```powershell
Set-Location C:\work\code\codex-gateway
$cutoff = (Get-Date).ToUniversalTime().AddHours(-48).ToString("o")
python scripts\query-client-messages.py `
  --user "<用户>" `
  --since $cutoff `
  --timezone Asia/Shanghai `
  --limit 500 `
  --include-text `
  --format json
```

如果用户要求特定主题，例如 PPT：

1. 只执行一次用户和时间窗口查询；
2. 在结果中筛选 `ppt`、`pptx`、`PowerPoint`、`幻灯片`、
   `演示文稿` 等关键词；
3. 找出命中的 `session_id`；
4. 按时间顺序整理这些会话中的相关消息；
5. 返回必要的 session/message/request ID 和请求状态。

不要先阅读部署历史，不要查询 Azure，不要同步数据库，也不要为普通查询
编写 ad-hoc SQL。

## 数据源

R760 是唯一权威端：

```text
Compose project: codex_gateway_r760
Container:       codex_gateway_r760-gateway-1
Identity/events: /var/lib/codex-gateway/gateway.db
Client events:   /var/lib/codex-gateway/client-events.db
Messages table:  client_message_events
Diagnostics:     client_diagnostic_events
```

Desktop 原始用户消息位于 Gateway，不在 MedEvidence v2 的
`requests` 表。MedEvidence v2 只能查询 evidence-service 请求和 job。

## 管理页面与请求关联

管理页面：

`https://goldencode.instmarket.com.au:1443/gateway/admin/client-messages`

对应只读 JSON：

`/gateway/admin/client-messages.json`

它支持用户、正文、session、message、时间窗口、分页和完整正文过滤，并按
`request_events.subject_id + request_events.client_message_id` 精确关联：

- 成功、部分失败、失败或无请求记录；
- 请求数、成功/失败/限流数；
- 端到端耗时；
- provider 实测 token 与缺失时的估算；
- Gateway request ID 与 upstream attempt。

使用管理 token 时不得打印或保存 token。普通用户 API key 不能访问该页面。

## CLI 参数

`query-client-messages.py` 支持：

```text
--user / --subject-id / --credential-prefix
--session-id / --message-id / --request-id
--limit / --since / --timezone
--include-text / --preview-chars
--format text|json
```

默认 R760。历史 Azure 查询开关只允许用于单独批准的数据恢复调查，不属于
普通支持流程。

## 输出与隐私

对外只返回完成任务所需内容：

- 用户显示名；
- 消息时间和必要正文；
- session/message/upload request ID；
- Gateway request ID、状态、错误码和耗时；
- 与问题直接相关的 app version、agent、model 路由。

不得返回手机号、完整或前缀 credential、unified key、token、其他用户正文或
无关附件元数据。完整正文属于敏感支持材料，不写入普通运维日志或文档。

Gateway 请求成功不等于本地导出文件有效。PPTX、HTML 等 artifact 是否存在、
能否打开以及视觉质量，需要 Desktop 侧文件或 artifact 证据。

## 仅在失败时升级

- **用户重名：** 使用明确的 subject id，不能猜测。
- **无消息：** 核对时间、Desktop app/version、消息上传是否启用。
- **有消息但无关联请求：** 查询 client diagnostics 或 support code。
- **有 Gateway 错误：** 按 request ID 使用症状 runbook 分类。
- **Gateway 全部成功但文件失败：** 转 Desktop/tool-loop/artifact 排障。

整个查询过程保持只读，不重启服务、不修改配置、不写数据库。
