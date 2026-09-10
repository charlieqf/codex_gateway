// Run in an isolated R760 probe container with production volumes read-only.
// Reads original inputs only; optional full mode writes exclusively to that
// probe directory and uses the configured internal Research model service.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const root = process.env.RESEARCH_REPAIR_PROBE_ROOT;
if (!root || !/^\/tmp\/doctor-research-repair-[a-z0-9-]+$/u.test(root)) throw new Error("An isolated probe directory is required.");
const full = process.env.RESEARCH_REPAIR_PROBE_MODE === "full";
const emit = (value) => console.log(JSON.stringify(value));
const cleanUrl = (raw) => { const url = new URL(raw); return url.origin + url.pathname; };
const { loadResearchWorkerConfig } = await import("/app/apps/research-worker/dist/config.js");
const config = loadResearchWorkerConfig(process.env);
const moduleRoot = `${root}/packages/research-agent/dist/`;
const { LiveResearchAdapters } = await import(pathToFileURL(`${moduleRoot}live-adapters.js`).href);
const { executeDoctorResearchWorkflow, GatewayResearchModelClient } = await import(pathToFileURL(`${moduleRoot}index.js`).href);
const { createResearchSqliteStore } = await import("/app/packages/store-sqlite/dist/index.js");
const workflowPath = `${moduleRoot}workflow.js`;
const code = readFileSync(workflowPath, "utf8").replace(/(from\s+["'])(\.[^"']+)(["'])/gu,
  (_, a, spec, b) => a + new URL(spec, pathToFileURL(workflowPath)).href + b) + "\nexport {discoverIdentityEvidence, resolveIdentity};\n";
const diagnostic = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const cases = JSON.parse(readFileSync(`${root}/scripts/ops/doctor-research-repair-cases.json`, "utf8"));
const selectedArg = process.env.RESEARCH_REPAIR_PROBE_CASE;
const selected = selectedArg && /^\d$/u.test(selectedArg) ? cases[Number(selectedArg)]?.name : selectedArg;
const db = new DatabaseSync("/var/lib/codex-gateway-research/research.db", { readOnly: true });
db.exec("PRAGMA query_only=ON");
const policy = { ...config.workflowPolicy, budgets: { ...config.workflowPolicy.budgets, externalRequests: 1000, externalResponseBytes: 2_000_000_000 } };
const results = [];
for (const [index, target] of cases.entries()) {
  if (selected && target.name !== selected) continue;
  const row = db.prepare("SELECT run_id,input_json FROM research_runs WHERE json_extract(input_json,'$.doctor.name')=? ORDER BY created_at DESC LIMIT 1").get(target.name);
  if (!row) { emit({ event: "missing_original_input", name: target.name }); continue; }
  const input = JSON.parse(row.input_json);
  input.doctor = { ...input.doctor, name: target.name, hospital: target.hospital, department: target.department, officialProfileUrls: [] };
  const started = Date.now();
  let searchCalls = 0;
  const traces = [];
  const adapters = new LiveResearchAdapters({
    ...config.adapterOptions,
    ncbi: { ...config.adapterOptions.ncbi, ...(config.ncbiApiKeyFile ? { apiKey: readFileSync(config.ncbiApiKeyFile, "utf8").trim() } : {}) },
    orcid: { enabled: false },
    officialWeb: { ...config.adapterOptions.officialWeb, apiKey: readFileSync(config.webSearchApiKeyFile, "utf8").trim() },
    onExternalRequest(event) {
      if (event.host === "serpapi.com") searchCalls += 1;
      emit({ event: "probe_external_request", name: target.name, ...event });
    }
  });
  const fetchSource = adapters.fetchApprovedSource.bind(adapters);
  adapters.fetchApprovedSource = async (id, signal) => {
    const selectedSource = adapters.officialSources.get(id);
    try {
      const source = await fetchSource(id, signal);
      const trace = { source_id: id, url: cleanUrl(source?.url ?? selectedSource.url), fetched: Boolean(source), characters: source?.untrustedText.length ?? 0 };
      traces.push(trace); emit({ event: "probe_source", name: target.name, ...trace });
      return source;
    } catch (error) { if (!signal.aborted) emit({ event: "probe_source_error", name: target.name, source_id: id, error_type: error?.name }); throw error; }
  };
  emit({ event: "probe_started", at_utc: new Date().toISOString(), mode: full ? "full" : "identity", name: target.name, hospital: target.hospital, department: target.department, original_run_id: row.run_id });
  let store;
  let result;
  try {
    if (full) {
      const caseRoot = `${root}/full-${index}`;
      mkdirSync(caseRoot, { recursive: true, mode: 0o700 });
      store = createResearchSqliteStore({ path: `${caseRoot}/research.db`, limits: config.admissionLimits, ...config.store });
      const now = new Date();
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const created = store.createRun({ subjectId: `subj_repair_probe_${index}`, credentialId: `cred_repair_probe_${index}`, requestId: `req_repair_probe_${index}`, idempotencyKey: `research:repair-probe-${now.getTime()}`, requestHash: hash, identityFingerprint: hash, input, now });
      if (created.outcome !== "created") throw new Error("Probe creation failed");
      const lease = store.acquireLease({ workerId: "repair-probe", leaseSeconds: 600, now });
      const modelClient = new GatewayResearchModelClient({ ...config.llm, bearerToken: readFileSync(config.llm.bearerTokenFile, "utf8").trim(), readinessRequirements: {
        maximumPromptTokensPerCall: policy.maximumInputTokensPerCall, maximumOutputTokensPerCall: policy.maximumOutputTokensPerCall,
        callsPerRun: policy.budgets.llmCalls, concurrentCalls: Math.min(policy.synthesisShardCount ?? 1, 2), maximumTokensPerRun: policy.budgets.inputTokens + policy.budgets.outputTokens
      } });
      const generate = modelClient.generate.bind(modelClient);
      modelClient.generate = async request => {
        const response = await generate(request);
        writeFileSync(`${caseRoot}/model-${request.stage}-${request.attempt}.json`, JSON.stringify({ text: response.text }), { mode: 0o600 });
        let jsonValid = true;
        try { JSON.parse(response.text); } catch { jsonValid = false; }
        emit({ event: "probe_model_response", name: target.name, stage: request.stage, attempt: request.attempt,
          characters: response.text.length, valid_json: jsonValid, fenced: response.text.trimStart().startsWith("```"),
          finish_reason: response.finishReason ?? null });
        return response;
      };
      const outcome = await executeDoctorResearchWorkflow({ lease, store, adapters, modelClient, artifactRoot: `${caseRoot}/artifacts`, policy, signal: AbortSignal.timeout(policy.hardDeadlineMs + 5_000),
        onValidationFailure: event => emit({ event: "probe_validation_failure", name: target.name, stage: event.stage, error_codes: event.errorCodes }) });
      const artifacts = store.database.prepare("SELECT kind,size_bytes,sha256 FROM research_artifacts WHERE run_id=?").all(created.run.runId);
      const stages = store.database.prepare("SELECT stage,attempt,error_code,duration_ms FROM research_stage_runs WHERE run_id=? ORDER BY started_at").all(created.run.runId);
      result = { ...outcome, probe_run_id: created.run.runId, artifacts, stages, case_root: caseRoot };
    } else {
      const signal = AbortSignal.timeout(170_000);
      const run = { runId: row.run_id, input };
      let reserved = 0;
      const evidence = await diagnostic.discoverIdentityEvidence({ run, input: { adapters, policy, signal }, callSignal: () => signal, chargeExternal: units => { reserved += units; } });
      result = { identity_resolved: Boolean(diagnostic.resolveIdentity(run, evidence)), reserved_external_units: reserved, discovered_sources: evidence.discoveredSourceCount, fetched_sources: evidence.fetchedSourceCount,
        approved_sources: evidence.officialSources.map(source => ({ url: cleanUrl(source.url), basis: source.identityMatchBasis })), failures: adapters.officialSourceFailures };
    }
  } catch (error) { result = { diagnostic_error: error?.name, error_kind: error?.kind ?? null, http_status: error?.statusCode ?? null }; }
  finally { store?.close(); }
  const record = { name: target.name, elapsed_ms: Date.now() - started, search_calls: searchCalls, ...result, traces };
  results.push(record); emit({ event: "probe_completed", ...record });
  writeFileSync(`${root}/${full ? "full" : "identity"}-results${selected ? `-${index}` : ""}.json`, JSON.stringify(results, null, 2), { mode: 0o600 });
}
db.close();
