# Desktop `pro` 空流事件排查记录（2026-07-17）

## 结论

用户截图中的“模型本轮没有返回任何可显示内容”不是 Gateway 整体宕机、
API key 失效、限流或上下文超限。

目标 Desktop turn 在第一步成功调用 `todowrite` 后，第二个
`pro -> openrouter -> z-ai/glm-5-turbo` 请求得到 HTTP 200，但上游流在约
300 秒后结束时没有提供 `finish_reason`、正文、工具调用或 token usage。
Gateway 当前把这种不完整 SSE EOF 记录为 `status=ok`；Desktop 检测到
`empty_turn=true` 后停止该 turn，并显示用户截图中的兜底提示。

这是两层问题：

1. OpenRouter/上游模型返回了不完整空流。
2. Gateway 的 OpenAI-compatible provider 没有把“无终止原因、无正文、
   无工具调用的 EOF”判定为上游流错误。

## 目标事件

- Client turn：`msg_f6f3efa59001xVruhqf8ObNjw5`
- Turn code：`T:KAA0H7GS`
- Client session：`ses_09151688bffekh5aFJGp2qJ3xX`
- App version：`0.0.0-prod-202607170142`
- 用户任务摘要：生成完整课题申报书/研究方案

第一步 Gateway 请求：

- Request：`req-c236a31a-317f-409b-bd31-bd411a205339`
- `status=ok`
- `finish_reason=tool_calls`
- 工具：`todowrite`
- 耗时：18,893 ms

空流 Gateway 请求：

- Request：`req-e4f6fe99-cd57-4317-b653-97b6e0e7036a`
- Provider：`openrouter`
- Public model：`pro`
- Upstream model：`z-ai/glm-5-turbo`
- `tool_choice=auto`
- `status=ok`
- `error_code=null`
- `upstream_http_status=200`
- `upstream_finish_reason=null`
- `upstream_content_chars=0`
- `upstream_tool_call_count=0`
- `upstream_raw_response_chars=234`
- usage：缺失
- 耗时：300,203 ms
- Gateway 估算 prompt：62,179 tokens，约占声明上下文窗口 31.1%

Desktop 同一 turn 的终态诊断：

- `provider_stream/terminal status=ok`
- `finish_reason=stop`
- `content_chars=0`
- `tool_call_count=0`
- `empty_turn=true`
- `client_fallback_injected=false`
- `agent_turn terminal_state=ok`

截图文件名前 13 位的毫秒时间戳对应客户端本地时间约
`2026-07-17 16:49:44 +08:00`，与客户端诊断记录的空 turn 终止时间
`16:49:08 Asia/Shanghai` 对齐。Client event 为异步上传，`created_at` 与
Gateway 的 `received_at` 存在约两分钟偏差，因此 provider 请求耗时以
Gateway `request_events` 为准。

## 重试结果

相同用户随后用 `goldencode` 重试：

- Client turn：`msg_f6f48ffd4001CzaIv9AhBSKSUA`
- Turn code：`T:Z9VPGNW3`
- 最终 Gateway request：`req-1f8e1051-fd5e-4c36-9280-4d0ca7499b9f`
- Route：`goldencode-aliyun -> glm-5.2`
- `status=ok`
- `finish_reason=tool_calls`
- 工具：`export_document`
- Desktop 工具终态：`status=ok`
- Desktop turn 终态：`terminal_state=ok`

这说明“重试或切换模型”在本次事件中有效，也进一步排除了用户凭据、
Desktop 整体链路和 Gateway 整站不可用。

## 近 24 小时同签名影响

查询条件：

- `status=ok`
- `upstream_http_status=200`
- `upstream_finish_reason IS NULL`
- `upstream_content_chars=0`
- `upstream_tool_call_count=0`

结果：

- `pro/openrouter/z-ai/glm-5-turbo` 共 58 条请求、56 条 `status=ok`
- 同签名不完整空流 2 条
- 仅影响 1 个 subject，且位于同一 client session
- 两条分别耗时 300,151 ms 和 300,203 ms
- 两条 `upstream_raw_response_chars` 均为 234
- 未发现其他 provider/public model 命中

另一条同签名请求：

- Request：`req-08b8aad1-21be-49a6-aea5-5c5fbdff3dae`
- Client turn：`msg_f6f3066a3001p85ekKro2QZ9P6`
- Turn code：`T:QYWMYF48`
- Gateway 估算 prompt：57,818 tokens

## 建议修复

Gateway：

1. OpenAI-compatible provider 只有在收到有效 `finish_reason`，或已经产生
   正文/工具调用时，才能把流记为 completed。
2. HTTP 200 流 EOF 若同时满足无 `finish_reason`、无正文、无工具调用，
   应返回明确的 `upstream_incomplete_stream`（或等价上游错误），并将
   request event 记为 error，而不是 `status=ok`。
3. 在尚未向客户端写出业务正文或工具调用时，可评估一次受控重试；
   不能把长时间无语义输出当作成功。
4. 增加不完整 EOF 回归测试，覆盖有少量非语义 SSE 数据、无 usage、
   无 `[DONE]`/终止原因的分支。

Desktop：

1. 保留当前空 turn 保护，避免无限等待。
2. 对 Gateway 的明确不完整流错误显示“上游响应中断，请重试或切换模型”，
   并附带 turn code，避免将其表述为普通模型空回答。

短期用户处理：

- 直接重试，或从 `pro` 切换到 `goldencode`。
- 无需更换 API key，也无需重装客户端。

## 本次操作范围

- 仅执行生产只读查询：Gateway health、Compose 状态、
  `client-messages`、`client-diagnostics`、`request_events` 和脱敏日志。
- 未修改生产配置、数据库、用户凭据、Nginx 或 Docker。
- 未重启任何服务。
- 当前 Gateway public health 为 `state=ready`，容器为 `healthy`，
  `RestartCount` 未因本次排查发生变化。
