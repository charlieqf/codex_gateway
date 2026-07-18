# Gateway OpenAI SSE 终止与错误协议

本文冻结 `/v1/chat/completions` 的成功提交、上游不完整响应和流内错误语义，供
Gateway 与桌面客户端共同实现。

## 错误 envelope

HTTP 错误响应与已经开始输出后的 SSE `data:` 错误帧使用同一个 `error` 对象。
现有 OpenAI 兼容字段可以保留，但以下字段固定存在：

```json
{
  "error": {
    "code": "upstream_incomplete_stream",
    "message": "MedCode upstream response ended before completion.",
    "retryable": true,
    "request_id": "req-..."
  }
}
```

- 尚未开始 HTTP 响应时，上游无效或不完整响应返回 HTTP 502。
- HTTP 200/SSE 已开始后，Gateway 发送一个终止性错误帧。
- `retryable` 表示服务端错误分类，不表示客户端必须自动重试。客户端可以继续采用
  用户手动重试，以避免工具副作用被重复执行。
- `request_id` 与 `X-Request-Id` 相同，SSE payload 中仍重复携带。

## 成功与终止

1. Gateway 下游 SSE 只有 `data: [DONE]` 是成功提交信号。
2. `finish_reason` 是诊断和输出形态信息，不单独代表流成功。
3. OpenAI-compatible 上游必须发送 `[DONE]`；只有 `finish_reason` 后 EOF 仍是
   `upstream_incomplete_stream`。
4. `error` 帧是终止帧；其后不得发送正文、tool-call、finish chunk 或 `[DONE]`。
5. HTTP 200 SSE 内嵌的 `{"error": {...}}` 也是上游错误，不得作为普通数据忽略。
6. 协议正常完成但没有可用语义输出时，返回 `upstream_empty_response`。
7. `finish_reason=content_filter` 返回不可重试的
   `content_policy_violation`，不得触发账号冷却或跨账号 failover。

## Tool-call 提交

Gateway 在确认 provider 完成前缓冲 `/v1` 流式 tool-call。只有完成判定通过后才向
客户端发布 tool-call；不完整流中的 tool-call 不得逃逸到客户端执行。由此，
Gateway 可以在尚未发布正文或工具调用时进行一次受控的无状态 failover。

客户端仍应把 `[DONE]` 作为整轮成功提交信号，并避免在收到终止性错误帧后执行任何
尚未执行的工具。
