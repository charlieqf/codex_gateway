// Fresh original input, real adapters/model, isolated SQLite and artifacts. No public API claim.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createResearchSqliteStore } from "/app/packages/store-sqlite/dist/research-store.js";
import { executeDoctorResearchWorkflow } from "/app/packages/research-agent/dist/workflow.js";
import { GatewayResearchModelClient, researchModelCallTelemetryFromError } from "/app/packages/research-agent/dist/model-client.js";
import { LiveResearchAdapters } from "/app/packages/research-agent/dist/live-adapters.js";
import { loadResearchWorkerConfig } from "/app/apps/research-worker/dist/config.js";
import { loadMedicalSkillBundle } from "/app/packages/research-agent/dist/medical-skill-bundle.js";
import { assertReviewedReviewContractPolicy } from "/app/packages/research-agent/dist/review-contract-policy.js";
const root = process.cwd();
if (!/^\/tmp\/doctor-research-agent-workflow-live-[a-z0-9-]+$/u.test(root)) throw new Error("Isolated workflow probe root required.");
const limits = existsSync(`${root}/probe-limits.json`) ? JSON.parse(readFileSync(`${root}/probe-limits.json`, "utf8")) : { maximum_serpapi_requests: 2 };
if (Object.keys(limits).join(",") !== "maximum_serpapi_requests" || ![0, 1, 2].includes(limits.maximum_serpapi_requests)) throw new Error("Invalid isolated probe search limit.");
const maximumSerpRequests = limits.maximum_serpapi_requests;
const replay = existsSync(`${root}/diagnostic-replay.json`) ? JSON.parse(readFileSync(`${root}/diagnostic-replay.json`, "utf8")) : null;
if ((replay !== null) !== (maximumSerpRequests === 0)) throw new Error("A diagnostic replay must disable paid search; a fresh probe must declare a search budget.");
const original = JSON.parse(readFileSync(`${root}/input.json`, "utf8"));
if (Object.keys(original).sort().join(",") !== "department,hospital,name") throw new Error("Exactly the original three fields are required.");
const medicalSkillBundle = loadMedicalSkillBundle(process.env.RESEARCH_MEDICAL_SKILL_ROOT ?? "/app/docs/research/采访skill");
assertReviewedReviewContractPolicy(medicalSkillBundle.digest);
const config = loadResearchWorkerConfig({ ...process.env,
  RESEARCH_IDENTITY_AGENT_ENABLED: "true", RESEARCH_IDENTITY_MAX_SEARCH_REQUESTS: String(Math.max(1, maximumSerpRequests)),
  RESEARCH_IDENTITY_MAX_PAGE_REQUESTS: "12", RESEARCH_IDENTITY_MAX_MODEL_CALLS: "8",
  RESEARCH_EVIDENCE_MAX_SEARCH_REQUESTS: "4", RESEARCH_EVIDENCE_MAX_PUBLICATION_REQUESTS: "50",
  RESEARCH_EVIDENCE_MAX_PAGE_REQUESTS: "4", RESEARCH_EVIDENCE_MAX_MODEL_CALLS: "12",
  RESEARCH_MAX_LLM_CALLS_PER_RUN: "29", RESEARCH_MAX_INPUT_TOKENS_PER_CALL: "40000",
  RESEARCH_MAX_OUTPUT_TOKENS_PER_CALL: "17000",
  RESEARCH_MAX_INPUT_TOKENS_PER_RUN: "1000000", RESEARCH_MAX_OUTPUT_TOKENS_PER_RUN: "300000",
  RESEARCH_MAX_EXTERNAL_REQUESTS_PER_RUN: "1000", RESEARCH_MAX_EXTERNAL_BYTES_PER_RUN: "2000000000",
  RESEARCH_MAX_CHECKPOINT_BYTES: "1000000", RESEARCH_MAX_PUBLICATIONS: "40",
  RESEARCH_DOCTOR_LOOKUP_BRIEF_ENABLED: "false", RESEARCH_SYNTHESIS_SHARD_COUNT: "3"
});
const signal = AbortSignal.timeout(600_000);
const hash = value => createHash("sha256").update(value).digest("hex");
const save = (name, value) => writeFileSync(`${root}/${name}.json`, JSON.stringify(value, null, 2), { mode: 0o600 });
const input = { doctor: { ...original, title: null, city: null, orcid: null, officialProfileUrls: [] },
  mode: "brief", language: "zh-CN", options: { publicationYears: 5, citationStyle: "vancouver" }, clientReference: null };
const store = createResearchSqliteStore({ path: `${root}/research.db`, ...config.store,
  limits: { dailyRunsPerSubject: 2, uniqueDoctors30dPerSubject: 2, globalActiveRuns: 2, needsInputPerSubject: 2 } });
const now = new Date();
const created = store.createRun({ subjectId: "subj_isolated_workflow_probe", credentialId: "cred_isolated_workflow_probe",
  requestId: "req_isolated_workflow_probe", idempotencyKey: "research:isolated-workflow-probe",
  requestHash: hash(JSON.stringify(input)), identityFingerprint: hash(JSON.stringify(original)), input, now });
if (created.outcome !== "created") throw new Error("Fresh isolated run was not created.");
let lease = store.acquireLease({ workerId: "isolated-workflow-probe", leaseSeconds: 120, now });
if (!lease) throw new Error("Isolated lease unavailable.");
if (replay) {
  if (!/^[a-f0-9]{64}$/u.test(replay.origin_archive_sha256) || !Array.isArray(replay.checkpoints) || ![2, 3].includes(replay.checkpoints.length) ||
      new Set(replay.checkpoints.map(c => c.stage)).size !== replay.checkpoints.length ||
      !["discover_identity", "collect_profile_evidence"].every(stage => replay.checkpoints.some(c => c.stage === stage))) throw new Error("Invalid diagnostic replay provenance.");
  for (const checkpoint of replay.checkpoints) {
    if (!["discover_identity", "collect_profile_evidence", "synthesize_review"].includes(checkpoint.stage) || hash(JSON.stringify(checkpoint.payload)) !== checkpoint.payload_sha256) throw new Error("Invalid diagnostic replay state.");
    const written = store.writeAgentState({ token: lease.token, stage: checkpoint.stage, progressPercent: 7,
      payload: checkpoint.payload, payloadSha256: checkpoint.payload_sha256, now });
    if (written.outcome !== "written") throw new Error("Diagnostic state could not be written.");
  }
}
let renewError = null;
const timer = setInterval(() => {
  try {
    const renewed = store.renewLease({ token: lease.token, leaseSeconds: 120 });
    if (renewed.outcome !== "renewed") throw new Error("Isolated lease renewal failed.");
    Object.assign(lease.token, renewed.token);
  } catch (error) { renewError = error?.name ?? "Error"; }
}, 30_000);
let serpRequests = 0, legacyCalls = 0, modelRequests = 0;
const modelCalls = [], validationFailures = [], externalCalls = [], budgetFailures = [];
const client = new GatewayResearchModelClient({ ...config.llm,
  bearerToken: readFileSync(config.llm.bearerTokenFile, "utf8").trim(),
  readinessRequirements: { maximumPromptTokensPerCall: config.workflowPolicy.maximumInputTokensPerCall,
    maximumOutputTokensPerCall: config.workflowPolicy.maximumOutputTokensPerCall, callsPerRun: 29, concurrentCalls: 3,
    maximumTokensPerRun: 1_300_000 }
});
const adapters = new LiveResearchAdapters({ ...config.adapterOptions, orcid: { enabled: false },
  ncbi: { ...config.adapterOptions.ncbi, ...(config.ncbiApiKeyFile ? { apiKey: readFileSync(config.ncbiApiKeyFile, "utf8").trim() } : {}) },
  officialWeb: { ...config.adapterOptions.officialWeb, apiKey: readFileSync(config.webSearchApiKeyFile, "utf8").trim() },
  fetchImpl: (value, init) => {
    const url = new URL(value instanceof Request ? value.url : String(value));
    if (url.hostname === "serpapi.com") {
      if (url.pathname !== "/search.json" || serpRequests >= maximumSerpRequests) throw new Error("Probe SerpAPI hard cap reached.");
      serpRequests++; save("search-ledger", { maximum: maximumSerpRequests, reserved_requests: serpRequests });
      // Preserve the provider's normal cache behavior. A fresh service run has
      // no seeded person data; forcing paid cache bypass adds no such guarantee.
    } else if (!["eutils.ncbi.nlm.nih.gov", "api.crossref.org"].includes(url.hostname)) throw new Error("Unexpected JSON adapter host.");
    return fetch(url, init);
  },
  onExternalRequest: event => { externalCalls.push(event); console.log(JSON.stringify({ event: "external_request", ...event })); }
});
for (const name of ["searchOfficialSources", "searchSupplementalOfficialSources", "searchOfficialSeedSources", "fetchApprovedSource", "searchPubMed"]) {
  adapters[name] = async () => { legacyCalls++; throw new Error("Legacy research preparation must not run."); };
}
const started = now.getTime();
const { forbiddenOutputFragments: _privateOutputFilters, ...publicPolicy } = config.workflowPolicy;
save("execution-policy", { input, policy: publicPolicy, maximum_serpapi_requests: maximumSerpRequests,
  medical_skill_bundle_sha256: medicalSkillBundle.digest,
  diagnostic_replay: replay !== null, fresh_case_acceptance_eligible: replay === null,
  provider_search_cache_bypassed: false,
  public_api_or_admission_tested: false, production_database_writable: false });
console.log(JSON.stringify({ event: "workflow_probe_started", input: original, maximum_serpapi_requests: maximumSerpRequests }));
if (process.argv.includes("--preflight")) {
  save("result", { outcome: "preflight_passed", serpapi_requests: 0, model_requests: 0,
    policy: publicPolicy, public_api_or_admission_tested: false });
  clearInterval(timer); store.close();
  console.log(JSON.stringify({ event: "workflow_preflight_passed", serpapi_requests: 0, model_requests: 0 }));
  process.exit(0);
}
try {
  const execute = () => executeDoctorResearchWorkflow({ lease, store, adapters, signal, medicalSkillBundle, artifactRoot: `${root}/artifacts`, policy: config.workflowPolicy,
    modelClient: { model: client.model, generate: async request => {
      if (++modelRequests > 29) throw new Error("Probe model request cap reached.");
      const at = Date.now();
      try {
        const response = await client.generate(request);
        mkdirSync(`${root}/model-responses`, { recursive: true, mode: 0o700 });
        writeFileSync(`${root}/model-responses/${request.stage}-${request.attempt}.json`, JSON.stringify({
          text: response.text, usage: response.usage, gatewayRequestId: response.gatewayRequestId
        }, null, 2), { mode: 0o600 });
        const trace = { stage: request.stage, attempt: request.attempt, elapsed_ms: Date.now() - at,
          gateway_request_id: response.gatewayRequestId, response_sha256: hash(response.text), usage: response.usage,
          telemetry: response.telemetry ?? null };
        modelCalls.push(trace); console.log(JSON.stringify({ event: "model_completed", ...trace }));
        return response;
      } catch (error) {
        modelCalls.push({ stage: request.stage, attempt: request.attempt, elapsed_ms: Date.now() - at,
          outcome: "failed", error_name: error?.name, error_code: error?.code ?? null,
          http_status: error?.statusCode ?? null, gateway_request_id: error?.gatewayRequestId ?? null,
          telemetry: researchModelCallTelemetryFromError(error) ?? null }); throw error;
      }
    } },
    onValidationFailure: event => { validationFailures.push(event); console.log(JSON.stringify({ event: "validation_failure", ...event })); },
    onResourceBudgetFailure: event => { budgetFailures.push(event); console.log(JSON.stringify({ event: "resource_budget_failure", ...event })); }
  });
  let result = await execute();
  const attempts = [{ lease_generation: lease.token.generation, elapsed_ms: Date.now() - started, result }];
  // Requeues keep the original run clock, durable resource counters and model
  // responses. A transient second failure need not end an otherwise resumable
  // task while its original deadline and call budget still permit recovery.
  while (attempts.length < 4 && result.outcome === "failed" && result.retryable && !signal.aborted) {
    const requeued = store.requeueRun({ token: lease.token, reason: "retriable_upstream_failure" });
    if (requeued.outcome !== "queued") throw new Error("Isolated retry could not be queued.");
    lease = store.acquireLease({ workerId: "isolated-workflow-probe", leaseSeconds: 120 });
    if (!lease) throw new Error("Isolated retry lease unavailable.");
    result = await execute();
    attempts.push({ lease_generation: lease.token.generation, elapsed_ms: Date.now() - started, result });
  }
  const stored = store.getRunResultForSubject(lease.run.runId, lease.run.subjectId);
  if (stored) save("stored-result", stored);
  const checkedArtifacts = [];
  if (stored) {
    mkdirSync(`${root}/verified-artifacts`, { recursive: true, mode: 0o700 });
    const records = store.database.prepare("SELECT * FROM research_artifacts WHERE run_id = ?").all(lease.run.runId);
    for (const record of records) {
      const bytes = readFileSync(`${root}/artifacts/${record.storage_path}`);
      const correct = hash(bytes) === record.sha256 && bytes.length === record.size_bytes;
      checkedArtifacts.push({ kind: record.kind, bytes: bytes.length, hash_verified: correct });
      if (!correct) throw new Error("Artifact content hash mismatch.");
      writeFileSync(`${root}/verified-artifacts/${record.kind}.${record.kind === 'questions' || record.kind === 'answers' ? 'txt' : 'md'}`, bytes);
    }
  }
  save("result", { original, result, elapsed_ms: Date.now() - started, serpapi_requests: serpRequests,
    attempts, diagnostic_replay: replay !== null, fresh_case_acceptance_eligible: replay === null,
    legacy_calls: legacyCalls, model_requests: modelRequests, renew_error: renewError, checked_artifacts: checkedArtifacts,
    model_calls: modelCalls, validation_failures: validationFailures, external_calls: externalCalls, budget_failures: budgetFailures,
    public_api_or_admission_tested: false });
  console.log(JSON.stringify({ event: "workflow_probe_completed", result, elapsed_ms: Date.now() - started,
    serpapi_requests: serpRequests, legacy_calls: legacyCalls, model_requests: modelRequests, artifacts: checkedArtifacts }));
} catch (error) {
  save("result", { original, result: { outcome: "probe_error", error_name: error?.name, error_code: error?.code ?? null,
    error_message: String(error?.message ?? "").replace(/(?:Bearer\s+|(?:api_key|token)=)[^\s&]+/giu, "[redacted]").slice(0, 500) },
    elapsed_ms: Date.now() - started, serpapi_requests: serpRequests, legacy_calls: legacyCalls, model_requests: modelRequests,
    model_calls: modelCalls, validation_failures: validationFailures, budget_failures: budgetFailures });
} finally {
  clearInterval(timer);
  const checkpoints = store.database.prepare("SELECT stage, checkpoint_version, payload_json FROM research_checkpoints WHERE run_id=?").all(lease.run.runId);
  save("checkpoints", checkpoints.map(c => ({ stage: c.stage, checkpoint_version: c.checkpoint_version, payload: JSON.parse(c.payload_json) })));
  save("stage-runs", store.database.prepare("SELECT stage,attempt,duration_ms,error_code,prompt_tokens,completion_tokens,admission_wait_ms,client_total_ms,terminal_source FROM research_stage_runs WHERE run_id=? ORDER BY stage_run_id").all(lease.run.runId));
  store.close();
}
