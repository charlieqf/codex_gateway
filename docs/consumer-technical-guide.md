# MedCode 服务消费者技术说明

版本日期：2026-04-23

本文面向接入 MedCode 的后端开发人员。典型接入方会开发类似 coding CLI、OpenCode、IDE 插件后端、自动化 coding agent 后端的应用。

当前服务处于 1-2 位可信内部用户受控试用阶段。接口已经可以从公网 HTTPS 访问，并提供 OpenAI Chat Completions 兼容 beta，便于已有 OpenAI SDK 客户端接入。原生 MedCode session API 仍然保留，适合需要服务端保存长对话上下文的 coding agent。

## 接入信息

公网地址：

```text
https://gw.instmarket.com.au
```

所有需要授权的请求都使用 API key：

```http
Authorization: Bearer <API_KEY>
```

`GET /gateway/health` 是公开健康检查，不需要 API key。其他接口都需要 API key。

不要把 API key 放进浏览器前端、移动端 App、公开仓库、日志、issue、聊天记录或用户可导出的配置文件。建议只放在你自己的后端服务密钥管理里，由后端代用户调用本服务。

## OpenAI Chat Completions 兼容 beta

如果你的应用已经使用 OpenAI SDK，优先使用这个入口：

```text
baseURL: https://gw.instmarket.com.au/v1
model: medcode
```

`model` 必须是 `medcode`。传入其他 model id 会返回 `404` 和
`error.code: "model_not_found"`。

当前已支持：

- `GET /v1/models`
- `GET /v1/models/medcode`
- `POST /v1/chat/completions`
- `messages[]` 输入，支持 `system`、`developer`、`user`、`assistant`、`tool` role
- `stream: false` 的 `chat.completion` JSON 响应
- `stream: true` 的 `chat.completion.chunk` SSE 响应，并以 `data: [DONE]` 结束
- 当 MedCode 后端产生工具调用观察事件时，响应会包装成 OpenAI `tool_calls` 形状，`finish_reason` 为 `tool_calls`
- 下一次请求可以按 OpenAI 约定携带 assistant `tool_calls` 和 `{ role: "tool", tool_call_id, content }` 工具结果历史
- 当前 Codex 上游正常完成时，`usage` 会按 OpenAI 字段名返回 `prompt_tokens`、`completion_tokens`、`total_tokens`，并可能包含 `prompt_tokens_details.cached_tokens`

`/v1/models` 返回的模型 ID 是 `medcode`。模型对象额外包含几个非 OpenAI 标准字段，便于 OpenCode / ai-sdk 这类客户端配置 UI 限额：

```json
{
  "id": "medcode",
  "object": "model",
  "owned_by": "medcode",
  "context_window": 272000,
  "max_context_window": 1000000,
  "max_output_tokens": 128000
}
```

建议客户端当前用 `context_window: 272000` 做默认上下文进度条和压缩触发阈值。`max_context_window` 表示上游模型能力上限，不代表当前受控试用建议把上下文堆到这个大小。

当前未支持：

- `/v1/responses`
- `/v1/audio`、`/v1/images`、embedding、fine-tuning 等其他 OpenAI API
- native SDK 级动态工具注册、MCP 工具桥接、同一 upstream turn 内 pause/resume。Phase 2 strict client-defined tools 已在 gateway 层实现：兼容层可以接收 `tools`、要求模型按客户端声明的 `function.name` 和 `parameters` JSON Schema 产出 `tool_calls`、校验后再返回给客户端。当前仍不是完整 MCP/native tool runtime。
- Responses API 风格的 reasoning tokens、response item event stream 和 MCP 协议能力。

`finish_reason` 当前只承诺返回：

- `stop`
- `tool_calls`

未来如果接入更多上游 finish 状态，可能扩展 `length` 或其他 OpenAI 兼容取值。

Node.js OpenAI SDK 示例：

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.MEDCODE_API_KEY,
  baseURL: "https://gw.instmarket.com.au/v1"
});

const completion = await client.chat.completions.create({
  model: "medcode",
  messages: [
    { role: "developer", content: "You are a coding assistant." },
    { role: "user", content: "Explain this TypeScript error in one paragraph." }
  ]
});

console.log(completion.choices[0].message.content);
```

流式示例：

```js
const stream = await client.chat.completions.create({
  model: "medcode",
  stream: true,
  messages: [{ role: "user", content: "Give me one concise coding tip." }]
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

工具结果回传遵循 OpenAI Chat Completions 的历史消息约定。客户端收到 assistant `tool_calls` 后，自行执行工具；下一次请求把 assistant 的 `tool_calls` 和工具结果一起放回 `messages[]`：

```js
const followUp = await client.chat.completions.create({
  model: "medcode",
  messages: [
    { role: "user", content: "List the files." },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: {
            name: "bash",
            arguments: "{\"command\":\"ls\"}"
          }
        }
      ]
    },
    {
      role: "tool",
      tool_call_id: "call_abc",
      content: "package.json\nsrc"
    },
    { role: "user", content: "Summarize the result." }
  ]
});
```

兼容层是“无状态调用”：每次请求会把 `messages[]` 编译成一段对话文本发送给 MedCode。多轮对话时，你的应用需要像标准 Chat Completions 一样把必要的历史消息放进 `messages[]`。如果你希望 MedCode 在服务端保留 thread 上下文，请使用下面的原生 session API。

## 原生 session API

当前底层接口按“会话”工作。这里的会话是接入方后端保存的技术标识，不是最终用户必须理解的产品概念。

1. 调用 `POST /sessions` 创建一个会话。
2. 保存返回的 `session.id`。
3. 调用 `POST /sessions/{id}/messages` 发送用户输入。
4. 用 SSE 读取模型返回的增量文本、工具调用事件和完成事件。

如果你在做类似 coding CLI 或 OpenCode 的应用，建议把一个 workspace、一个 terminal thread、一个 IDE chat tab 或一个 agent run 映射到一个 MedCode session。最终用户只需要看到自己的对话、任务或工作区，不需要看到 session id。

当前同时提供 `/v1/chat/completions` 兼容入口和下面的原生 session API。OpenAI SDK 客户端建议优先试 `/v1/chat/completions`；需要服务端 session id、会话列表或更明确排障信息时，再使用原生 session API。

长期更好的接入体验是同时提供一个高层接口或 SDK：接入方只传 `message` 和可选的本地 thread id，由 SDK 自动创建和复用 MedCode session。当前受控试用先暴露底层 session API，是为了让后端开发者可以明确控制上下文、排查问题和做用量归因。

## 快速验证

健康检查：

```bash
curl -sS https://gw.instmarket.com.au/gateway/health
```

只校验 API key：

```bash
curl -sS https://gw.instmarket.com.au/gateway/credentials/current \
  -H "Authorization: Bearer $MEDCODE_API_KEY"
```

这个接口只校验当前 API key 并返回公开元信息，不调用 MedCode 上游服务，也不消耗普通请求限额。客户端登录页或设置页建议优先使用它判断用户填写的 API key 是否有效。

成功响应示例：

```json
{
  "valid": true,
  "subject": {
    "id": "trial-user-1",
    "label": "Trial User 1"
  },
  "credential": {
    "prefix": "cgw_xxxxxxxx",
    "scope": "code",
    "expires_at": "2026-05-06T10:00:00.000Z",
    "rate": {
      "requestsPerMinute": 10,
      "requestsPerDay": 200,
      "concurrentRequests": 1
    }
  }
}
```

缺少、错误、吊销、过期或所属用户被停用时，这个接口返回 `401`，错误码见本文的错误处理表。

验证 API key 和 MedCode 服务状态：

```bash
curl -sS https://gw.instmarket.com.au/gateway/status \
  -H "Authorization: Bearer $MEDCODE_API_KEY"
```

成功响应示例：

```json
{
  "state": "ready",
  "subject": {
    "id": "trial-user-1",
    "label": "Trial User 1"
  },
  "credential": {
    "prefix": "cgw_xxxxxxxx",
    "scope": "code",
    "expires_at": "2026-05-06T10:00:00.000Z",
    "rate": {
      "requestsPerMinute": 10,
      "requestsPerDay": 200,
      "concurrentRequests": 1
    }
  },
  "subscription": {
    "id": "medcode",
    "provider": "medcode",
    "state": "healthy",
    "detail": "MedCode service is available."
  }
}
```

说明：

- `subject` 是内部字段名，可以理解为“这个 API key 属于哪个用户”。
- `credential` 是当前 API key 的公开元信息，只包含 prefix、权限和限额，不包含完整 token。
- `subscription` 是内部字段名，可以理解为“MedCode 服务状态”。

## 创建会话

请求：

```bash
curl -sS -X POST https://gw.instmarket.com.au/sessions \
  -H "Authorization: Bearer $MEDCODE_API_KEY"
```

响应：

```json
{
  "session": {
    "id": "sess_...",
    "subject_id": "trial-user-1",
    "subscription_id": "medcode",
    "provider_session_ref": null,
    "title": null,
    "state": "active",
    "created_at": "2026-04-22T10:00:00.000Z",
    "updated_at": "2026-04-22T10:00:00.000Z"
  }
}
```

你需要保存 `session.id`。后续对话继续使用同一个 session id，MedCode 会在服务端保存上下文关联。

## 列出会话

请求：

```bash
curl -sS https://gw.instmarket.com.au/sessions \
  -H "Authorization: Bearer $MEDCODE_API_KEY"
```

响应：

```json
{
  "sessions": [
    {
      "id": "sess_...",
      "subject_id": "trial-user-1",
      "subscription_id": "medcode",
      "provider_session_ref": "thread-or-provider-ref",
      "title": null,
      "state": "active",
      "created_at": "2026-04-22T10:00:00.000Z",
      "updated_at": "2026-04-22T10:05:00.000Z"
    }
  ]
}
```

列表只返回当前 API key 所属用户的会话，不会跨用户返回。

## 发送消息并读取流式响应

请求体：

```json
{
  "message": "请检查这个 TypeScript 函数的问题：..."
}
```

`message` 必须是非空字符串。

curl 示例：

```bash
curl -N -sS -X POST "https://gw.instmarket.com.au/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $MEDCODE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  --data '{"message":"Say hello from the gateway in one short sentence."}'
```

响应是 Server-Sent Events：

```text
event: message_delta
data: {"type":"message_delta","text":"Hello"}

event: message_delta
data: {"type":"message_delta","text":" from MedCode."}

event: completed
data: {"type":"completed","providerSessionRef":"..."}
```

服务端可能每 25 秒发送一次 heartbeat 注释：

```text
:ping
```

SSE 事件类型：

| event | data 结构 | 含义 |
| --- | --- | --- |
| `message_delta` | `{ "type": "message_delta", "text": "..." }` | 模型输出的一段增量文本 |
| `tool_call` | `{ "type": "tool_call", "name": "...", "callId": "...", "arguments": ... }` | 上游工具调用事件 |
| `completed` | `{ "type": "completed", "providerSessionRef": "..." }` | 本轮消息完成 |
| `error` | `{ "type": "error", "code": "...", "message": "..." }` | 流内错误 |

接入方不要依赖 `message_delta` 的切分粒度。它可能按 token、短句或 SDK 内部 chunk 变化。

## Node.js SSE 示例

下面示例只演示协议处理。生产代码需要增加超时、重试、日志脱敏和错误分类。

```js
const baseUrl = "https://gw.instmarket.com.au";
const apiKey = process.env.MEDCODE_API_KEY;

async function createSession() {
  const res = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`
    }
  });

  if (!res.ok) {
    throw new Error(`create session failed: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  return body.session.id;
}

async function sendMessage(sessionId, message, onText) {
  const res = await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify({ message })
  });

  if (!res.ok) {
    throw new Error(`message failed: ${res.status} ${await res.text()}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      if (!frame || frame.startsWith(":")) {
        continue;
      }

      const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!eventLine || !dataLine) {
        continue;
      }

      const event = eventLine.slice("event: ".length);
      const data = JSON.parse(dataLine.slice("data: ".length));

      if (event === "message_delta") {
        onText(data.text);
      } else if (event === "tool_call") {
        console.log("tool_call", data.name, data.callId, data.arguments);
      } else if (event === "completed") {
        return data;
      } else if (event === "error") {
        throw new Error(`${data.code}: ${data.message}`);
      }
    }
  }
}

const sessionId = await createSession();
await sendMessage(sessionId, "Give me one concise coding tip.", (text) => {
  process.stdout.write(text);
});
```

## 错误响应

非 SSE 接口和请求进入 SSE 前的错误使用统一 JSON：

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Rate limit exceeded.",
    "retry_after_seconds": 12
  }
}
```

常见 HTTP 状态和处理建议：

| HTTP | code | 建议处理 |
| --- | --- | --- |
| 400 | `invalid_request` | 检查请求体，例如 `message` 是否为空 |
| 401 | `missing_credential` | 检查是否发送了 `Authorization` |
| 401 | `invalid_credential` | 检查 API key 是否正确、用户是否被停用 |
| 401 | `revoked_credential` | API key 已吊销，需要换新 key |
| 401 | `expired_credential` | API key 已过期，需要换新 key |
| 404 | `session_not_found` | session 不存在，或不属于当前 API key 的用户 |
| 429 | `rate_limited` | 按 `retry_after_seconds` 延迟后重试 |
| 503 | `provider_reauth_required` | MedCode 服务需要管理员处理授权状态，联系服务管理员 |
| 503 | `subscription_unavailable` | MedCode 服务暂不可用，联系服务管理员 |
| 503 | `service_unavailable` | 服务暂不可用，可稍后重试并通知管理员 |

完整错误码集合：

```text
missing_credential
invalid_credential
revoked_credential
expired_credential
invalid_request
model_not_found
rate_limited
forbidden_scope
session_not_found
tool_call_validation_failed
subscription_unavailable
provider_reauth_required
service_unavailable
```

## API key 权限和用量

每个 API key 当前有以下控制项：

- `scope`：当前试用发放 `code`，用于代码类 agent 场景。
- `expires_at`：过期时间。
- `requestsPerMinute`：每分钟请求数。
- `requestsPerDay`：每天请求数，可能为 `null` 表示不设日限额。
- `concurrentRequests`：同一 API key 同时进行的请求数，当前建议为 `1`。

限流按 API key 执行。当前是单 gateway 进程内限流，适合 1-2 位可信内部用户试用；扩展到多实例或更多用户前，需要升级为持久化/分布式限流。

## 推荐接入方式

后端应用建议这样设计：

1. 在服务端保存分配给你的 API key。
2. 为每个用户、workspace、repo、task 或 chat tab 建立一个本地会话记录。
3. 首次使用时调用 `POST /sessions`，把返回的 MedCode `session.id` 存到你的会话记录里。
4. 用户继续对话时复用同一个 `session.id`。
5. 调用 `POST /sessions/{id}/messages`，把 SSE 的 `message_delta` 转发给 CLI、IDE 或 WebSocket 客户端。
6. 收到 `completed` 后结束本轮；如收到 `error`，按错误码决定是否重试、换 session 或联系管理员。

不要让多个最终用户共用同一个 API key，除非你自己的后端已经能做细粒度审计和限额隔离。对内部试用来说，一个接入方或一个可信开发者使用一个 API key 最容易定位问题。

## 当前限制

- 当前只提供 OpenAI Chat Completions 兼容 beta，不是完整 OpenAI API 兼容实现。
- 当前公开模型列表只包含 `medcode`。
- 当前没有消息恢复流接口；断线后可以继续使用同一个 session 发送下一条消息，但不能从断点恢复同一次 SSE 输出。
- 当前限流是单进程内存限流，不是分布式限流。
- 当前 MedCode 后端模型服务可能需要管理员维护授权状态。需要管理员处理时，接入方会看到 `provider_reauth_required` 或 `service_unavailable`。
- 当前受控试用优先保证可观测、可停用、可限额，不承诺生产级 SLA。

## 排障时请提供的信息

联系服务管理员时，请提供：

- 出错时间和时区。
- 请求的 endpoint。
- HTTP 状态码。
- 响应 header 里的 `X-Request-Id`。
- 错误响应里的 `error.code`。
- 你调用 `/gateway/status` 看到的 `credential.prefix`。
- 相关 `session.id`。
- 是否在重试、并发调用或长时间流式输出时出现。

不要发送完整 API key、完整 Authorization header、服务端模型服务凭据或用户私有代码。
