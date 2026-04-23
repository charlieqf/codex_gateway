# MedCode Windows Tool-Call Smoke

Last updated: 2026-04-23

## Purpose

Validate the first OpenCode Windows integration for MedCode client-side tool
calling. The target path is:

```text
MedCode assistant tool_call(shell) -> OpenCode local Shell executor -> role: "tool" result -> MedCode final answer
```

This smoke is scoped to the stable MedCode native tool subset:

```json
{
  "function.name": "shell",
  "arguments_after_json_parse": {
    "command": "string"
  },
  "status": "stable"
}
```

Do not use this smoke to validate future native tools, MCP bridge behavior,
sub-agents, or concurrent background tasks.

## Test Build Requirements

OpenCode test build must have:

- MedCode provider `tool_call` enabled behind a test flag or branch.
- `function.name = "shell"` mapped to the existing OpenCode Shell executor.
- Windows shell discovery using the existing priority order, with Git Bash
  preferred when available.
- Minimal normalization for these wrapping forms:
  - `/usr/bin/bash -lc "..."`
  - `/bin/bash -lc "..."`
  - `bash -lc "..."`
- Fallback to the original command when normalization is uncertain.
- No pre-emptive blocking of Linux-only paths such as `/app` in the first
  pass; return the real shell failure as tool output.
- Tool results returned in fixed sections:

```text
command:
...
exit_code:
...
stdout:
...
stderr:
...
```

Large `stdout` or `stderr` values may be truncated, but the result must say
that truncation happened.

## Environment Statement

Append this to each MedCode provider request after the local agent system
prompt. It should not replace any server-side safety constraints.

```text
Tool calls are executed client-side by OpenCode in the user's local workspace.
The user environment is Windows, usually with Git Bash compatibility. Do not
assume server paths such as /app, /tmp, /usr/bin/bash, or sandbox-only tools.
Prefer commands that work in the local workspace.
```

If the local executor is known to be PowerShell-only, replace the Git Bash
sentence with the actual executor description.

## Tester Setup

Use a disposable or clean Windows workspace. A JavaScript/TypeScript repository
with `package.json` and Git history is preferred because it exercises common
coding-agent commands.

Before testing:

```powershell
git status --short
git --version
node --version
npm --version
```

If Git Bash discovery is expected, also record one of:

```powershell
where git
echo $env:OPENCODE_GIT_BASH_PATH
```

Do not paste API keys, full Authorization headers, private source snippets, or
provider auth files into the smoke log.

## Pass Criteria

The smoke passes when all required cases pass:

- MedCode emits OpenAI-shaped assistant `tool_calls` with
  `function.name = "shell"`.
- OpenCode parses `function.arguments` as JSON and extracts a required string
  `command`.
- Windows execution does not fail only because `/usr/bin/bash` does not exist.
- Tool results include `command`, `exit_code`, `stdout`, and `stderr`.
- The next MedCode turn consumes the tool result and produces a normal final
  answer.
- A real failing command returns failure details to the model and does not get
  converted into final assistant text as if it were successful.

Abort the smoke if every tool call fails before reaching the local executor, if
the provider stops returning `tool_calls`, or if API authentication/rate limits
make the results impossible to interpret.

## Required Cases

### WTC-001: Baseline Text

Prompt:

```text
Reply in one sentence: MedCode Windows smoke is ready.
Do not call tools.
```

Expected result:

- No tool call.
- One normal assistant response.

### WTC-010: Directory Inspection

Prompt:

```text
Use the shell tool to inspect the current workspace directory, then summarize
the top-level files in one short paragraph.
```

Expected result:

- At least one `shell` tool call.
- Command may use `pwd`, `ls`, `git status`, or equivalent local shell
  commands.
- Tool result has all four fixed sections.
- Final answer summarizes the local workspace, not `/app` or another server
  path.

### WTC-020: Git Status

Prompt:

```text
Use the shell tool to run git status --short in the current workspace and
summarize whether there are local changes.
```

Expected result:

- Tool call command is `git status --short` or an equivalent wrapped form.
- Exit code is `0`.
- Final answer accurately reflects the returned status.

### WTC-030: Package Scripts

Prompt:

```text
Use the shell tool to inspect package.json and list the available npm scripts.
If package.json is missing, say that after checking with the shell tool.
```

Expected result:

- Tool call reads or inspects `package.json`.
- Exit code is `0` when `package.json` exists.
- Final answer lists scripts from the actual tool output.

### WTC-040: Bash Wrapper Normalization

Prefer a provider-level or executor-level synthetic test for this case. Inject
or force the exact tool call:

```json
{
  "id": "call_smoke_bash_lc",
  "type": "function",
  "function": {
    "name": "shell",
    "arguments": "{\"command\":\"/usr/bin/bash -lc \\\"git status --short\\\"\"}"
  }
}
```

Expected result:

- OpenCode normalizes the wrapper to the inner command when it can parse it
  confidently.
- The command reaches the local Shell executor.
- The run does not fail because `C:\usr\bin\bash` or `/usr/bin/bash` is absent.
- If normalization cannot parse the command safely, OpenCode falls back to the
  original command and records that fallback.

If no synthetic harness is available, use this prompt:

```text
For this smoke test, call the shell tool with this exact command:
/usr/bin/bash -lc "git status --short"
Then summarize the result.
```

### WTC-050: Linux-Only Path Feedback

Prompt:

```text
Use the shell tool to check whether /app exists. If that fails, use the shell
tool again to inspect the actual current workspace path and explain the
difference.
```

Expected result:

- OpenCode does not pre-block `/app`.
- The real failure result is returned through `role: "tool"`.
- The model uses the failure to correct itself and inspect the actual
  workspace.
- Final answer does not present `/app` as the user's workspace unless it really
  exists.

### WTC-060: Structured Failure Result

Prompt:

```text
Use the shell tool to run a command that exits with code 7 and writes
smoke-error to stderr. Then explain the exit code and stderr.
```

Expected result:

- Tool result includes non-zero `exit_code`.
- `stderr` contains `smoke-error`.
- Final answer clearly says the command failed and cites the exit code.

### WTC-070: Follow-Up Uses Tool History

After WTC-020 or WTC-030, ask:

```text
Based only on the tool result you just received, give the concise conclusion
again without running another command.
```

Expected result:

- No new tool call unless the previous result is missing or ambiguous.
- The answer uses the prior tool result correctly.

## Optional Case

### WTC-080: Safe Temporary File Round Trip

Only run this in a disposable workspace.

Prompt:

```text
Use the shell tool to create .medcode-smoke-temp.txt containing medcode-smoke,
read it back, then delete it. Summarize whether the round trip succeeded.
```

Expected result:

- File is created, read, and removed.
- Final answer confirms success from the actual command output.
- Final `git status --short` does not show the temporary file.

## Result Log Template

Use this template for each run:

```text
Date/time:
Tester:
OpenCode build/commit:
MedCode provider flag:
Windows version:
Shell backend observed:
Git Bash path source: auto / OPENCODE_GIT_BASH_PATH / unavailable
Workspace type:
Gateway base URL:
Credential prefix only:

Case results:
- WTC-001:
- WTC-010:
- WTC-020:
- WTC-030:
- WTC-040:
- WTC-050:
- WTC-060:
- WTC-070:
- WTC-080 optional:

Failed commands:
- command:
  exit_code:
  stderr summary:
  request id:

Notes:
```

## Report Back

Send only sanitized findings:

- OpenCode build/commit.
- Windows version.
- Observed shell backend.
- Credential prefix, not the full API key.
- Request ids for failed gateway requests.
- Tool call command strings when they do not contain private paths or source.
- Summaries of stdout/stderr, with private project content redacted.

Do not send full API keys, Authorization headers, provider auth files, or
private source files.
