# TianKuan GLM-5.3 180-Second Causal-Control Fixtures

This directory contains the frozen, synthetic task definitions for the
low-cost Tencent/TianKuan GLM-5.3 causal check that precedes the deferred
two-hour benchmark. It measures latency and stream integrity; it is not an
intelligence or coding benchmark.

Files:

- `manifest.json`: expected counts, provider IDs and hard budgets;
- `tasks.jsonl`: four unique cases, each intended to run once per provider;
- `scripts/lib/glm53-quick-gate-tasks.mjs`: loader and deterministic synthetic
  context materializer;
- `scripts/validate-glm53-quick-gate-tasks.mjs`: offline validation entrypoint.

Validation is local and does not contact either provider:

```powershell
npm run validate:glm53-quick-gate
```

The task set contains no production prompts, user identities or credentials.
Long and medium contexts are generated from fixed seeds and synthetic facts.
The validator prints fixture hashes so an executed run can pin the exact task
version without storing sensitive provider configuration.

The four cases form three comparisons while sharing one long-input baseline:

1. short/high/stream versus long/high/stream isolates input size;
2. long/low/stream versus long/high/stream isolates reasoning effort;
3. long/high/stream versus the identical non-stream request isolates transport.

Exact marker assertions only reject empty, truncated or malformed responses.
They are transport sanity checks and must not be reported as model quality
scores.

This is a task set, not an execution harness. A future runner must enforce the
manifest's time, token and monetary limits. Direct adapter execution is the
preferred attribution path. If the public Gateway is used, the runner must
force the intended sticky member, reject samples with more than one upstream
attempt, verify actual provider attribution, and exclude samples rerouted by a
provider cooldown.
