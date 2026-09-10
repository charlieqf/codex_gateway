// Experimental identity-only probe: original three fields, no seeds, at most two paid search attempts.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { investigateDoctorIdentity } from "./identity-investigator.js";
import { LiveResearchAdapters } from "./live-adapters.js";
const root = process.cwd();
if (!/^\/tmp\/doctor-research-agent-live-[a-z0-9-]+$/u.test(root)) throw new Error("An isolated live probe root is required.");
const input = JSON.parse(readFileSync(`${root}/input.json`, "utf8"));
if (Object.keys(input).sort().join(",") !== "department,hospital,name") throw new Error("Exactly three original fields are required.");
const { loadResearchWorkerConfig } = await import("/app/apps/research-worker/dist/config.js");
const { GatewayResearchModelClient } = await import("/app/packages/research-agent/dist/model-client.js");
const config = loadResearchWorkerConfig(process.env);
const client = new GatewayResearchModelClient({ ...config.llm,
  bearerToken: readFileSync(config.llm.bearerTokenFile, "utf8").trim(),
  readinessRequirements: { maximumPromptTokensPerCall: 50_000, maximumOutputTokensPerCall: 3_000,
    callsPerRun: 7, maximumTokensPerRun: 350_000 }
});
const signal = AbortSignal.timeout(300_000);
const runId = `drr_${randomUUID().replaceAll("-", "")}`;
let searchRequests = 0;
let legacyCalls = 0;
const modelCalls = [];
const adapters = new LiveResearchAdapters({ ...config.adapterOptions,
  orcid: { enabled: false },
  officialWeb: { ...config.adapterOptions.officialWeb, apiKey: readFileSync(config.webSearchApiKeyFile, "utf8").trim() },
  fetchImpl: (value, init) => {
    const url = new URL(value instanceof Request ? value.url : String(value));
    if (url.hostname !== "serpapi.com" || url.pathname !== "/search.json") throw new Error("Unexpected probe HTTP adapter");
    if (searchRequests >= 2) throw new Error("The two-request live probe budget is exhausted");
    searchRequests++;
    writeFileSync(`${root}/search-ledger.json`, JSON.stringify({ maximum: 2, reserved_requests: searchRequests }), { mode: 0o600 });
    // No application evidence cache; force a fresh provider response for this tiny canary.
    url.searchParams.set("no_cache", "true");
    return fetch(url, init);
  },
  onExternalRequest: event => console.log(JSON.stringify({ event: "external_request", ...event }))
});
adapters.setRunContext(runId);
for (const name of ["searchOfficialSources", "searchSupplementalOfficialSources", "searchOfficialSeedSources", "fetchApprovedSource"]) {
  adapters[name] = async () => { legacyCalls++; throw new Error("Legacy preset discovery must not be invoked"); };
}
const started = Date.now();
console.log(JSON.stringify({ event: "live_identity_started", input, maximum_serpapi_requests: 2 }));
try {
  const result = await investigateDoctorIdentity({ doctor: { ...input, title: null, city: null, orcid: null, officialProfileUrls: [] },
    policy: { maximumSearchRequests: 2, maximumPageRequests: 10, maximumModelCalls: 7, maximumStoredCharacters: 180_000 },
    dependencies: {
      signal,
      search: query => adapters.searchWeb(query, signal),
      read: url => adapters.readWebPage(url, signal),
      save: async state => writeFileSync(`${root}/state.json`, JSON.stringify(state, null, 2), { mode: 0o600 }),
      generate: async request => {
        const start = Date.now();
        const response = await client.generate({ runId, stage: request.role === "identity_reviewer" ? "resolve_identity" : "discover_identity",
          attempt: request.attempt, system: request.system, prompt: request.prompt, signal,
          maximumOutputTokens: 3_000, reasoningEffort: "low", providerTimeoutMs: 45_000 });
        const trace = { role: request.role, attempt: request.attempt, elapsed_ms: Date.now() - start,
          gateway_request_id: response.gatewayRequestId, response_sha256: createHash("sha256").update(response.text).digest("hex"), usage: response.usage };
        modelCalls.push(trace);
        console.log(JSON.stringify({ event: "model_completed", ...trace }));
        return response.text;
      }
    }
  });
  const record = { input, outcome: result.outcome, ...(result.outcome === "resolved" ? { identity: result.identity } : { reason: result.reason }),
    elapsed_ms: Date.now() - started, serpapi_requests: searchRequests, legacy_calls: legacyCalls, model_calls: modelCalls,
    source_count: result.state.pages.length };
  writeFileSync(`${root}/result.json`, JSON.stringify(record, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: "live_identity_completed", ...record }));
} catch (error) {
  const record = { input, outcome: "probe_error", error_name: error?.name, error_code: error?.code ?? null,
    elapsed_ms: Date.now() - started, serpapi_requests: searchRequests, legacy_calls: legacyCalls, model_calls: modelCalls };
  writeFileSync(`${root}/result.json`, JSON.stringify(record, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: "live_identity_completed", ...record }));
}
