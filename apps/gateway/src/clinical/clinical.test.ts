import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { issueAccessCredential, type ProviderAdapter } from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { buildGateway } from "../index.js";
import type { StarRequest } from "../imaging/client.js";
import { ImagingError, sha256, type Artifact as TransferArtifact } from "../imaging/contract.js";
import { artifactNames, chunkBytes, fields, modes, owner, parseArtifacts, parseInput, prefix, profiles, usesUpload, type Input, type Job, type Mode as ClinicalMode } from "./contract.js";
import { echoNextOutputOrder } from "./echo-result.js";
import { ClinicalStore } from "./store.js";
import { ClinicalService } from "./service.js";
import { resolveClinicalService } from "./runtime.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
type Mode = Exclude<ClinicalMode, "alphafold" | "alphafold3">;
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const bytes = Buffer.from("public cine fixture"), subjects = ["subj_clinical_a", "subj_clinical_b", "subj_no_pilot"];
export const aipalInput = (): Input => ({ session_id: "private-patient-session", analysis_profile: profiles.aipal, data_policy: "public_or_deidentified", input: {
  clinical_context: "suspected_acute_leukemia", measurements: Object.fromEntries(Object.entries(fields).map(([name, [unit]], i) => [name, { unit, value: [55, 10, 0.5, 1, 100, 90, 340, 300, 2.5, 80][i] }]))
} });
const echoInput = (body = bytes): Input => ({ session_id: "private-patient-session", analysis_profile: profiles.panecho, data_policy: "public_or_deidentified", input: { format: "video", size: body.length, sha256: sha256(body), acquisition: "2d_tte", roi: [0, 0, 1, 1] } });
const inputFor = (mode: Mode): Input => mode === "aipal" ? aipalInput() : mode === "panecho" ? echoInput() : {
  session_id: "private-patient-session", analysis_profile: profiles[mode], data_policy: "public_or_deidentified",
  input: mode === "echonet" ? { ...echoInput().input, view: "a4c", view_confirmation: "human", cine_count: 1 }
    : { format: "ge_muse_xml", size: bytes.length, sha256: sha256(bytes), acquisition: "resting_12_lead_ecg", recording_count: 1, quality_confirmation: "human_reviewed_nonpaced" }
};
const echoResult = (mode: "echonet" | "echonext") => ({
  clinical_validation: false, input_sha256: sha256(bytes),
  model_provenance: { model: mode, learning_only: true, clinical_validation: false, source_revision: "test-revision" },
  ...(mode === "echonet" ? { ef_percent: 60.68, video: { frames: 211, view: "a4c", view_confirmation: "human", roi: [0, 0, 1, 1] },
    segmentation: { frame_count: 211 }, sampling: { frames_per_clip: 32 }, normalization: { training_statistics: false } }
    : { output_order: [...echoNextOutputOrder], scores: Object.fromEntries(echoNextOutputOrder.map(k => [k, 0.5])), thresholds: null })
});
class Star {
  now = Date.now() / 1000; offline = false; loseCreate = false; loseComplete = false; reject = false;
  readonly jobs = new Map<string, { owner: string; job: Job; body: unknown }>();
  readonly keys = new Map<string, string>(); readonly parts = new Map<string, { index: number; size: number; sha256: string }[]>();
  readonly calls: { owner: string; method: string; path: string; key?: string; body?: unknown }[] = [];
  constructor(readonly mode: Mode) {}
  close() {}
  async source() { return Buffer.from("source ZIP fixture"); }
  async json(ownerRef: string, method: string, path: string, opts: StarRequest = {}): Promise<{ status: number; data: Record<string, unknown> }> {
    this.calls.push({ owner: ownerRef, method, path, key: opts.key, body: opts.body });
    if (this.offline) throw new ImagingError(503, "unavailable");
    if (path === "/capabilities") return { status: 200, data: { schema_version: 1, analysis_profile: profiles[this.mode], retention_seconds: 86400, research_only: true } };
    if (path === "/jobs") {
      if (this.reject) { this.reject = false; throw new ImagingError(429, "queue_full"); }
      const key = `${ownerRef}:${opts.key}`, old = this.keys.get(key);
      if (old) return { status: 200, data: structuredClone(this.jobs.get(old)!.job) };
      const id = `job_${randomUUID().replaceAll("-", "")}`, state = this.mode === "aipal" ? "queued" : "uploading";
      const job: Job = { job_id: id, analysis_profile: profiles[this.mode], state, created_at: this.now, updated_at: this.now, expires_at: this.now + 86400, result_revision: null, progress: { phase: state, poll_after_ms: 2000 }, ...(usesUpload(this.mode) ? { chunk_bytes: chunkBytes } : {}) };
      this.keys.set(key, id); this.jobs.set(id, { owner: ownerRef, job, body: opts.body });
      if (this.loseCreate) { this.loseCreate = false; throw new ImagingError(503, "unavailable"); }
      return { status: this.mode === "aipal" ? 202 : 201, data: structuredClone(job) };
    }
    const segments = path.split("/"), id = segments[2]!, stored = this.jobs.get(id);
    if (!stored || stored.owner !== ownerRef || ["deleting", "deleted", "expired"].includes(stored.job.state)) throw new ImagingError(404, "not_found");
    const job = stored.job;
    if (method === "DELETE") { job.state = "deleting"; job.progress = { phase: "deleting" }; }
    if (path.endsWith("/cancel")) { job.state = "cancelled"; job.progress = { phase: "cancelled" }; job.updated_at++; }
    if (segments[3] === "input") {
      if (method === "PUT") {
        const blocks: Buffer[] = []; for await (const part of opts.stream!) blocks.push(part);
        const body = Buffer.concat(blocks), index = Number(segments[5]), previous = this.parts.get(id) ?? [];
        if (sha256(body) !== opts.digest) throw new ImagingError(409, "hash_mismatch");
        if (previous.some(p => p.index === index && p.sha256 !== opts.digest)) throw new ImagingError(409, "chunk_conflict");
        if (!previous.some(p => p.index === index)) previous.push({ index, size: body.length, sha256: opts.digest! }); this.parts.set(id, previous);
        return { status: 200, data: { index, sha256: opts.digest } };
      }
      if (method === "GET") return { status: 200, data: { parts: this.parts.get(id) ?? [], state: job.state } };
      if (path.endsWith("/complete")) {
        if (!(this.parts.get(id)?.length)) throw new ImagingError(409, "incomplete_upload");
        job.state = "queued"; job.progress = { phase: "verifying_upload", poll_after_ms: 2000 }; job.updated_at++;
        if (this.loseComplete) { this.loseComplete = false; throw new ImagingError(503, "unavailable"); }
      }
    }
    if (path.endsWith("/result")) return { status: 200, data: { schema_version: 1, job_id: id, analysis_profile: profiles[this.mode], research_only: true,
      ...(this.mode === "aipal" ? { probabilities: { ALL: 0.2, AML: 0.3, APL: 0.5 } } : this.mode !== "panecho" ? echoResult(this.mode) : { tasks: Array.from({ length: 40 }, (_, n) => ({ name: n === 0 ? "RADimensionM-L(cm)" : `head-${n}`, type: n === 1 ? "multi-class_classification" : "regression", ...(n === 1 ? { probabilities: { a: 0.2, b: 0.8 } } : { value: 0.1, unit: "cm" }) })) }) } };
    return { status: method === "DELETE" || method === "POST" ? 202 : 200, data: structuredClone(job) };
  }
  async artifact(ownerRef: string, path: string, _artifact: TransferArtifact) {
    const stored = this.jobs.get(path.split("/")[2]!); if (stored?.owner !== ownerRef) throw new ImagingError(404, "not_found"); return Readable.from([bytes]);
  }
  completed(id: string) { const job = this.jobs.get(id)!.job; Object.assign(job, { state: "completed", result_revision: 1, updated_at: ++this.now, progress: { phase: "completed" }, artifacts: artifactNames(this.mode).map(name => ({ name, size: bytes.length, sha256: sha256(bytes) })) }); }
}
function setup(mode: Mode, path = ":memory:", star = new Star(mode), logs?: string[], dailyJobs = 10, allAuthenticated = false) {
  const store = new ClinicalStore(path), service = new ClinicalService(mode, store, star, { subjects: new Set(subjects.slice(0, 2)), allAuthenticated, now: () => star.now, limits: { dailyJobs, activeJobs: 1 } });
  const identity = createSqliteStore({ path: ":memory:" });
  const credentials = subjects.map(id => { identity.upsertSubject({ id, label: id, state: "active", createdAt: new Date() }); const key = issueAccessCredential({ subjectId: id, scope: "code", label: "clinical test", expiresAt: new Date(Date.now() + 86400000) }); identity.insertAccessCredential(key.record); return { authorization: `Bearer ${key.token}` }; });
  const provider: ProviderAdapter = { kind: "fake", health: async () => ({ state: "healthy", checkedAt: new Date() }), async *message() { yield { type: "completed" }; } };
  const app = buildGateway({ provider, sessionStore: identity, authMode: "credential", aipalService: mode === "aipal" ? service : null, panechoService: mode === "panecho" ? service : null, imagingService: null,
    echonetService: mode === "echonet" ? service : null, echonextService: mode === "echonext" ? service : null,
    logger: logs ? { stream: { write(line: string) { logs.push(line); } } } : false, clientEventsStore: null, phoneAuthService: null });
  cleanup.push(() => app.close());
  const request = (method: "GET" | "POST" | "PUT" | "DELETE", suffix: string, body?: unknown, account = 0, headers: Record<string, string> = {}) => app.inject({ method, url: prefix(mode) + suffix, headers: { ...credentials[account], ...(body !== undefined && !Buffer.isBuffer(body) ? { "content-type": "application/json" } : {}), ...headers }, payload: body as string });
  const create = (key = "clinical-create-0001", body = inputFor(mode), account = 0) => request("POST", "/jobs", body, account, { "idempotency-key": key });
  return { app, store, service, star, identity, request, create, credentials };
}
describe("clinical public tasks", () => {
  it.each(["echonet", "echonext"] as const)("%s admits future authenticated accounts while denying missing/revoked credentials", async mode => {
    const t = setup(mode, ":memory:", undefined, undefined, 10, true);
    expect((await t.request("GET", "/capabilities", undefined, 2)).json().available).toBe(true);
    const id = (await t.create("new-account-upload", undefined, 2)).json().job_id;
    expect((await t.request("GET", `/jobs/${id}`, undefined, 0)).statusCode).toBe(404);
    const newSubject = "subj_registered_after_gateway_start";
    t.identity.upsertSubject({ id: newSubject, label: "new registration", state: "active", createdAt: new Date() });
    const key = issueAccessCredential({ subjectId: newSubject, scope: "code", label: "new account", expiresAt: new Date(Date.now() + 60000) });
    t.identity.insertAccessCredential(key.record);
    const probe = () => t.app.inject({ url: prefix(mode) + "/capabilities", headers: { authorization: `Bearer ${key.token}` } });
    expect((await probe()).json().available).toBe(true);
    t.identity.setSubjectState(newSubject, "disabled");
    expect((await probe()).statusCode).toBe(401);
    expect((await t.app.inject({ url: prefix(mode) + "/capabilities" })).statusCode).toBe(401);
  });
  it.each(["echonet", "echonext"] as const)("%s rejects malformed requests, oversized or incomplete artifact manifests", mode => {
    const original = inputFor(mode);
    for (const input of [
      { ...original.input, extra: "private" }, { ...original.input, size: mode === "echonet" ? 536870913 : 16777217 },
      mode === "echonet" ? { ...original.input, roi: [0.5, 0, 0.5, 1] } : { ...original.input, quality_confirmation: "automatic" },
      mode === "echonet" ? { ...original.input, view: "a2c" } : { ...original.input, recording_count: 2 }
    ]) expect(() => parseInput(mode, { ...original, input })).toThrow();
    const manifest = artifactNames(mode).map(name => ({ name, size: 33554432, sha256: sha256(bytes) }));
    expect(parseArtifacts(mode, manifest)).toHaveLength(manifest.length);
    expect(() => parseArtifacts(mode, manifest.slice(1))).toThrow();
    expect(() => parseArtifacts(mode, [...manifest, manifest[0]])).toThrow();
    expect(() => parseArtifacts(mode, manifest.map(a => ({ ...a, size: 33554433 })))).toThrow();
  });
  it.each(["echonet", "echonext"] as const)("%s rejects mismatched or clinically mislabelled results and preserves sanitized model errors", async mode => {
    const t = setup(mode), id = (await t.create()).json().job_id; t.star.completed(id);
    const json = t.star.json.bind(t.star); let override: Record<string, unknown> = {};
    t.star.json = async (...args) => { const result = await json(...args); return args[2].endsWith("/result") ? { ...result, data: { ...result.data, ...override } } : result; };
    for (const bad of [{ input_sha256: "0".repeat(64) }, { clinical_validation: true }, { model_provenance: null },
      ...(mode === "echonet" ? [{ ef_percent: 101 }, { segmentation: { frame_count: 1 } }, { normalization: { training_statistics: true } }]
        : [{ scores: { ...Object.fromEntries(echoNextOutputOrder.map(k => [k, 0.5])), shd: 1.1 } }, { output_order: [...echoNextOutputOrder].reverse() }, { thresholds: {} }])]) {
      override = bad; expect((await t.request("GET", `/jobs/${id}/result`)).statusCode).toBe(503);
    }
    override = {}; expect((await t.request("GET", `/jobs/${id}/result`)).statusCode).toBe(200);
    const failed = (await t.create("model-error-account", undefined, 1)).json().job_id;
    Object.assign(t.star.jobs.get(failed)!.job, { state: "failed", progress: { phase: "failed" }, error: { code: "unsupported_voltage_scale", message: "/private/patient/token" } });
    const response = await t.request("GET", `/jobs/${failed}`, undefined, 1);
    expect(response.json().error.code).toBe("unsupported_voltage_scale"); expect(response.body).not.toContain("/private/");
  });
  it.each(["echonet", "echonext"] as const)("%s redacts private paths and rejects every shared database path", async mode => {
    const logs: string[] = [], t = setup(mode, ":memory:", undefined, logs);
    await t.app.inject({ url: prefix(mode) + "/private-patient?token=private-patient" });
    await t.app.inject({ url: `/gateway/%65${mode.slice(1)}/v1/private-patient` });
    expect(logs.join("\n")).not.toContain("private-patient");
    const dir = mkdtempSync(join(tmpdir(), "echo-db-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "shared.db");
    for (const other of ["GATEWAY_SQLITE_PATH", "GATEWAY_CLIENT_EVENTS_SQLITE_PATH", "GATEWAY_IMAGING_SQLITE_PATH", ...modes.filter(m => m !== mode).map(m => `GATEWAY_${m.toUpperCase()}_SQLITE_PATH`)]) {
      const warnings: string[] = [];
      expect(resolveClinicalService(mode, { [`GATEWAY_${mode.toUpperCase()}_MODE`]: "authenticated", [`GATEWAY_${mode.toUpperCase()}_SQLITE_PATH`]: path, [other]: path }, { warn(m) { warnings.push(m); } })).toBeNull();
      expect(warnings).toHaveLength(1);
    }
  });
  for (const mode of modes.filter((m): m is Mode => m !== "alphafold" && m !== "alphafold3")) {
    it(`${mode}: authoritative keys, owner isolation, forged headers and independent admission`, async () => {
      const t = setup(mode); const created = await t.create(); expect(created.statusCode).toBe(mode === "aipal" ? 202 : 201); const id = created.json().job_id;
      expect(t.star.calls[0]?.owner).toBe(owner(mode, subjects[0]!)); expect(t.star.calls[0]?.body).not.toHaveProperty("owner");
      expect(JSON.stringify(t.star.calls)).not.toContain("private-patient-session");
      expect((await t.request("GET", `/jobs/${id}`, undefined, 1, { "x-clinical-owner": owner(mode, subjects[0]!) })).statusCode).toBe(404);
      expect((await t.request("GET", "/capabilities", undefined, 2)).json().available).toBe(false);
      expect((await t.create("not-pilot-create", undefined, 2)).statusCode).toBe(503);
      expect((await t.app.inject({ url: prefix(mode) + "/capabilities" })).statusCode).toBe(401);
      expect((await t.create("another-active-key")).statusCode).toBe(429);
      expect((await t.request("GET", "/source")).headers["x-content-sha256"]).toBe(sha256(Buffer.from("source ZIP fixture")));
    });
    it(`${mode}: replays canonical inputs, rejects changed content and delivers immutable verified artifacts`, async () => {
      const t = setup(mode), input = inputFor(mode); const first = await t.create(); const id = first.json().job_id;
      const reordered = Object.fromEntries(Object.entries(input).reverse()) as Input; expect((await t.create("clinical-create-0001", reordered)).json().job_id).toBe(id);
      expect((await t.create("clinical-create-0001", { ...input, session_id: "another" })).statusCode).toBe(409);
      expect((await t.request("GET", `/jobs/${id}/result`)).statusCode).toBe(409);
      t.star.completed(id); expect((await t.request("GET", `/jobs/${id}/result`)).statusCode).toBe(200);
      for (const name of artifactNames(mode)) {
        const download = await t.request("GET", `/jobs/${id}/artifacts/${name}`); expect(download.rawPayload).toEqual(bytes); expect(download.headers["x-content-sha256"]).toBe(sha256(bytes));
        expect(download.headers["cache-control"]).toBe("no-store, no-transform");
      }
      expect((await t.request("GET", `/jobs/${id}/artifacts/private.txt`)).statusCode).toBe(404);
      t.star.jobs.get(id)!.job.artifacts![0]!.sha256 = "0".repeat(64); expect((await t.request("GET", `/jobs/${id}`)).statusCode).toBe(503);
    });
    it(`${mode}: durable ambiguous create and quota survive restart without duplicate inference`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "clinical-restart-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); const path = join(dir, "control.db");
      const star = new Star(mode), t = setup(mode, path, star, undefined, 1); star.loseCreate = true; expect((await t.create()).statusCode).toBe(503); await t.app.close();
      const restarted = setup(mode, path, star, undefined, 1); star.now += 3; await restarted.service.reconcile();
      const replay = await restarted.create(); expect(replay.statusCode).toBe(200); expect(star.jobs.size).toBe(1);
      const submissions = star.calls.filter(c => c.path === "/jobs"); expect(new Set(submissions.map(c => c.key)).size).toBe(1); expect(submissions[0]!.body).toEqual(submissions[1]!.body);
      await restarted.request("POST", `/jobs/${replay.json().job_id}/cancel`, {}); expect((await restarted.create("another-daily-key")).json().error.code).toBe("quota_exceeded");
    });
    it(`${mode}: cancellation and deletion intents reconcile outages and revoke every read immediately`, async () => {
      const t = setup(mode); const id = (await t.create()).json().job_id; t.star.offline = true;
      expect((await t.request("POST", `/jobs/${id}/cancel`, {})).statusCode).toBe(503);
      t.star.offline = false; t.star.now += 3; await t.service.reconcile(); expect(t.star.jobs.get(id)!.job.state).toBe("cancelled");
      t.star.offline = true; expect((await t.request("DELETE", `/jobs/${id}`)).statusCode).toBe(202);
      for (const suffix of ["", "/result", "/artifacts/result.json"]) expect((await t.request("GET", `/jobs/${id}${suffix}`)).statusCode).toBe(404);
      t.star.offline = false; t.star.now += 3; await t.service.reconcile(); expect(t.star.jobs.get(id)!.job.state).toBe("deleting");
      expect((await t.create()).statusCode).toBe(404);
    });
    it(`${mode}: completed deletion acknowledges a retained upstream revision and releases task capacity`, async () => {
      const t = setup(mode), id = (await t.create()).json().job_id; t.star.completed(id);
      expect((await t.request("GET", `/jobs/${id}`)).json().result_revision).toBe(1);
      const deleted = await t.request("DELETE", `/jobs/${id}`); expect(deleted.statusCode).toBe(202);
      expect(t.store.get(subjects[0]!, id, t.star.now, true).action).toBeNull();
      expect((await t.create("next-after-completed-delete")).statusCode).toBe(mode === "aipal" ? 202 : 201);
    });
  }
  it.each(["panecho", "echonet", "echonext"] as const)("%s streams chunks, validates length/hash, resumes and durably retries input completion", async mode => {
    const t = setup(mode); const id = (await t.create()).json().job_id;
    const upload = (body = bytes, index = "0", hash = sha256(body)) => t.request("PUT", `/jobs/${id}/input/parts/${index}`, body, 0, { "content-type": "application/octet-stream", "content-length": String(body.length), "x-chunk-sha256": hash });
    expect((await upload(bytes, "1")).statusCode).toBe(400); expect((await upload(bytes, "0", "0".repeat(64))).statusCode).toBe(409);
    expect((await upload()).json()).toEqual({ index: 0, size: bytes.length, sha256: sha256(bytes) }); expect((await upload()).statusCode).toBe(200);
    expect((await upload(Buffer.alloc(bytes.length, 4))).statusCode).toBe(409);
    expect((await t.request("GET", `/jobs/${id}/input`)).json().parts).toEqual([{ index: 0, size: bytes.length, sha256: sha256(bytes) }]);
    expect((await t.request("GET", `/jobs/${id}/input`)).json()).toMatchObject({ job_id: id, chunk_bytes: chunkBytes });
    t.star.loseComplete = true; expect((await t.request("POST", `/jobs/${id}/input/complete`, {})).statusCode).toBe(503); t.star.now += 3; await t.service.reconcile();
    expect((await t.request("GET", `/jobs/${id}`)).json().state).toBe("queued"); expect(t.star.jobs.size).toBe(1); expect((await t.request("POST", `/jobs/${id}/input/complete`, {})).statusCode).toBe(202);
  });
  it("an in-flight response cannot undo revocation or discard an undelivered delete", async () => {
    const t = setup("aipal"), id = (await t.create()).json().job_id, json = t.star.json.bind(t.star);
    let release!: () => void, opened!: () => void;
    const waiting = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { opened = r; });
    t.star.json = async (ownerRef, method, path, opts) => {
      const response = await json(ownerRef, method, path, opts);
      if (method === "GET" && path === `/jobs/${id}`) { opened(); await waiting; }
      return response;
    };
    const read = t.service.get(subjects[0]!, id); const denied = expect(read).rejects.toMatchObject({ status: 404 }); await entered;
    t.star.offline = true; expect((await t.request("DELETE", `/jobs/${id}`)).statusCode).toBe(202); release(); await denied;
    expect(t.store.get(subjects[0]!, id, t.star.now, true).action).toBe("delete");
    t.star.offline = false; t.star.now += 3; await t.service.reconcile(); expect(t.star.jobs.get(id)!.job.state).toBe("deleting");
  });
  it("rejects unsupported input before reserving or forwarding any clinical values", async () => {
    const t = setup("aipal"), original = aipalInput(), measurements = original.input.measurements as Record<string, unknown>;
    for (const [bad, status] of [
      [{ ...original, filename: "patient.csv" }, 400], [{ ...original, input: { ...original.input, measurements: {} } }, 422],
      [{ ...original, input: { ...original.input, measurements: { ...measurements, age: { value: 12, unit: "years" } } } }, 422],
      [{ ...original, input: { ...original.input, measurements: { ...measurements, PT_percent: { value: 1, unit: "INR" } } } }, 422]
    ] as const) expect((await t.create("invalid-test-key", bad as Input)).statusCode).toBe(status);
    expect(t.star.calls).toHaveLength(0);
  });
  it("erases sensitive inputs at 24h including SQLite/WAL while retaining input-free tombstones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clinical-expiry-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); const path = join(dir, "control.db"); const t = setup("aipal", path);
    await t.create(); t.star.now += 86401; t.star.offline = true; await t.service.reconcile(); expect((await t.create()).statusCode).toBe(404);
    const db = new DatabaseSync(path, { readOnly: true }); expect(db.prepare("SELECT count(*) AS n FROM clinical_inputs").get()!.n).toBe(0); expect(db.prepare("SELECT count(*) AS n FROM clinical_intents").get()!.n).toBe(1); db.close();
    for (const file of [path, path + "-wal"]) expect(readFileSync(file).includes(Buffer.from("measurements"))).toBe(false);
  });
  it("checkpoints inputs removed by deletion before TTL even when expiry pruning removes no rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clinical-delete-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); const path = join(dir, "control.db"); const t = setup("aipal", path);
    const id = (await t.create()).json().job_id; await t.request("DELETE", `/jobs/${id}`);
    await t.service.reconcile();
    for (const file of [path, path + "-wal"]) expect(readFileSync(file).includes(Buffer.from("measurements"))).toBe(false);
  });
  it("does not auto-retry definite rejection or worker-restarted execution", async () => {
    const t = setup("aipal"); t.star.reject = true; expect((await t.create()).statusCode).toBe(429); t.star.now += 3; await t.service.reconcile(); expect(t.star.jobs.size).toBe(0);
    const id = (await t.create()).json().job_id; Object.assign(t.star.jobs.get(id)!.job, { state: "failed", progress: { phase: "failed" }, error: { code: "worker_restarted", message: "secret /patient/path" } });
    const replay = await t.create(); expect(replay.json().state).toBe("failed"); expect(replay.body).not.toContain("/patient/path"); expect(t.star.jobs.size).toBe(1);
  });
  it("redacts auth failures, unmatched paths, queries and raw input/session/key values", async () => {
    const logs: string[] = [], t = setup("aipal", ":memory:", undefined, logs);
    for (const path of ["/gateway/aipal/v1/patient-secret?path=patient-secret", "/gateway/%61ipal/v1/patient-secret"]) await t.app.inject({ url: path });
    await t.create(); const output = logs.join("\n"); expect(output).toContain("/gateway/aipal/:operation"); for (const text of ["patient-secret", "private-patient-session", "clinical-create-0001", "measurements"]) expect(output).not.toContain(text);
  });
  it("fails closed without opening identity databases or overlapping service paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "clinical-identity-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); const path = join(dir, "identity.db"); const db = new DatabaseSync(path); db.exec("CREATE TABLE subjects(id TEXT); PRAGMA user_version=34"); db.close(); const before = readFileSync(path);
    expect(() => new ClinicalStore(path)).toThrow(); expect(readFileSync(path)).toEqual(before);
    expect(resolveClinicalService("aipal", { GATEWAY_AIPAL_MODE: "pilot", GATEWAY_AIPAL_SQLITE_PATH: path, GATEWAY_PANECHO_SQLITE_PATH: path }, { warn() {} })).toBeNull();
  });
});
