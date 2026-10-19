# RTI 错误流事件调查及调用方交接

2026-10-19 核实：RTI 的 `Invalid medcode/openai-compatible-chat stream event`
是调用方解析器把 Gateway 错误事件当作正常对话 chunk 校验后产生的二次错误。
最新一笔的根因是模型工具参数不符合请求声明的 JSON Schema，并非网络断流或非法 JSON。

## 最新一笔证据

- Gateway 请求：`req-a0e87e5f-fadd-4ede-ae04-6f02898e1fca`。
- UTC 06:05:16.127–06:05:42.411；北京时间 14:05:16–14:05:42，耗时 26.28 秒。
- 第一次腾讯响应缺少 `meeting_pack_read_sources.key`。
- 修复重试的 `meeting_pack_submit_draft` 缺少 `expectedRevision`、`proposals`、
  `processed`，并有额外字段。两次上游均 HTTP 200，正常流终止，未截断。
- Gateway 25 秒心跳先提交 HTTP 200；失败后按流错误契约发送 `data: {"error": ...}`。
  Gateway 完成日志确认 HTTP 200，内部结果为 tool_call_validation_failed/schema_mismatch。
- RTI 容器 06:05:42.426 报出上述 Invalid stream event；对应会话
  `ses_060d3e50-0904-4ba8-958c-e0299d932ac3`。
- 使用线上 RTI 的 `packages/llm/src/protocols/openai-chat.ts` schema 实测：
  正常 chunk 接受，合成 Gateway 错误事件因缺少 `choices` 被拒绝。
  `packages/llm/src/route/client.ts` 把这一拒绝包装为 Invalid stream event。
- 原始错误帧未持久化，RTI 会话仅保存简化错误；以上错误帧验证为合成复现。
  RTI 这些请求没有 Gateway model-call receipt，不能宣称已读取原始返回正文。

## 历史四笔核对

| UTC 开始时间 | 请求 ID | 上游 | 根因 | 耗时 |
| --- | --- | --- | --- | --- |
| 10-15 15:07:18 | `req-741a0c5f-97e5-4ed7-ba59-70c80a64738b` | 腾讯 | schema_mismatch；第二次 processed 超过 maxItems | 76.60 秒 |
| 10-17 11:29:51 | `req-66893ad0-b18c-48d5-96bf-c58efe93557a` | 腾讯 | upstream_empty_response；finish_reason=abort，无工具/文本输出 | 13.72 秒 |
| 10-18 14:58:16 | `req-9d4ca8c3-eb9c-452b-945d-0dfc7be86fc0` | 天宽 | schema_mismatch；两次均缺少 kind | 176.75 秒 |
| 10-19 06:05:16 | `req-a0e87e5f-fadd-4ede-ae04-6f02898e1fca` | 腾讯 | schema_mismatch，见上文 | 26.28 秒 |

三笔 schema 失败均已重试一次；13.72 秒空响应早于心跳，应走 HTTP 502 错误正文分支。
RTI 提供的四笔/约 1,300 次属于其任务统计范围，不是整个 Gateway 账号的完整失败统计。

## 调用方修复与验收

1. 同时解析非 2xx 的 JSON 错误正文与 SSE `data.error`。识别错误事件应在
   正常 `choices` schema 校验前完成；不能给错误事件补空 choices 后当作成功。
2. 保留并展示 request_id、code、failure_kind、recommended_action、recovery_owner；
   区分明确拒绝和结果未知，避免把可诊断错误丢失为通用 Invalid stream event。
3. 明确被 Gateway 拒绝、未交付工具调用的这笔请求可在任务总预算内有限重新生成。
   不重放此前已执行成功的步骤；超时、断线、未知结果不能按同一规则盲目重试。
   瞬间原样重放也不保证修复参数，应利用具体校验原因。
4. 验收：心跳前 HTTP 502、心跳后 HTTP 200+SSE error 都应保留相同业务错误，
   错误帧不触发工具执行；正常工具流不回归；已完成步骤不重复写入。
5. 回传最小材料：修复提交号、上述测试结果；如仍失败，提供完整错误类型、
   请求 ID 和脱敏后的失败 SSE 帧即可，不必提供完整会议内容或凭证。

本次 Gateway `c183e3f` 发布只优化 invalid_json 修复，不包含 RTI 解析器变更，
也不宣称解决这里的 schema_mismatch 或空响应。
