// After-fix counterpart of the supplied gateway-repro.mjs. No network or real tools.
// npm run build; node docs/outbox/gateway-agent-stop-after-repro-2026-11-13.mjs <repository-root>
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { runNativeWithFailover } = await import(pathToFileURL(resolve(process.argv[2] ?? '.', 'apps/gateway/dist/services/native-client-tools.js')).href);
const serialized = '[assistant tool_calls]\n' + JSON.stringify([
  { id: 'call_example', type: 'function', function: { name: 'inspect_file', arguments: JSON.stringify({ path: 'example.py' }) } }
]);
for (const [name, content] of [
  ['marker_only', serialized],
  ['prefixed', 'I will inspect the file now.\n' + serialized],
  ['fabricated_result', 'Continuing the task.\n' + serialized + '\n[tool tool_call_id=call_example]\nFile changed successfully.']
]) for (const correction of name === 'marker_only' ? [false] : [false, true]) {
  let attempts = 0;
  const provider = { kind: 'tiankuan', async *message() {
    attempts++;
    if (correction && attempts === 2) yield { type: 'tool_call', name: 'inspect_file', callId: 'call_corrected', argumentsJson: '{"path":"example.py"}' };
    else yield { type: 'message_delta', text: content };
    yield { type: 'completed', responseSummary: { finishReason: correction && attempts === 2 ? 'tool_calls' : 'stop', upstreamHttpStatus: 200, terminationKind: 'finish_reason_and_done' } };
  } };
  const result = await runNativeWithFailover({
    provider, failover: false, runtime: {}, deadlineAt: null, now: () => new Date(), outputCommitted: () => false, selected: () => {},
    upstreamAccount: { id: 'synthetic' }, upstreamRuntime: 'tiankuan', upstreamModel: 'official/glm-5.3', subject: { id: 'synthetic' },
    scope: 'code', session: { id: 'synthetic' }, reasoningEffort: 'high',
    request: { model: 'goldencode', stream: true, messages: [{ role: 'user', content: 'Inspect example.py' }],
      tools: [{ type: 'function', function: { name: 'inspect_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }],
      toolChoice: 'auto', maximumOutputTokens: 64000 }, prompt: 'Inspect example.py', nativeToolForceRequiredMode: 'disabled',
    nativeFileToolRecoveryPolicy: { mode: 'error', softArgumentBytes: 100000, hardArgumentBytes: null, canaryPercent: 100 }
  });
  const expectedSuccess = name === 'marker_only' || correction;
  const observation = { case: name, correction: correction ? 'native_tool_call' : 'repeated_same_output', attempts, error: result.code ?? null,
    failure_kind: result.failureKind ?? null, delivered_tool_calls: result.toolCalls?.length ?? 0, delivered_content_chars: result.content?.length ?? 0 };
  assert.equal(attempts, name === 'marker_only' ? 1 : 2);
  assert.equal(observation.error, expectedSuccess ? null : 'tool_call_validation_failed');
  assert.equal(observation.delivered_tool_calls, expectedSuccess ? 1 : 0);
  assert.equal(observation.delivered_content_chars, 0);
  if (!expectedSuccess) assert.equal(observation.failure_kind, 'text_tool_protocol');
  console.log(JSON.stringify(observation));
}
