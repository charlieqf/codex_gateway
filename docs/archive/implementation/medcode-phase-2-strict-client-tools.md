# MedCode Phase 2: Strict Client-Defined Tools

Last updated: 2026-04-23

## Decision

MedCode must support strict client-defined tool calling before it can be a full
OpenCode/MedEvidence coding-agent backend.

The current `shell({ command })` path is only a Phase 1 compatibility and
Windows smoke path. It validates the tool-result loop, but it does not satisfy
the product requirement that users can enable arbitrary OpenCode tools such as
`medevidence`, `search`, `read_file`, `edit`, MCP-backed tools, or future
agent-specific tools.

## Required Behavior

When a client sends OpenAI-style tools:

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

MedCode must return tool calls using the client-defined tool name and argument
schema:

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

Strict mode requirements:

- `function.name` must exactly match one of the names in the current request's
  `tools[]`.
- `function.arguments` must be a JSON string.
- Parsed arguments must satisfy that tool's `parameters` JSON Schema.
- `tool_choice` must be honored when provided:
  - `"auto"` allows either a final message or tool calls.
  - `"none"` disables client-defined tool calling for that request.
  - `"required"` requires at least one schema-valid client-declared tool call.
  - `{ "type": "function", "function": { "name": "..." } }` requires that
    exact client-declared tool name.
- A tool not declared by the client must not be emitted.
- If validation fails, the gateway must not forward the invalid tool call as if
  it were valid. It may retry/repair internally or return a structured error.
- In strict client-tools mode, native `shell` observations must not leak into
  the OpenAI-compatible response unless the client explicitly declared a
  compatible `shell` tool.

## Current Implementation

The gateway now enters strict mode whenever `/v1/chat/completions` receives a
non-empty `tools[]` array.

Current implementation:

1. Parses and validates OpenAI function tool definitions.
2. Builds a per-request tool registry keyed by `function.name`.
3. Parses and validates `tool_choice`, including named tool choices against the
   current request's `tools[]`.
4. Prompts the upstream model to return a strict JSON envelope:
   - `{ "type": "message", "content": "..." }`
   - `{ "type": "tool_calls", "tool_calls": [...] }`
5. Validates model-selected tool names against the client registry and the
   requested `tool_choice`.
6. Validates model-produced arguments against the matching JSON Schema using
   Ajv.
7. Performs one repair attempt if the first strict output is invalid.
8. Records sanitized validation telemetry through gateway logs and request
   observations. Logs include request id, error code, validation summary, and
   repair state; they do not include tool arguments, full model output, prompts,
   API keys, or Authorization headers.
9. Returns validated calls in OpenAI Chat Completions `tool_calls` shape.
10. Ignores native provider tool-call observations in strict mode so undeclared
   native tools do not leak to the client.
11. When `tool_choice` is `"none"`, bypasses strict client-tools mode and does
    not return upstream native tool calls to the OpenAI-compatible client.

## Non-Goals

Phase 2 is not:

- A Windows shell compatibility project.
- A larger native MedCode tool registry.
- A replacement for OpenCode's local tool executors.
- A promise that server-side tool execution is enabled.

OpenCode remains responsible for executing the tool locally and returning
`role: "tool"` results. MedCode is responsible for selecting among the
client-declared tools and producing schema-valid calls.

## SDK Gap

The current gateway package uses `@openai/codex-sdk@0.122.0`. Its current
TypeScript boundary exposes `TurnOptions.outputSchema`, `TurnOptions.signal`,
and thread options such as model, sandbox, working directory, web search, and
approval policy. It does not expose a dynamic `tools[]` or `onToolCall`
registration API.

Because of that, strict client-defined tools cannot be implemented by simply
passing OpenAI `tools[]` through the current SDK call. The gateway implements a
strict envelope plus validation layer until a lower-level dynamic tool
registration API is available.

## Streaming Behavior

Phase 2 initially returns a complete tool call in one streaming chunk. It does
not stream partial `function.arguments` deltas yet.

Required streaming shape:

```text
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_...","type":"function","function":{"name":"medevidence","arguments":"{\"question\":\"...\"}"}}]},"finish_reason":null}]}
data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
data: [DONE]
```

## Relationship To Phase 1 Shell Smoke

The Phase 1 `shell({ command })` contract remains useful for:

- validating the OpenAI-compatible tool-call envelope,
- validating Windows local execution through OpenCode,
- validating tool result history,
- validating failure feedback loops.

It is not sufficient for the final product because it only supports one native
tool. In strict mode, `shell` is treated like any other client-declared tool. If
a client does not declare `shell`, MedCode must not emit `shell`.

## Acceptance Criteria

Phase 2 is complete when these pass:

1. A request that declares only `medevidence(question: string)` can produce a
   `medevidence` tool call with schema-valid arguments.
2. The same request cannot produce `shell`, `bash`, or any undeclared tool name.
3. A request declaring multiple tools can produce any declared tool, preserving
   exact names.
4. Invalid model tool arguments are repaired once or rejected before forwarding
   to the client.
5. Tool result history using `role: "tool"` lets the model continue and produce
   a final answer.
6. Streaming and non-streaming responses both preserve OpenAI-compatible
   `tool_calls` shape and `finish_reason: "tool_calls"`.
7. The Phase 1 `shell` smoke still passes when the client explicitly declares a
   compatible `shell` tool.
8. `tool_choice` supports `"none"`, `"required"`, and named function choices.
9. Strict validation failures are visible in request observations with
   `errorCode = "tool_call_validation_failed"` and sanitized gateway logs.
