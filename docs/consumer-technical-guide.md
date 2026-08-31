# GoldenCode Gateway 消费者技术说明

版本日期：2026-08-31。

本文是客户端接入的当前最小合同。历史 MedCode/Azure 试用细节保留在
Git 历史和设计文档中，不再作为接入依据。

## 接入信息

```text
origin: https://goldencode.instmarket.com.au:1443
baseURL: https://goldencode.instmarket.com.au:1443/v1
```

除公开健康检查外，请求使用：

```http
Authorization: Bearer <API_KEY>
```

模型列表以 `GET /v1/models` 为准。当前公共文本模型：

| model | 用途 | context/output |
| --- | --- | --- |
| `goldencode` | Tencent GLM-5.3 云端路由 | 以 `/v1/models` 返回值为准 |
| `goldencode-local` | R760 Qwen3.8-27B-FP8 | 32,768 / 最多 8,192 tokens |

公共图片模型名是 `medcode-image-default`，通过
`POST /gateway/images/generations` 调用。

## OpenAI 兼容接口

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Chat Completions 支持非流式/流式文本、`system`/`developer`/`user`/
`assistant`/`tool` 历史，以及客户端声明的 function tools。工具在客户端执行；
下一轮按 OpenAI 约定回传 assistant `tool_calls` 和 `role=tool` 结果。

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.GOLDENCODE_API_KEY,
  baseURL: "https://goldencode.instmarket.com.au:1443/v1"
});

const response = await client.chat.completions.create({
  model: "goldencode",
  messages: [{ role: "user", content: "Reply with: ok" }]
});
```

多轮兼容调用由客户端携带所需历史。服务端原生 session API 仍提供
`POST /sessions`、`GET /sessions` 和
`POST /sessions/{id}/messages`，仅在确实需要服务端 session 时使用。

## Local 上下文恢复合同

`goldencode-local` 在生成前精确计算 prompt 与请求输出空间。超过
32,768 token 时返回 HTTP 413：

```json
{
  "error": {
    "code": "context_compaction_required"
  }
}
```

客户端应：

1. 非阻塞提示正在整理上下文；
2. 保留当前任务、关键进度和待办，压缩历史；
3. 重建并重新计算请求；
4. 最多自动重试一次；
5. 仍无法留出最低输出空间时，提示新建会话、缩短任务或切换模型。

不要在 413 后无界重试。

## Credential 与版本

保存 key 前调用：

```http
GET /gateway/credentials/current
```

详见 [客户端 API Key 填写与校验](./client-api-key-validation-guide.md)。
Desktop 请求应按当前客户端合同发送 app version、session/message id 等
诊断 header；服务端可能用 HTTP 426 要求升级。

## Desktop 消息上传

Desktop 可向 `POST /gateway/client-events/messages` 上传必要的用户消息和
诊断关联字段。上传与查询的隐私边界见
[Desktop 用户消息查询](./operations/client-message-query-support.zh-CN.md)。
Gateway 消息记录不包含完整 assistant 输出，也不能证明本地 PPTX/HTML 等产物
存在或有效。

## 错误和重试

| HTTP | 含义 | 动作 |
| --- | --- | --- |
| 400 | 请求/工具 schema 无效 | 修正请求，不重试相同内容 |
| 401 | credential 无效 | 重新校验 key |
| 404 | model/resource 不存在 | 刷新 `/v1/models` 或检查资源归属 |
| 413 | Local context 超限 | 按上文压缩并最多重试一次 |
| 426 | Desktop 版本过低 | 升级客户端 |
| 429 | 速率/容量限制 | 遵守 `Retry-After` 后有限重试 |
| 5xx | Gateway/provider 暂不可用 | 保留 request ID，指数退避 |

始终记录响应 `X-Request-Id`，但不得记录 Authorization header、完整 key、
provider body、私有源码、PHI 或不必要的本地文件内容。

## 接入验收

至少验证：

1. credential 校验和 `/v1/models`；
2. `goldencode` 非流式与流式文本；
3. function call、客户端工具执行和 follow-up；
4. request ID 与错误展示；
5. Local 413 压缩/单次重试（如果启用 Local）；
6. key、用户、Plan 和速率限制错误；
7. 客户端日志和反馈材料无敏感信息。

当前生产状态与专项 runbook 以
[System Status](./operations/system-status.md) 和
[Runbook Index](./operations/runbook-index.md) 为准。
