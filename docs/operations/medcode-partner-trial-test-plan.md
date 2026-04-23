# MedCode Partner Trial Test Plan

Last updated: 2026-04-23

This checklist is for MedEvidence, OpenCode CLI, and OpenCode Desktop teams
testing the current MedCode public controlled-trial gateway.

Use this public endpoint:

```text
baseURL: https://gw.instmarket.com.au/v1
model: medcode
```

Operators will provide each team an API key through a private channel. Logs,
screenshots, issue reports, and chat messages must include only the API key
prefix, never the full key or Authorization header.

## Common Requirements

All clients should:

- Use OpenAI Chat Completions shape: `POST /v1/chat/completions`.
- Send `model: "medcode"`.
- Preserve assistant `tool_calls` and send tool outputs back as
  `{ "role": "tool", "tool_call_id": "...", "content": "..." }`.
- Treat tool execution as client-side work in the user's local environment.
- Capture `X-Request-Id` for every failure.
- Avoid testing against `http://4.242.58.89`; use the dedicated gateway
  hostname only.

Do not send:

- Full API keys or Authorization headers.
- Private source code.
- Full tool stdout/stderr if it contains private paths, source, PHI, or secrets.
- Provider auth files or browser tokens.

## MedEvidence Team

Goal: verify MedCode can call MedEvidence as a client-defined tool, consume the
tool result, and produce a final answer without relying on native `shell`.

### ME-001: Basic Text

Request:

```json
{
  "model": "medcode",
  "messages": [
    {
      "role": "user",
      "content": "Reply exactly: medcode-medevidence-text-ok"
    }
  ],
  "tool_choice": "none"
}
```

Expected:

- HTTP `200`.
- `choices[0].finish_reason` is `stop`.
- No `message.tool_calls`.
- Response content contains `medcode-medevidence-text-ok`.

### ME-010: MedEvidence Tool Call

Request:

```json
{
  "model": "medcode",
  "messages": [
    {
      "role": "user",
      "content": "Use the medevidence tool before answering. Ask exactly: What evidence supports aspirin after myocardial infarction?"
    }
  ],
  "tool_choice": "required",
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

Expected:

- HTTP `200`.
- `choices[0].finish_reason` is `tool_calls`.
- First tool call has `function.name = "medevidence"`.
- `function.arguments` parses as JSON.
- Parsed arguments contain a string `question`.
- Parsed arguments do not contain `command`, `shell`, or undeclared fields.

### ME-020: Tool Result Follow-Up

After ME-010, execute the MedEvidence tool in the client/backend, then send a
follow-up request containing the original user message, the assistant
`tool_calls`, and the tool result:

```json
{
  "model": "medcode",
  "messages": [
    {
      "role": "user",
      "content": "Use the medevidence tool before answering. Ask exactly: What evidence supports aspirin after myocardial infarction?"
    },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_from_previous_response",
          "type": "function",
          "function": {
            "name": "medevidence",
            "arguments": "{\"question\":\"What evidence supports aspirin after myocardial infarction?\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_from_previous_response",
      "content": "A redacted MedEvidence observation summary goes here."
    },
    {
      "role": "user",
      "content": "Based only on the tool result, give a concise final answer. Do not call tools."
    }
  ],
  "tool_choice": "none",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "medevidence",
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

Expected:

- HTTP `200`.
- `finish_reason` is `stop`.
- No new `tool_calls`.
- Final answer reflects the tool observation, not an invented result.

### ME-030: Named Tool Choice

Send both `medevidence` and another declared tool such as `search_evidence`,
then force `search_evidence`:

```json
{
  "tool_choice": {
    "type": "function",
    "function": { "name": "search_evidence" }
  }
}
```

Expected:

- Returned tool call name is exactly `search_evidence`.
- A call to `medevidence`, `shell`, or `bash` is a failure for this case.

## OpenCode CLI Team

Goal: verify the CLI can use MedCode as an OpenAI-compatible model with both
Windows shell execution and strict client-defined tools.

Use a disposable Windows workspace with a small repository. Before testing,
record:

```powershell
git status --short
git --version
node --version
npm --version
where git
echo $env:OPENCODE_GIT_BASH_PATH
```

### CLI-001: Provider Wiring

Expected setup:

- Base URL is `https://gw.instmarket.com.au/v1`.
- Model is exactly `medcode`.
- API key is read from secure local config or environment.
- Logs display only the credential prefix or a redacted key.

Prompt:

```text
Reply exactly: medcode-opencode-cli-text-ok. Do not call tools.
```

Expected:

- No tool call.
- Final response contains `medcode-opencode-cli-text-ok`.

### CLI-010: Native Shell Loop

Prompt:

```text
Use the shell tool to run git status --short in the current workspace, then
summarize whether there are local changes.
```

Expected:

- Assistant emits a `shell` tool call when the CLI declares or maps shell.
- `function.arguments` parses as JSON with required string `command`.
- The command reaches the local Shell executor on Windows.
- Tool result content contains fixed sections:

```text
command:
exit_code:
stdout:
stderr:
```

- Final answer uses the tool output.

### CLI-020: Bash Wrapper Normalization

Force or prompt this exact command:

```text
/usr/bin/bash -lc "git status --short"
```

Expected:

- CLI normalization strips confident `bash -lc` wrappers.
- Execution does not fail merely because `/usr/bin/bash` does not exist on
  Windows.
- If parsing is uncertain, the original command is executed and the real
  failure is returned to the model.

### CLI-030: Strict Client Tools

Configure the CLI to send client-defined tools rather than relying on native
MedCode tools. At minimum, declare:

```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "parameters": {
      "type": "object",
      "properties": {
        "path": { "type": "string" }
      },
      "required": ["path"],
      "additionalProperties": false
    }
  }
}
```

Prompt:

```text
Use the read_file tool to inspect package.json, then list the available npm
scripts. If package.json is missing, say that after using the tool.
```

Expected:

- Tool call name exactly matches `read_file`.
- Arguments match the CLI-provided schema.
- CLI executes the local tool and returns a `role: "tool"` result.
- Final answer uses the tool result.

### CLI-040: Failure Feedback

Prompt:

```text
Use a tool to check whether /app exists. If it fails, inspect the actual current
workspace path and explain the difference.
```

Expected:

- CLI does not pre-block `/app`.
- The real local failure is returned as tool output.
- Model self-corrects and inspects the current workspace.

## OpenCode Desktop Team

Goal: verify the same protocol works through the Desktop UI, including user
visibility, cancellation, and redacted logs.

Use a clean Windows workspace opened in the Desktop app.

### DESK-001: Configuration UX

Expected:

- User can select MedCode / `medcode`.
- Base URL is `https://gw.instmarket.com.au/v1`.
- API key is stored in the app's secure credential path.
- UI never renders the full key after saving.

### DESK-010: Text And Streaming

Prompt:

```text
Reply exactly: medcode-opencode-desktop-stream-ok. Do not call tools.
```

Expected:

- Streaming text appears normally.
- Final content contains `medcode-opencode-desktop-stream-ok`.
- No tool UI is shown.
- Cancel/stop works during a longer response without freezing the UI.

### DESK-020: Tool Approval And Result Display

Prompt:

```text
Use the shell tool to inspect package.json and summarize the scripts.
```

Expected:

- Tool call is shown with the exact command or client tool name.
- If Desktop has approval gates, the user can approve or deny the call.
- Tool result is visible enough for the user to understand success/failure.
- Long output is truncated with an explicit truncation marker.
- Final answer is based on the actual tool result.

### DESK-030: Strict Client Tools UI

Run the same scenario as CLI-030 with a Desktop-declared local tool such as
`read_file`, `search`, or `medevidence`.

Expected:

- MedCode returns the exact Desktop-declared `function.name`.
- The UI routes the call to the matching local tool.
- A mismatched or undeclared tool name is surfaced as an integration failure,
  not executed as a fallback shell command.

### DESK-040: Error Surface

Trigger one controlled failure, such as an invalid path or a non-zero shell
exit.

Expected:

- UI shows the tool failure as a tool result.
- Final answer states that the tool failed.
- Logs include `X-Request-Id`, HTTP status, and error code when available.
- Logs do not include API keys, private source, or full Authorization headers.

## Cross-Team Pass Criteria

The trial is considered ready for broader internal use only if all are true:

- Text completions work in MedEvidence, OpenCode CLI, and Desktop.
- Strict client-defined tools return exact client-declared names and
  schema-valid arguments.
- `tool_choice: "none"` prevents tool calls.
- `tool_choice: "required"` and named function choice work.
- Tool result follow-up works with `role: "tool"`.
- Windows shell execution works through OpenCode without `/usr/bin/bash` path
  failures.
- Real tool failures are returned to the model and not presented as successful
  answers.
- No client logs or UI surfaces leak full API keys or private credentials.

## Report Template

Send this sanitized report for each test run:

```text
Team:
Client: MedEvidence / OpenCode CLI / OpenCode Desktop
Client version or commit:
OS and version:
Workspace type:
Gateway base URL:
Model:
Credential prefix only:
Date/time and timezone:

Cases:
- ME-001:
- ME-010:
- ME-020:
- ME-030:
- CLI-001:
- CLI-010:
- CLI-020:
- CLI-030:
- CLI-040:
- DESK-001:
- DESK-010:
- DESK-020:
- DESK-030:
- DESK-040:

Failures:
- Case:
  X-Request-Id:
  HTTP status:
  error.code:
  finish_reason:
  tool_call name:
  sanitized arguments shape:
  sanitized stdout/stderr summary:
  expected:
  actual:

Notes:
```

