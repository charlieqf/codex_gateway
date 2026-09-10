// Real model, synthetic public sources and PubMed tools. No live search adapter is imported.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { investigateDoctorEvidence } from "./evidence-investigator.js";
import { GatewayResearchModelClient } from "./model-client.js";
const root = process.cwd();
if (!/^\/tmp\/doctor-research-agent-offline-evidence-[a-z0-9-]+$/u.test(root)) throw new Error("An isolated offline evidence probe root is required.");
const { loadResearchWorkerConfig } = await import("/app/apps/research-worker/dist/config.js");
const config = loadResearchWorkerConfig(process.env);
const client = new GatewayResearchModelClient({ ...config.llm,
  bearerToken: readFileSync(config.llm.bearerTokenFile, "utf8").trim(),
  readinessRequirements: { maximumPromptTokensPerCall: 30_000, maximumOutputTokensPerCall: 6_000,
    callsPerRun: 8, maximumTokensPerRun: 280_000 }
});
const targets = [
  { id: "missing_affiliation_with_explicit_publication", corroborated: true },
  { id: "coauthor_affiliation_and_directory_neighbor", corroborated: false }
];
const results = [];
let batchModelCalls = 0;
for (const target of targets) {
  const runId = `drr_${randomUUID().replaceAll("-", "")}`;
  const signal = AbortSignal.timeout(240_000);
  const started = Date.now();
  const modelCalls = [], toolCalls = [];
  const quote = "Alice Example | Endocrinology | Consultant";
  const text = `Harbour University Hospital\nOfficial current staff directory\n${quote}\nBob Example | Cardiology | Professor\n` +
    (target.corroborated ? "Alice Example publications: Hormone monitoring in adults, PMID 101.\n" : "No publication list is supplied on this directory page.\n");
  const page = { sourceId: "src_directory", url: "https://hospital.example/current-staff", title: "Current staff directory",
    accessedAt: new Date().toISOString(), contentSha256: createHash("sha256").update(text).digest("hex"), untrustedText: text, navigationLinks: [] };
  const publication = { referenceId: "ref_101", pmid: "101", doi: null, title: "Hormone monitoring in adults", journal: "Example Journal", publicationYear: 2025,
    authors: ["Example A", "Example B"], authorAffiliations: target.corroborated ? [] : [
      { author: "Example A", affiliations: ["Nephrology, Different University Hospital"] },
      { author: "Example B", affiliations: ["Endocrinology, Harbour University Hospital"] }
    ], abstractText: "An observational study of hormone monitoring in adults. The study compares hormone measurements across visits; it does not assess treatment efficacy.",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/101/", accessedAt: page.accessedAt, contentSha256: "b".repeat(64) };
  const input = { doctor: { name: "Alice Example", hospital: "港湾大学医院", department: "内分泌科", title: null, city: null, orcid: null, officialProfileUrls: [] },
    identity: { name: "Alice Example", institution: "Harbour University Hospital", department: "Endocrinology",
      citations: ["person", "institution", "department", "authority"].map(aspect => ({ sourceId: page.sourceId, quote,
        aspect, explanation: "Synthetic identity supplied for an isolated downstream evidence test." })) },
    identityPages: [page], language: "zh-CN", startYear: 2022, endYear: 2026,
    minimumReferences: 1, maximumReferences: 5, profileOnly: false,
    policy: { maximumSearchRequests: 3, maximumPublicationRequests: 3, maximumPageRequests: 1, maximumModelCalls: 8 }
  };
  writeFileSync(`${root}/${target.id}-input.json`, JSON.stringify(input, null, 2));
  console.log(JSON.stringify({ event: "case_started", case_id: target.id, serpapi_requests: 0 }));
  let outcome;
  try {
    const result = await investigateDoctorEvidence({ ...input, dependencies: {
      signal,
      searchPubMed: async query => { toolCalls.push({ tool: "search_pubmed", query }); return ["101"]; },
      readPublication: async pmid => { toolCalls.push({ tool: "read_publication", pmid }); if (pmid !== "101") throw new Error("Unknown synthetic PMID"); return publication; },
      readPage: async () => { throw new Error("No extra offline page is available"); },
      save: async state => writeFileSync(`${root}/${target.id}-state.json`, JSON.stringify(state, null, 2), { mode: 0o600 }),
      generate: async request => {
        if (++batchModelCalls > 16) throw new Error("Offline model batch budget exceeded");
        const start = Date.now();
        const response = await client.generate({ runId, stage: request.role === "evidence_reviewer" ? "screen_and_extract_evidence" : "collect_profile_evidence",
          attempt: request.attempt, system: request.system, prompt: request.prompt, signal,
          maximumOutputTokens: 6_000, reasoningEffort: "low", providerTimeoutMs: 60_000 });
        const trace = { role: request.role, attempt: request.attempt, elapsed_ms: Date.now() - start,
          request_id: response.gatewayRequestId, response_sha256: createHash("sha256").update(response.text).digest("hex"), usage: response.usage };
        modelCalls.push(trace);
        console.log(JSON.stringify({ event: "model_completed", case_id: target.id, ...trace }));
        return response.text;
      }
    } });
    const papers = result.outcome === "resolved" ? result.evidence.doctorPublications : [];
    const matched = result.outcome === "resolved" && (target.corroborated ? papers.length === 1 && papers[0].author === "Example A" && papers[0].corroboration.length > 0 : papers.length === 0);
    outcome = { outcome: result.outcome, ...(result.outcome === "resolved" ? { evidence: result.evidence } : { reason: result.reason }),
      expected_own_papers: target.corroborated ? 1 : 0, matched_authorship_expectation: matched };
  } catch (error) { outcome = { outcome: "probe_error", error_name: error?.name, error_code: error?.code ?? null, matched_authorship_expectation: false }; }
  const record = { case_id: target.id, ...outcome, elapsed_ms: Date.now() - started, serpapi_requests: 0, tool_calls: toolCalls, model_calls: modelCalls };
  results.push(record);
  writeFileSync(`${root}/results.json`, JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: "case_completed", ...record }));
}
