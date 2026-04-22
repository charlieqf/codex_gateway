# MedCode 服务消费者技术说明

版本日期：2026-04-22

本文面向接入 MedCode 的后端开发人员。典型接入方会开发类似 coding CLI、OpenCode、IDE 插件后端、自动化 coding agent 后端的应用。

当前服务处于 1-2 位可信内部用户受控试用阶段。接口已经可以从公网 HTTPS 访问，但仍是 MVP 接口，不是 OpenAI API 兼容接口。

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

## 当前接口模型

当前底层接口按“会话”工作。这里的会话是接入方后端保存的技术标识，不是最终用户必须理解的产品概念。

1. 调用 `POST /sessions` 创建一个会话。
2. 保存返回的 `session.id`。
3. 调用 `POST /sessions/{id}/messages` 发送用户输入。
4. 用 SSE 读取模型返回的增量文本、工具调用事件和完成事件。

如果你在做类似 coding CLI 或 OpenCode 的应用，建议把一个 workspace、一个 terminal thread、一个 IDE chat tab 或一个 agent run 映射到一个 MedCode session。最终用户只需要看到自己的对话、任务或工作区，不需要看到 session id。

当前没有 `/v1/chat/completions`、`/v1/responses` 或 `/v1/models` 兼容接口。不要把本服务当作标准 OpenAI SDK base URL 直接替换。

长期更好的接入体验是同时提供一个高层接口或 SDK：接入方只传 `message` 和可选的本地 thread id，由 SDK 自动创建和复用 MedCode session。当前受控试用先暴露底层 session API，是为了让后端开发者可以明确控制上下文、排查问题和做用量归因。

## 快速验证

健康检查：

```bash
curl -sS https://gw.instmarket.com.au/gateway/health
```

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
rate_limited
forbidden_scope
session_not_found
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

- 当前接口不是 OpenAI API 兼容接口。
- 当前没有公开模型列表接口。
- 当前没有消息恢复流接口；断线后可以继续使用同一个 session 发送下一条消息，但不能从断点恢复同一次 SSE 输出。
- 当前限流是单进程内存限流，不是分布式限流。
- 当前 MedCode 后端模型服务可能需要管理员维护授权状态。需要管理员处理时，接入方会看到 `provider_reauth_required` 或 `service_unavailable`。
- 当前受控试用优先保证可观测、可停用、可限额，不承诺生产级 SLA。

## 排障时请提供的信息

联系服务管理员时，请提供：

- 出错时间和时区。
- 请求的 endpoint。
- HTTP 状态码。
- 错误响应里的 `error.code`。
- 你调用 `/gateway/status` 看到的 `credential.prefix`。
- 相关 `session.id`。
- 是否在重试、并发调用或长时间流式输出时出现。

不要发送完整 API key、完整 Authorization header、服务端模型服务凭据或用户私有代码。
