// Isolated container only. Real model; synthetic offline search/read tools; zero SerpAPI.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { investigateDoctorIdentity } from "./identity-investigator.js";
const root = process.cwd();
if (!/^\/tmp\/doctor-research-agent-offline-[a-z0-9-]+$/u.test(root)) throw new Error("An isolated offline probe root is required.");
const { loadResearchWorkerConfig } = await import("/app/apps/research-worker/dist/config.js");
const { GatewayResearchModelClient } = await import("/app/packages/research-agent/dist/model-client.js");
const config = loadResearchWorkerConfig(process.env);
const client = new GatewayResearchModelClient({ ...config.llm,
  bearerToken: readFileSync(config.llm.bearerTokenFile, "utf8").trim(),
  readinessRequirements: { maximumPromptTokensPerCall: 25_000, maximumOutputTokensPerCall: 3_000,
    callsPerRun: 6, maximumTokensPerRun: 150_000 }
});
const cases = [
  { id: "different_people_on_same_page", expected: "unresolved",
    name: "Alice Example", hospital: "Example University Hospital", department: "Cardiology",
    text: "Example University Hospital official current staff directory.\nAlice Example: Department of Nephrology.\nBob Example: Department of Cardiology." },
  { id: "cross_language_identity", expected: "resolved",
    name: "Simone Example", hospital: "港湾大学医院", department: "内分泌科",
    text: "Harbour University Hospital\nOfficial staff directory\nDepartment of Endocrinology\nSimone Example\nConsultant endocrinologist\nSimone Example is a consultant in Endocrinology at Harbour University Hospital. This is the hospital's current staff profile." }
];
const results = [];
let batchModelCalls = 0;
for (const target of cases) {
  const runId = `drr_${randomUUID().replaceAll("-", "")}`;
  const signal = AbortSignal.timeout(240_000);
  const started = Date.now();
  let offlineSearches = 0, offlineReads = 0;
  const modelCalls = [];
  const source = { sourceId: "src_synthetic_official", url: "https://hospital.example/current-staff", title: "Current staff directory",
    accessedAt: new Date().toISOString(), contentSha256: createHash("sha256").update(target.text).digest("hex"), untrustedText: target.text, navigationLinks: [] };
  console.log(JSON.stringify({ event: "case_started", case_id: target.id, serpapi_requests: 0 }));
  let outcome;
  try {
    const result = await investigateDoctorIdentity({ doctor: { name: target.name, hospital: target.hospital, department: target.department,
      title: null, city: null, orcid: null, officialProfileUrls: [] },
      policy: { maximumSearchRequests: 2, maximumPageRequests: 2, maximumModelCalls: 6, maximumStoredCharacters: 20_000 },
      dependencies: {
        signal,
        search: async () => { offlineSearches++; return [{ url: source.url, title: source.title, snippet: "Current staff directory" }]; },
        read: async url => { offlineReads++; if (url !== source.url) throw new Error("Unknown offline URL"); return source; },
        save: async state => writeFileSync(`${root}/${target.id}-state.json`, JSON.stringify(state, null, 2), { mode: 0o600 }),
        generate: async request => {
          if (++batchModelCalls > 12) throw new Error("Offline model batch budget exceeded");
          const start = Date.now();
          const response = await client.generate({ runId,
            stage: request.role === "identity_reviewer" ? "resolve_identity" : "discover_identity",
            attempt: request.attempt, system: request.system, prompt: request.prompt, signal,
            maximumOutputTokens: 3_000, reasoningEffort: "low", providerTimeoutMs: 45_000 });
          const trace = { role: request.role, attempt: request.attempt, elapsed_ms: Date.now() - start,
            request_id: response.gatewayRequestId, response_sha256: createHash("sha256").update(response.text).digest("hex"), usage: response.usage };
          modelCalls.push(trace);
          console.log(JSON.stringify({ event: "model_completed", case_id: target.id, ...trace }));
          return response.text;
        }
      }
    });
    outcome = { outcome: result.outcome, ...(result.outcome === "unresolved" ? { reason: result.reason } : { identity: result.identity }),
      expected: target.expected, matched_expectation: result.outcome === target.expected };
  } catch (error) { outcome = { outcome: "probe_error", error_name: error?.name, error_code: error?.code ?? null, expected: target.expected, matched_expectation: false }; }
  const record = { case_id: target.id, ...outcome, elapsed_ms: Date.now() - started, offline_searches: offlineSearches,
    offline_reads: offlineReads, serpapi_requests: 0, model_calls: modelCalls };
  results.push(record);
  writeFileSync(`${root}/results.json`, JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: "case_completed", ...record }));
}
