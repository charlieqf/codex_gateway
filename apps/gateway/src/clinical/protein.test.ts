import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { issueAccessCredential, type ProviderAdapter } from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { buildGateway } from "../index.js";
import { ImagingError, sha256 } from "../imaging/contract.js";
import type { StarRequest } from "../imaging/client.js";
import { artifactNames, capabilities, owner, parseArtifacts, parseInput, profiles, type Job } from "./contract.js";
import { proteinContentTypes } from "./protein-result.js";
import { ClinicalService } from "./service.js";
import { ClinicalStore } from "./store.js";

const sequence = "MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG";
const input = () => ({ session_id: "private-session", analysis_profile: profiles.alphafold, data_policy: "public_or_authorized_sequence", input: { sequence, external_msa_consent: true } });
const id = "job_" + "a".repeat(32), cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
class Star {
  job?: Job; lost = false; corrupt = false;
  calls: { owner: string; path: string; key?: string; body?: unknown }[] = [];
  files = new Map(artifactNames("alphafold").map(name => [name, Buffer.from(name === "structure.html" ? "<!doctype html>\n<script>const a = '未改写';</script>" : name)]));
  close() {} async source(): Promise<Buffer> { throw new Error("source must not be requested"); }
  async json(ownerRef: string, method: string, path: string, options: StarRequest = {}) {
    this.calls.push({ owner: ownerRef, path, key: options.key, body: options.body });
    if (path === "/capabilities") return { status: 200, data: capabilities("alphafold", true) };
    if (path === "/jobs") {
      const now = Date.now() / 1000;
      this.job ??= { job_id: id, state: "queued", analysis_profile: profiles.alphafold, created_at: now, updated_at: now, expires_at: now + 86400, result_revision: null, progress: { phase: "queued", poll_after_ms: 2000 } };
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
    this.files.set("result.json", Buffer.from(JSON.stringify({ schema_version: 1, job_id: id, analysis_profile: profiles.alphafold, research_only: true,
      length: 76, sequence_sha256: sha256(sequence), mean_plddt: 90, ptm: 0.8, residues_below_70: 2,
      models: Array.from({ length: 5 }, (_, i) => ({ rank: i + 1, mean_plddt: 90, ptm: 0.8 })),
      settings: { model_type: "alphafold2_ptm", num_models: 5, num_recycle: 3, random_seed: 0, templates: false, relaxation: false },
      msa: { host: "https://api.colabfold.com", database_version: null }, model_provenance: { learning_only: true }
    }, null, 2) + "\n"));
    Object.assign(this.job!, { state: "completed", result_revision: 1, progress: { phase: "completed" }, artifacts: [...this.files].map(([name, b]) => ({ name, size: b.length, sha256: sha256(b) })) });
  }
}
function setup(star = new Star(), path = ":memory:") {
  const store = new ClinicalStore(path), service = new ClinicalService("alphafold", store, star, { subjects: new Set(), allAuthenticated: true });
  const identity = createSqliteStore({ path: ":memory:" }), logs: string[] = [];
  const keys = ["subject-a", "future-account-b"].map(id => {
    identity.upsertSubject({ id, label: id, state: "active", createdAt: new Date() });
    const key = issueAccessCredential({ subjectId: id, scope: "code", label: "test", expiresAt: new Date(Date.now() + 600000) }); identity.insertAccessCredential(key.record); return key.token;
  });
  const provider: ProviderAdapter = { kind: "fake", health: async () => ({ state: "healthy", checkedAt: new Date() }), async *message() { yield { type: "completed" }; } };
  const app = buildGateway({ provider, sessionStore: identity, authMode: "credential", alphafoldService: service, aipalService: null, panechoService: null, echonetService: null, echonextService: null, imagingService: null, clientEventsStore: null, phoneAuthService: null, logger: { stream: { write(s: string) { logs.push(s); } } } });
  cleanup.push(() => app.close());
  const request = (method: "GET" | "POST" | "DELETE" | "PUT", suffix: string, body?: unknown, account = 0, headers = {}) => app.inject({ method, url: "/gateway/alphafold/v1" + suffix, headers: { authorization: `Bearer ${keys[account]}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, payload: body as string });
  const create = (body = input()) => request("POST", "/jobs", body, 0, { "idempotency-key": "original-key:123" });
  return { app, request, create, star, store, service, logs };
}
it("AlphaFold validates consent/sequence before reserving and discards FASTA title", async () => {
  const t = setup();
  for (const invalid of [{ sequence, external_msa_consent: false }, { sequence: sequence + "X", external_msa_consent: true }, { sequence: ">one\n" + sequence + "\n>two\n" + sequence, external_msa_consent: true }, { sequence: "A".repeat(131), external_msa_consent: true }, { sequence: "A".repeat(4097), external_msa_consent: true }]) {
    expect((await t.create({ ...input(), input: invalid })).statusCode).toBe(422);
  }
  expect(t.star.calls).toHaveLength(0);
  expect((await t.create({ ...input(), input: { sequence: ">secret-title\n" + sequence.toLowerCase(), external_msa_consent: true } })).statusCode).toBe(202);
  expect(t.star.calls[0]!.key).toBe("original-key:123"); expect(t.star.calls[0]!.owner).toBe(owner("alphafold", "subject-a"));
  expect(JSON.stringify(t.star.calls)).not.toContain("secret-title");
  expect(JSON.stringify(t.logs)).not.toContain(sequence); expect(JSON.stringify(t.logs)).not.toContain("private-session");
  expect(() => parseInput("alphafold", { ...input(), data_policy: "public_or_deidentified" })).toThrow();
});
it("AlphaFold authenticates all accounts, isolates forged owners and rejects upload/source routes", async () => {
  const t = setup(); expect((await t.request("GET", "/capabilities", undefined, 1)).json().available).toBe(true);
  expect((await t.app.inject({ url: "/gateway/alphafold/v1/capabilities" })).statusCode).toBe(401);
  await t.create();
  for (const [method, suffix, body] of [["GET", "", undefined], ["POST", "/cancel", {}], ["DELETE", "", undefined], ["GET", "/artifacts/structure.html", undefined]] as const)
    expect((await t.request(method, `/jobs/${id}${suffix}`, body, 1, { "x-clinical-owner": owner("alphafold", "subject-a") })).statusCode).toBe(404);
  for (const suffix of ["/source", `/jobs/${id}/input`]) expect((await t.request("GET", suffix)).statusCode).toBe(404);
  expect((await t.request("POST", `/jobs/${id}/input/complete`, {})).statusCode).toBe(404);
});
it("AlphaFold keeps idempotency across durable recovery and preserves progress/error codes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "protein-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const star = new Star(), path = join(dir, "control.db"), first = setup(star, path); star.lost = true;
  expect((await first.create()).statusCode).toBe(503); await first.app.close();
  const t = setup(star, path); await t.service.reconcile(); expect((await t.create()).json().job_id).toBe(id);
  expect(new Set(star.calls.filter(c => c.path === "/jobs").map(c => c.key))).toEqual(new Set(["original-key:123"]));
  expect((await t.create({ ...input(), input: { ...input().input, sequence: sequence.slice(0, -1) + "A" } })).statusCode).toBe(409);
  for (const phase of ["searching_msa", "waiting_gpu", "predicting", "postprocessing"]) { star.job!.progress.phase = phase; expect((await t.request("GET", `/jobs/${id}`)).json().progress.phase).toBe(phase); }
  star.job!.state = "failed"; star.job!.error = { code: "msa_timeout", message: "secret-path" };
  const failed = await t.request("GET", `/jobs/${id}`); expect(failed.json().error.code).toBe("msa_timeout"); expect(failed.body).not.toContain("secret-path");
});
it("AlphaFold verifies all seven files before HTTP success, preserves JSON/HTML bytes and revokes downloads", async () => {
  const t = setup(); await t.create(); t.star.complete();
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
  expect(() => parseArtifacts("alphafold", manifest.slice(1))).toThrow();
  expect(() => parseArtifacts("alphafold", manifest.map(a => ({ ...a, size: 33554433 })))).toThrow();
});
