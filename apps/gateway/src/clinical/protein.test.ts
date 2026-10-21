import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { issueAccessCredential, type ProviderAdapter } from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { buildGateway } from "../index.js";
import { ImagingError, sha256 } from "../imaging/contract.js";
import type { StarRequest } from "../imaging/client.js";
import { artifactNames, capabilities, owner, parseArtifacts, parseInput, profiles, type Job, type ProteinMode } from "./contract.js";
import { proteinContentTypes, validateAlphaFold3Result } from "./protein-result.js";
import { ClinicalService } from "./service.js";
import { ClinicalStore } from "./store.js";
import { resolveClinicalService } from "./runtime.js";

const sequence = "MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG";
const input = (mode: ProteinMode = "alphafold") => ({ session_id: "private-session", analysis_profile: profiles[mode], data_policy: "public_or_authorized_sequence", input: { sequence, external_msa_consent: true } });
const id = "job_" + "a".repeat(32), cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const af3Fixture = () => JSON.parse(readFileSync(new URL("./fixtures/af3-ubiquitin76-result.json", import.meta.url), "utf8"));
it("AF3 rejects sharing the AF2 or identity database and redacts arbitrary private route text", async () => {
  const t = setup(new Star("alphafold3"));
  await t.app.inject({ url: "/gateway/alphafold3/v1/private-sequence?token=private-sequence" });
  await t.app.inject({ url: "/gateway/%61lphafold3/v1/private-sequence" });
  expect(t.logs.join("\n")).not.toContain("private-sequence");
  const path = join(tmpdir(), "clinical-independent-db-check.db");
  for (const other of ["GATEWAY_ALPHAFOLD_SQLITE_PATH", "GATEWAY_SQLITE_PATH", "GATEWAY_CLIENT_EVENTS_SQLITE_PATH"]) {
    expect(resolveClinicalService("alphafold3", { GATEWAY_ALPHAFOLD3_MODE: "authenticated", GATEWAY_ALPHAFOLD3_SQLITE_PATH: path, [other]: path }, { warn() {} })).toBeNull();
  }
});
it("AF3 accepts the real five-sample result and negative ranking scores without AF2 fields", () => {
  const data = af3Fixture();
  expect(data.models).toBeUndefined(); expect(data.mean_plddt).toBeUndefined();
  expect(() => validateAlphaFold3Result(data, { sequence })).not.toThrow();
  data.ranking_score = -99.15; data.has_clash = 1;
  Object.assign(data.samples.find((s: { sample: number }) => s.sample === data.sample), { ranking_score: -99.15, has_clash: 1 });
  expect(() => validateAlphaFold3Result(data, { sequence })).not.toThrow();
  expect(capabilities("alphafold3", true).fields).toMatchObject({ num_models: 1, num_diffusion_samples: 5, num_recycle: 10, structure_format: "mmcif" });
  expect(capabilities("alphafold", true).fields).toMatchObject({ num_models: 5, num_recycle: 3 });
});
it("AF3 rejects invalid identity, confidence, samples and settings before returning result bytes", async () => {
  const t = setup(new Star("alphafold3")); await t.create(); t.star.complete();
  const valid = af3Fixture(); valid.job_id = id;
  const invalid = [
    { length: 77 }, { sequence_sha256: "0".repeat(64) }, { mean_atom_plddt: 101 }, { mean_ca_plddt: -1 },
    { ptm: 1.01 }, { ca_residues_below_70: 76.5 }, { ca_residues_below_70: 77 },
    { ranking_score: -101 }, { ranking_score: 1.51 }, { has_clash: true }, { seed: 1 }, { sample: 5 },
    { samples: valid.samples.slice(1) }, { samples: valid.samples.map(() => valid.samples[0]) },
    { samples: valid.samples.map((s: object, i: number) => ({ ...s, ...(i === 1 ? { mean_ca_plddt: 101 } : {}) })) },
    ...Object.entries({ num_models: 5, num_diffusion_samples: 4, num_recycles: 3, random_seed: 1, templates: true, relaxation: true, run_data_pipeline: true, bucket: 512, attention: "triton" })
      .map(([key, value]) => ({ settings: { ...valid.settings, [key]: value } }))
  ];
  for (const mutation of invalid) {
    const bytes = Buffer.from(JSON.stringify({ ...valid, ...mutation }));
    t.star.files.set("result.json", bytes);
    Object.assign(t.star.job!.artifacts!.find(a => a.name === "result.json")!, { size: bytes.length, sha256: sha256(bytes) });
    const result = await t.request("GET", `/jobs/${id}/result`);
    expect(result.statusCode).toBe(503); expect(result.json().error.code).toBe("upstream_protocol_error");
  }
  for (const value of [NaN, Infinity, -Infinity]) expect(() => validateAlphaFold3Result({ ...valid, mean_atom_plddt: value }, { sequence })).toThrow();
});
it("AF3 preserves the 64 KiB control boundary and never serves AF2 artifacts", async () => {
  const t = setup(new Star("alphafold3"));
  const payload = JSON.stringify(input("alphafold3"));
  expect((await t.request("POST", "/jobs", payload + " ".repeat(20000), 0, { "idempotency-key": "boundary-key" })).statusCode).toBe(202);
  expect((await t.request("POST", "/jobs", payload + " ".repeat(65536), 0, { "idempotency-key": "boundary-key" })).statusCode).toBe(413);
  t.star.complete();
  expect((await t.request("GET", `/jobs/${id}/artifacts/structure.pdb`)).statusCode).toBe(404);
  expect((await t.request("GET", `/jobs/${id}/artifacts/structure.cif`)).statusCode).toBe(200);
  const altered = t.star.job!.artifacts!.map(a => a.name === "structure.cif" ? { ...a, name: "structure.pdb" } : a);
  expect(() => parseArtifacts("alphafold3", altered)).toThrow();
});
class Star {
  constructor(readonly mode: ProteinMode = "alphafold") {
    this.files = new Map(artifactNames(mode).map(name => [name, Buffer.from(name === "structure.html" ? "<!doctype html>\n<script>const a = '未改写';</script>" : name)]));
  }
  job?: Job; lost = false; corrupt = false;
  calls: { owner: string; path: string; key?: string; body?: unknown }[] = [];
  files: Map<string, Buffer>;
  close() {} async source(): Promise<Buffer> { throw new Error("source must not be requested"); }
  async json(ownerRef: string, method: string, path: string, options: StarRequest = {}) {
    this.calls.push({ owner: ownerRef, path, key: options.key, body: options.body });
    if (path === "/capabilities") return { status: 200, data: capabilities(this.mode, true) };
    if (path === "/jobs") {
      const now = Date.now() / 1000;
      this.job ??= { job_id: id, state: "queued", analysis_profile: profiles[this.mode], created_at: now, updated_at: now, expires_at: now + 86400, result_revision: null, progress: { phase: "queued", poll_after_ms: 2000 } };
      if (this.lost) { this.lost = false; throw new ImagingError(503, "unavailable"); }
    } else if (method === "DELETE") this.job!.state = "deleted";
    else if (path.endsWith("/cancel")) this.job!.state = "cancelled";
    return { status: method === "POST" ? 202 : 200, data: structuredClone(this.job) };
  }
  async artifact(_owner: string, path: string) {
    const name = path.split("/").at(-1)!;
    return Object.assign(Readable.from([this.corrupt ? Buffer.from("corrupted") : this.files.get(name)!]), { contentType: proteinContentTypes[name] });
  }
  complete() {
    this.files.set("result.json", Buffer.from(JSON.stringify({ schema_version: 1, job_id: id, analysis_profile: profiles[this.mode], research_only: true,
      length: 76, sequence_sha256: sha256(sequence), mean_plddt: 90, ptm: 0.8, residues_below_70: 2,
      models: Array.from({ length: 5 }, (_, i) => ({ rank: i + 1, mean_plddt: 90, ptm: 0.8 })),
      settings: { model_type: "alphafold2_ptm", num_models: 5, num_recycle: 3, random_seed: 0, templates: false, relaxation: false },
      msa: { host: "https://api.colabfold.com", database_version: null }, model_provenance: { learning_only: true }
    }, null, 2) + "\n"));
    if (this.mode === "alphafold3") {
      const result = JSON.parse(readFileSync(new URL("./fixtures/af3-ubiquitin76-result.json", import.meta.url), "utf8"));
      result.job_id = id;
      this.files.set("result.json", Buffer.from(JSON.stringify(result, null, 2) + "\n"));
    }
    Object.assign(this.job!, { state: "completed", result_revision: 1, progress: { phase: "completed" }, artifacts: [...this.files].map(([name, b]) => ({ name, size: b.length, sha256: sha256(b) })) });
  }
}
function setup(star = new Star(), path = ":memory:") {
  const store = new ClinicalStore(path), service = new ClinicalService(star.mode, store, star, { subjects: new Set(), allAuthenticated: true });
  const identity = createSqliteStore({ path: ":memory:" }), logs: string[] = [];
  const keys = ["subject-a", "future-account-b"].map(id => {
    identity.upsertSubject({ id, label: id, state: "active", createdAt: new Date() });
    const key = issueAccessCredential({ subjectId: id, scope: "code", label: "test", expiresAt: new Date(Date.now() + 600000) }); identity.insertAccessCredential(key.record); return key.token;
  });
  const provider: ProviderAdapter = { kind: "fake", health: async () => ({ state: "healthy", checkedAt: new Date() }), async *message() { yield { type: "completed" }; } };
  const app = buildGateway({ provider, sessionStore: identity, authMode: "credential", alphafoldService: star.mode === "alphafold" ? service : null, alphafold3Service: star.mode === "alphafold3" ? service : null, aipalService: null, panechoService: null, echonetService: null, echonextService: null, imagingService: null, clientEventsStore: null, phoneAuthService: null, logger: { stream: { write(s: string) { logs.push(s); } } } });
  cleanup.push(() => app.close());
  const request = (method: "GET" | "POST" | "DELETE" | "PUT", suffix: string, body?: unknown, account = 0, headers = {}) => app.inject({ method, url: `/gateway/${star.mode}/v1` + suffix, headers: { authorization: `Bearer ${keys[account]}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, payload: body as string });
  const create = (body = input(star.mode)) => request("POST", "/jobs", body, 0, { "idempotency-key": "original-key:123" });
  return { app, request, create, star, store, service, logs };
}
for (const mode of ["alphafold", "alphafold3"] as const) {
it(mode + " validates consent/sequence before reserving and discards FASTA title", async () => {
  const t = setup(new Star(mode));
  for (const invalid of [{ sequence, external_msa_consent: false }, { sequence: sequence + "X", external_msa_consent: true }, { sequence: ">one\n" + sequence + "\n>two\n" + sequence, external_msa_consent: true }, { sequence: "A".repeat(131), external_msa_consent: true }, { sequence: "A".repeat(4097), external_msa_consent: true }]) {
    expect((await t.create({ ...input(mode), input: invalid })).statusCode).toBe(422);
  }
  expect(t.star.calls).toHaveLength(0);
  expect((await t.create({ ...input(mode), input: { sequence: ">secret-title\n" + sequence.toLowerCase(), external_msa_consent: true } })).statusCode).toBe(202);
  expect(t.star.calls[0]!.key).toBe("original-key:123"); expect(t.star.calls[0]!.owner).toBe(owner(mode, "subject-a"));
  expect(JSON.stringify(t.star.calls)).not.toContain("secret-title");
  expect(JSON.stringify(t.logs)).not.toContain(sequence); expect(JSON.stringify(t.logs)).not.toContain("private-session");
  expect(() => parseInput(mode, { ...input(mode), data_policy: "public_or_deidentified" })).toThrow();
});
it(mode + " authenticates all accounts, isolates forged owners and rejects upload/source routes", async () => {
  const t = setup(new Star(mode)); expect((await t.request("GET", "/capabilities", undefined, 1)).json().available).toBe(true);
  expect((await t.app.inject({ url: `/gateway/${mode}/v1/capabilities` })).statusCode).toBe(401);
  await t.create();
  for (const [method, suffix, body] of [["GET", "", undefined], ["POST", "/cancel", {}], ["DELETE", "", undefined], ["GET", "/artifacts/structure.html", undefined]] as const)
    expect((await t.request(method, `/jobs/${id}${suffix}`, body, 1, { "x-clinical-owner": owner(mode, "subject-a") })).statusCode).toBe(404);
  for (const suffix of ["/source", `/jobs/${id}/input`]) expect((await t.request("GET", suffix)).statusCode).toBe(404);
  expect((await t.request("POST", `/jobs/${id}/input/complete`, {})).statusCode).toBe(404);
});
it(mode + " keeps idempotency across durable recovery and preserves progress/error codes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "protein-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const star = new Star(mode), path = join(dir, "control.db"), first = setup(star, path); star.lost = true;
  expect((await first.create()).statusCode).toBe(503); await first.app.close();
  const t = setup(star, path); await t.service.reconcile(); expect((await t.create()).json().job_id).toBe(id);
  expect(new Set(star.calls.filter(c => c.path === "/jobs").map(c => c.key))).toEqual(new Set(["original-key:123"]));
  expect((await t.create({ ...input(mode), input: { ...input(mode).input, sequence: sequence.slice(0, -1) + "A" } })).statusCode).toBe(409);
  for (const phase of ["searching_msa", "waiting_gpu", "predicting", "postprocessing"]) { star.job!.progress.phase = phase; expect((await t.request("GET", `/jobs/${id}`)).json().progress.phase).toBe(phase); }
  star.job!.state = "failed"; star.job!.error = { code: "msa_timeout", message: "secret-path" };
  const failed = await t.request("GET", `/jobs/${id}`); expect(failed.json().error.code).toBe("msa_timeout"); expect(failed.body).not.toContain("secret-path");
});
it(mode + " verifies all seven files before HTTP success, preserves JSON/HTML bytes and revokes downloads", async () => {
  const t = setup(new Star(mode)); await t.create(); t.star.complete();
  for (const [name, bytes] of t.star.files) {
    const r = await t.request("GET", `/jobs/${id}/artifacts/${name}`);
    expect(r.statusCode).toBe(200); expect(r.rawPayload).toEqual(bytes); expect(r.headers["content-type"]).toBe(proteinContentTypes[name]);
    expect(r.headers["x-content-sha256"]).toBe(sha256(bytes)); expect(r.headers["content-disposition"]).toContain("attachment;"); expect(r.headers["cache-control"]).toBe("no-store, no-transform");
  }
  expect((await t.request("GET", `/jobs/${id}/result`)).rawPayload).toEqual(t.star.files.get("result.json"));
  t.star.corrupt = true; expect((await t.request("GET", `/jobs/${id}/artifacts/structure.html`)).statusCode).toBe(503); t.star.corrupt = false;
  expect((await t.request("DELETE", `/jobs/${id}`)).statusCode).toBe(202);
  for (const suffix of ["", "/result", "/artifacts/structure.html"]) expect((await t.request("GET", `/jobs/${id}${suffix}`)).statusCode).toBe(404);
  const manifest = t.star.job!.artifacts!;
  expect(() => parseArtifacts(mode, manifest.slice(1))).toThrow();
  expect(() => parseArtifacts(mode, manifest.map(a => ({ ...a, size: 33554433 })))).toThrow();
});
}
