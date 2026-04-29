# MedCode 服务端协议演进建议 (RFC)

| | |
| --- | --- |
| **状态** | 草案 (Draft) — 等待 MedCode 团队反馈 |
| **版本日期** | 2026-04-23 |
| **发起方** | MedEvidence 接入团队 |
| **对应 MedCode 文档** | 《MedCode 服务消费者技术说明》2026-04-22 版 |
| **联系人** | （待填） |

---

## 1. 背景

MedEvidence 的 CLI 和 Desktop 产品构建在 OpenCode 分支之上，内部所有 chat 模型统一走 [Vercel ai-sdk](https://sdk.vercel.ai/) 的 `LanguageModelV3` 抽象。现有 14 种 provider（OpenAI / Anthropic / Google / Groq / Cerebras / GitHub Copilot / GitLab 等）要么直接复用 `@ai-sdk/openai` 等官方 SDK，要么基于 `@ai-sdk/openai-compatible` 做薄包装。

本次希望接入 MedCode 作为一个一等 provider，让用户在 CLI / Desktop 的模型选择器里像选择 GPT / Claude 一样选择 MedCode，并填写 API key。

我们阅读了 MVP 技术说明，认可你们的核心架构决定（session-first、服务端统一上下文、可观测 / 可限流 / 可归因）。本文不是在挑战这个架构，而是**希望在协议形态上尽可能对齐 OpenAI 事实标准**，让双方的长期成本都更低。

## 2. 问题陈述

现状下，我们接入 MedCode 需要做的工作量远大于接入任何其他主流 provider。主要差距：

### 2.1 协议层不兼容 ai-sdk

MedCode 自定义了 `POST /sessions` + `POST /sessions/{id}/messages` 端点，没有 `/v1/chat/completions` 或 `/v1/responses`。

- 所有 ai-sdk 官方 SDK、`@ai-sdk/openai-compatible` 包都无法直接使用
- 我们需要从零实现一个 `LanguageModelV3` 适配器

### 2.2 状态语义不对齐

MedCode 端点是**有状态**的（server 按 `session.id` 维护上下文，client 每次只发最新一条 `message`）；ai-sdk 和绝大多数主流 LLM API 是**无状态**的（每次请求带完整 `messages[]` 历史）。

这导致几个具体问题：
- OpenCode 的 **自动压缩 (compaction)** 触发时，OpenCode 端会"删除/合并"部分历史消息。MedCode server 端的上下文如何同步？目前文档没有约定。
- OpenCode 支持**编辑历史消息**和**分叉会话**。MedCode 目前不支持历史回溯。
- Session 生命周期和错误恢复行为不清晰：`provider_reauth_required` / `subscription_unavailable` 后，旧 session 是否仍可用？

### 2.3 System prompt 无法传递

`POST /sessions/{id}/messages` body 只接受 `{ "message": string }`。MedEvidence 的每个 agent（如 `medical`）都有定制的 system prompt（证据分级、安全红旗、结构化输出等）。目前只能把 system 拼到第一条 user message 里，hack 味重且 token 浪费。

### 2.4 Tool call 结果回传通道缺失

文档描述了 server → client 方向的 `tool_call` SSE 事件：

```text
event: tool_call
data: {"type":"tool_call","name":"...","callId":"...","arguments":...}
```

但**完全没有描述** client 如何把工具执行结果回传。对 coding agent 这是硬门槛 —— 没有这个通道，就是纯文本 chatbot，离"Codex 类 coding agent 体验"差得远。

### 2.5 其他次要差距

- 没有 `/v1/models` 或等价端点，无法做模型发现
- `completed` 事件里的 `providerSessionRef` 字段用途未说明
- 限流参数 `concurrentRequests=1` 对 sub-agent 和并行 tool-call 过于严格
- `message_delta` 粒度不保证稳定（文档已提示），某些客户端的 UI 会抖动

## 3. 设计原则

我们不希望让 MedCode 推翻现有架构。相反，本 RFC 的核心原则是：

1. **保留 session 语义**。Server 端的上下文管理、用量归因、限流都不变。
2. **在协议形态上对齐 OpenAI**。事件 JSON、tool-call schema、错误码形状对齐业界事实标准，零成本兼容大量工具链。
3. **可选增量**。每个条目独立，MedCode 可以按 P0 / P1 / P2 分级落地，不必一次性改完。
4. **向后兼容**。所有提议都不要求删除现有 `/sessions` + `/messages` 形态，新增即可。

## 4. 提案分级概览

兼容性拆成三层，难度和收益完全不同，可以分开取舍：

| 层级 | 改什么 | MedCode 实施成本 | 接入方收益 | 本 RFC 态度 |
| --- | --- | --- | --- | --- |
| **L1：端点形态** | 新增 `/v1/chat/completions` 壳 | 高（要么改无状态，要么内部映射 session） | ⭐⭐⭐ 接入代码归零，Cursor / Cline / Zed 等整个 OpenAI 生态免费接入 | 可选，长期建议 |
| **L2：事件形态** | 保留 `/sessions` 端点，但 SSE 帧对齐 OpenAI `chat.completion.chunk` 或 `response.*` 形态 | 中（只改序列化） | ⭐⭐ 免写 SSE 解析、delta 拼接、usage 字段处理 | **强烈建议** |
| **L3：工具协议** | 对齐 OpenAI tool-call schema，并**新增** tool-result 回传通道 | 中（tool-result 本来就必须补，顺便对齐 schema） | ⭐⭐⭐ coding agent 的前提；tool 封装完全复用 ai-sdk | **必须** |

我们的诉求按这个优先级提出：**L3 > L2 > L1**。

## 5. 需求清单

下面每一条都可以独立回复：accepted / deferred / rejected / counter-proposal。

### 5.1 P0：tool-result 回传通道（对应 L3）

**问题**：文档描述了 `tool_call` 事件，但没有 client → server 的工具结果回传路径。

**建议协议**（方案 A，推荐）：

允许 `POST /sessions/{id}/messages` 的 body 扩展为两种形态：

```json
// 形态 1：用户新消息（现状）
{ "message": "..." }

// 形态 2：工具结果回传（新增）
{
  "tool_results": [
    {
      "tool_call_id": "call_abc123",
      "output": "...",
      "is_error": false
    }
  ]
}
```

Server 收到形态 2 时，把工具结果注入当前 session 上下文，继续同一轮生成（不算新一轮用户消息），仍然用 SSE 流式返回 `message_delta` / 可能的下一个 `tool_call` / `completed`。

**建议协议**（方案 B，如果你们更偏好 REST 分离）：

新增端点 `POST /sessions/{id}/tool_results`，body 同上。语义等价。

**建议 tool_call schema 对齐 OpenAI**：

```json
event: tool_call
data: {
  "type": "tool_call",
  "id": "call_abc123",
  "function": {
    "name": "bash",
    "arguments": "{\"command\":\"ls\"}"
  }
}
```

关键点：
- `id` 字段命名用 OpenAI 的 `id`（不用 `callId`），类型和格式对齐
- `arguments` 是 JSON **字符串**（而非直接对象），和 OpenAI Function Calling 一致
- 加 `"type":"tool_call"` 判别字段

### 5.2 P0：澄清 tool-call 的定义协商

**问题**：client 怎么告诉 server "我支持哪些工具，schema 是什么"？

OpenCode 每一轮请求都带动态工具集（因为不同 agent / 不同 skill 开启不同工具）。MedCode 目前没有 `tools` 参数。

**建议**：`POST /sessions/{id}/messages` body 加可选 `tools` 字段，schema 对齐 OpenAI：

```json
{
  "message": "...",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "...",
        "parameters": { /* JSON Schema */ }
      }
    }
  ]
}
```

Server 至少 echo 这些定义给底层模型（或忽略并走自己的工具集，但需要在响应里明示）。

**Phase 2 修订：strict client-defined tools 是产品必需项。**

后续不能只把 `tools[]` 当作 prompt/context，也不能在客户端声明了自定义工具时继续返回未声明的原生 `shell`。严格模式的期望行为是：

- `function.name` 必须逐字匹配当前请求 `tools[]` 中的某个 `function.name`
- `function.arguments` 必须是 JSON string
- `arguments` parse 后必须满足该工具的 `function.parameters` JSON Schema
- 未声明的工具名必须被拒绝、修复或返回结构化错误，不能透传给客户端执行
- 如果客户端只声明 `medevidence`，模型只能返回 `medevidence`，不能返回 `shell`、`bash`、`read_file` 或任何其他名字

示例：

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "medevidence",
        "description": "Answer a medical evidence question.",
        "parameters": {
          "type": "object",
          "properties": {
            "question": { "type": "string" }
          },
          "required": ["question"],
          "additionalProperties": false
        }
      }
    }
  ]
}
```

模型应返回：

```json
{
  "tool_calls": [
    {
      "id": "call_...",
      "type": "function",
      "function": {
        "name": "medevidence",
        "arguments": "{\"question\":\"...\"}"
      }
    }
  ]
}
```

当前 `shell({ command })` 可以作为 Phase 1 tool-result 闭环和 Windows smoke 的 stable 子集，但不能作为最终多工具方案。

### 5.3 P0：完成事件带 usage 信息

**问题**：`completed` 事件只有 `providerSessionRef`。没有 token 用量、finish_reason。

**建议**：

```json
event: completed
data: {
  "type": "completed",
  "provider_session_ref": "...",
  "finish_reason": "stop" | "tool_calls" | "length" | "error",
  "usage": {
    "prompt_tokens": 123,
    "completion_tokens": 456,
    "total_tokens": 579
  }
}
```

字段名全部对齐 OpenAI。Usage 信息对计费、限额显示、UI 里的 token 计数条都是刚需。

### 5.4 P1：system prompt 支持（对应 L2/L3）

**建议**：`POST /sessions/{id}/messages` body 加可选 `system` 字段：

```json
{
  "system": "You are MedCode, a specialized medical AI assistant...",
  "message": "..."
}
```

语义：每轮请求都会替换/覆盖 session 上当前的 system prompt。这样 client 可以在同一 session 里切换 agent（医学 / 编程 / 通用）。

如果希望更保守：只在 session 的第一条消息允许 `system`，后续忽略。我们可以接受这个限制。

### 5.5 P1：SSE 事件形态对齐 OpenAI（对应 L2）

**问题**：目前自定义 `message_delta` / `tool_call` / `completed` / `error` 四种事件。

**建议**：对齐 OpenAI Chat Completions streaming 形态。事件帧体形如：

```text
data: {
  "id": "chatcmpl-...",
  "object": "chat.completion.chunk",
  "created": 1709876543,
  "model": "medcode-code-1",
  "choices": [{
    "index": 0,
    "delta": { "content": "Hello" },
    "finish_reason": null
  }]
}

data: {
  "id": "chatcmpl-...",
  "object": "chat.completion.chunk",
  "choices": [{
    "index": 0,
    "delta": {
      "tool_calls": [{
        "index": 0,
        "id": "call_abc",
        "type": "function",
        "function": { "name": "bash", "arguments": "{\"command\":\"ls\"}" }
      }]
    },
    "finish_reason": null
  }]
}

data: { ..., "choices": [{ "finish_reason": "stop", ... }], "usage": {...} }
data: [DONE]
```

**好处**：
- 所有 OpenAI 客户端库的 SSE 解析器可以直接工作
- ai-sdk 的 `@ai-sdk/openai-compatible` 可以直接解析
- 我们 adapter 代码量从 ~500 行降到 ~200 行

**对你们的成本**：只改序列化层，内部事件结构不变。

### 5.6 P1：提升 concurrentRequests 限额

**问题**：`concurrentRequests=1` 让任何稍微复杂的 agent 流程都会失败：
- OpenCode 的主 loop + 后台 title 生成 + Todo 管理常并发 2-3 条
- `Task` 工具（sub-agent）同时跑多个子 agent
- 用户在 Desktop 里同时开两个 session

**建议**：
- 默认 `concurrentRequests=4`（试用期）
- 提供一个 header 或元数据通道，让接入方标注这次调用是 "primary" 还是 "background" / "sub-agent"，配额可以分池

即使不分池，4 也比 1 实用得多。

### 5.7 P1：明确历史一致性契约

**问题**：OpenCode 的会话历史可以被压缩、编辑、分叉。MedCode server 端的上下文如何对齐？

**建议**：三个最小机制任选一个：

**方案 A（推荐）**：新增 `POST /sessions/{id}/replace_history`，body 类似 OpenAI messages 形态：

```json
{
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

Server 丢弃当前 session 上下文，用这个新历史重新 seed。用于压缩后同步。

**方案 B**：允许 `POST /sessions/{id}/messages` body 带一个 `history_override` 选项，同上语义。

**方案 C**：明文约定"client 应该在历史变化时新建一个 session"。我们可以接受，但希望 session 创建是幂等的 / 低成本的。

### 5.8 P2：`/v1/models` 端点（对应 L1 的一部分）

**建议**：

```http
GET /v1/models
Authorization: Bearer $API_KEY
```

返回当前 key 能用的模型列表，schema 对齐 OpenAI：

```json
{
  "object": "list",
  "data": [
    {
      "id": "medcode-code-1",
      "object": "model",
      "owned_by": "medcode",
      "created": 1709876543
    }
  ]
}
```

即使只返回一个模型也有用，让我们不必硬编码 model ID。

### 5.9 P2：`/v1/chat/completions` 壳（对应 L1 完整）

**建议**：在现有 `/sessions` 形态之外，**额外**提供一个 `POST /v1/chat/completions` 入口。

- 接受标准 OpenAI body（`model` / `messages` / `stream` / `tools` / ...）
- Server 内部仍然使用 session 机制：可以用 `user` 字段或一个扩展 header `X-MedCode-Thread-Id` 做 session 复用 key；或者基于 `messages[]` 的哈希做匿名 session
- 响应走已经在 5.5 里对齐的 OpenAI streaming 形态

做完这个之后：
- MedEvidence 这边**完全不用写 adapter**，`createOpenAICompatible({ baseURL, apiKey })` 一行接入
- Cursor / Cline / Zed AI / Continue / LibreChat / ChatBox / 裸 OpenAI SDK 所有用户零代码接入
- 你们拿到整个 OpenAI 生态做分销

### 5.10 P2：断点恢复（可选）

**问题**：文档明说当前没有，SSE 断线必须重发整条消息。

**建议**：允许 `GET /sessions/{id}/messages/{message_id}/stream?resume_from=<cursor>` 从断点继续。如果复杂度太高，本条可以搁置。

## 6. 对 MedCode 的收益（谈判视角）

别只看接入方的收益，以下这些也是你们自己的核心价值：

1. **生态免费扩张**：L1 完成后，整个 OpenAI SDK 生态（数百个客户端、CLI、IDE 插件、编排工具）直接可以消费 MedCode。不需要你们给每个客户端单独写 SDK。
2. **销售话术简化**：说"OpenAI-compatible + 专业 coding 能力"比"我们是 session-first 非兼容 API"好讲 10 倍。市场教育成本骤降。
3. **接入方故障排查成本下降**：OpenAI 的协议被工具链调烂了 —— curl、Postman、浏览器 devtools、Wireshark、logging middleware 全部都认。你们自己的团队 debug 速度也会提升。
4. **不放弃现有架构优势**：L2 + L3 + 5.7 完成后，你们仍然保留 server 端 context 管理的观测 / 归因 / 限流能力。只是协议外壳变了。
5. **竞品对齐**：当前所有严肃的 LLM provider（OpenAI / Anthropic / Groq / Cerebras / DeepSeek / 阿里 / Moonshot / Mistral / Cohere）都提供 OpenAI-compatible 入口。不提供的话，你们在 enterprise 采购清单里会被直接跳过。

## 7. 对接入方（MedEvidence）代码的影响

| MedCode 采纳范围 | 我们 adapter 代码量 | 主要工作 |
| --- | --- | --- |
| 什么都不改 | ~500-800 行 | 从零设计工具回传协议 / SSE 解析 / session 映射 |
| 仅 P0 (5.1 / 5.2 / 5.3) | ~400-600 行 | SSE 解析和 session 映射仍手写，但 tool 套 ai-sdk 约定 |
| P0 + P1 (含 5.5) | ~200-300 行 | 只剩 session 生命周期 + URL 改写 |
| P0 + P1 + 5.9 | **~50 行配置** | `createOpenAICompatible()` 直接可用 |

## 8. 向后兼容

所有提议均为**新增**，**不破坏**现有 `/sessions` + `/messages` 形态。

- 现有 `message_delta` / `tool_call` / `completed` / `error` SSE 事件可以继续支持，和 5.5 提出的 OpenAI 形态**并存**。可以用 `Accept` header 或新增 `?format=openai` query 参数区分。
- 现有 `POST /sessions/{id}/messages` body `{ "message": "..." }` 形态继续支持；新的 `tool_results` / `system` / `tools` / `history_override` 字段都是可选扩展。
- `/v1/chat/completions` 是**完全独立**的新端点，不影响老接入方。

## 9. 开放问题

留给 MedCode 团队答复：

1. Session 的生命周期和过期策略是什么？长时间（小时 / 天）不活动会被回收吗？
2. `provider_session_ref` 字段是内部 upstream 引用，接入方需要保存吗？出现在什么情况下？
3. 多模态（image / pdf / audio）的路线图？当前 scope 是 `code`，未来会扩展吗？
4. 对 MedEvidence 特定场景（医学证据），是否考虑和 MedEvidence 现有的 gateway (`https://gw.instmarket.com.au` 之外) 做协同？还是保持完全独立的 LLM provider 定位？
5. 计费模型是按 request 还是按 token？5.3 里提议的 usage 字段是否对计费有参考价值？

## 10. 建议的落地节奏

| 阶段 | 内容 | MedCode 工作量（估） | 我们这边工作 |
| --- | --- | --- | --- |
| Phase A | P0 全部（5.1 / 5.2 / 5.3） | 1-2 周 | 并行写 phase 1 adapter |
| Phase B | 5.5（SSE 对齐） + 5.4（system 字段） + 5.6（并发） | 1 周 | adapter 简化到 ~250 行 |
| Phase C | 5.7（历史契约） + 5.8（/v1/models） | 1 周 | 完整的 coding agent 体验上线 |
| Phase D (可选) | 5.9（/v1/chat/completions 壳） | 2-3 周 | 把 adapter 降级为配置 |

---

## 附录 A：完整 OpenAI streaming SSE 参考

（为便于实现对照，粘贴 OpenAI Chat Completions streaming 标准响应格式。）

```text
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1709876543,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1709876543,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1709876543,"model":"gpt-4","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1709876543,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":12,"total_tokens":21}}

data: [DONE]
```

## 附录 B：完整 OpenAI tool-calling 一轮交互参考

Request：
```json
POST /v1/chat/completions
{
  "model": "gpt-4",
  "messages": [
    { "role": "user", "content": "run ls" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Run a shell command",
        "parameters": {
          "type": "object",
          "properties": {
            "command": { "type": "string" }
          },
          "required": ["command"]
        }
      }
    }
  ],
  "stream": true
}
```

Response stream（模型决定调用工具）：
```text
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"bash","arguments":""}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":\"ls\"}"}}]}}]}
data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{...}}
data: [DONE]
```

Follow-up（client 回传工具结果）：
```json
POST /v1/chat/completions
{
  "model": "gpt-4",
  "messages": [
    { "role": "user", "content": "run ls" },
    { "role": "assistant", "tool_calls": [{ "id": "call_abc", "type": "function", "function": { "name": "bash", "arguments": "{\"command\":\"ls\"}" } }] },
    { "role": "tool", "tool_call_id": "call_abc", "content": "file1.txt\nfile2.txt" }
  ],
  "stream": true
}
```

然后模型继续生成最终答复。

在 MedCode 的 session-first 模型下，上面这组交互会变成：
1. `POST /sessions/{id}/messages` body `{ message: "run ls", tools: [...] }` → SSE 收 `tool_call`
2. `POST /sessions/{id}/messages` body `{ tool_results: [{ tool_call_id: "call_abc", output: "file1.txt\nfile2.txt" }] }` → SSE 收 `message_delta` + `completed`

语义完全等价，只是 server 端替我们记住了 `messages[]` 数组。

---

## 附录 C：我们目前的推进意向

- 我们这边会立刻开始基于当前 spec 写 Phase 1 adapter（仅文本对话），用试用 key 验证。
- 一旦 P0 落地，我们切到 tool-calling 路径，把 MedCode 提升为 MedEvidence `medical` agent 的可选后端。
- P0 + P1 完成后，我们对外把 MedCode 作为 Desktop 安装包里的推荐 coding backend 之一。
- 如果 L1（5.9）落地，我们愿意在 MedEvidence 的用户文档和 Release Notes 里特别推广"MedCode 是 OpenAI-compatible 专业 coding provider"。

期待你们的回复。每一条都可以独立接受 / 推迟 / 拒绝 / 反提议。
