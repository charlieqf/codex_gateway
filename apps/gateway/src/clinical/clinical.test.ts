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
import { chunkBytes, fields, owner, prefix, profiles, type Input, type Job, type Mode } from "./contract.js";
import { ClinicalStore } from "./store.js";
import { ClinicalService } from "./service.js";
import { resolveClinicalService } from "./runtime.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const bytes = Buffer.from("public cine fixture"), subjects = ["subj_clinical_a", "subj_clinical_b", "subj_no_pilot"];
export const aipalInput = (): Input => ({ session_id: "private-patient-session", analysis_profile: profiles.aipal, data_policy: "public_or_deidentified", input: {
  clinical_context: "suspected_acute_leukemia", measurements: Object.fromEntries(Object.entries(fields).map(([name, [unit]], i) => [name, { unit, value: [55, 10, 0.5, 1, 100, 90, 340, 300, 2.5, 80][i] }]))
} });
const echoInput = (body = bytes): Input => ({ session_id: "private-patient-session", analysis_profile: profiles.panecho, data_policy: "public_or_deidentified", input: { format: "video", size: body.length, sha256: sha256(body), acquisition: "2d_tte", roi: [0, 0, 1, 1] } });
class Star {
  now = Date.now() / 1000; offline = false; loseCreate = false; loseComplete = false; reject = false;
  readonly jobs = new Map<string, { owner: string; job: Job; body: unknown }>();
  readonly keys = new Map<string, string>(); readonly parts = new Map<string, { index: number; size: number; sha256: string }[]>();
  readonly calls: { owner: string; method: string; path: string; key?: string; body?: unknown }[] = [];
  constructor(readonly mode: Mode) {}
  close() {}
  async source() { return Buffer.from("source ZIP fixture"); }
  async json(ownerRef: string, method: string, path: string, opts: StarRequest = {}) {
    this.calls.push({ owner: ownerRef, method, path, key: opts.key, body: opts.body });
    if (this.offline) throw new ImagingError(503, "unavailable");
    if (path === "/capabilities") return { status: 200, data: { schema_version: 1, analysis_profile: profiles[this.mode], retention_seconds: 86400, research_only: true } };
    if (path === "/jobs") {
      if (this.reject) { this.reject = false; throw new ImagingError(429, "queue_full"); }
      const key = `${ownerRef}:${opts.key}`, old = this.keys.get(key);
      if (old) return { status: 200, data: structuredClone(this.jobs.get(old)!.job) };
      const id = `job_${randomUUID().replaceAll("-", "")}`, state = this.mode === "aipal" ? "queued" : "uploading";
      const job: Job = { job_id: id, analysis_profile: profiles[this.mode], state, created_at: this.now, updated_at: this.now, expires_at: this.now + 86400, result_revision: null, progress: { phase: state, poll_after_ms: 2000 }, ...(this.mode === "panecho" ? { chunk_bytes: chunkBytes } : {}) };
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
      ...(this.mode === "aipal" ? { probabilities: { ALL: 0.2, AML: 0.3, APL: 0.5 } } : { tasks: Array.from({ length: 40 }, (_, n) => ({ name: n === 0 ? "RADimensionM-L(cm)" : `head-${n}`, type: n === 1 ? "multi-class_classification" : "regression", ...(n === 1 ? { probabilities: { a: 0.2, b: 0.8 } } : { value: 0.1, unit: "cm" }) })) }) } };
    return { status: method === "DELETE" || method === "POST" ? 202 : 200, data: structuredClone(job) };
  }
  async artifact(ownerRef: string, path: string, _artifact: TransferArtifact) {
    const stored = this.jobs.get(path.split("/")[2]!); if (stored?.owner !== ownerRef) throw new ImagingError(404, "not_found"); return Readable.from([bytes]);
  }
  completed(id: string) { const job = this.jobs.get(id)!.job; Object.assign(job, { state: "completed", result_revision: 1, updated_at: ++this.now, progress: { phase: "completed" }, artifacts: (this.mode === "aipal" ? ["result.json", "report.csv"] : ["result.json", "report.csv", "preview.png"]).map(name => ({ name, size: bytes.length, sha256: sha256(bytes) })) }); }
}
function setup(mode: Mode, path = ":memory:", star = new Star(mode), logs?: string[], dailyJobs = 10) {
  const store = new ClinicalStore(path), service = new ClinicalService(mode, store, star, { subjects: new Set(subjects.slice(0, 2)), now: () => star.now, limits: { dailyJobs, activeJobs: 1 } });
  const identity = createSqliteStore({ path: ":memory:" });
  const credentials = subjects.map(id => { identity.upsertSubject({ id, label: id, state: "active", createdAt: new Date() }); const key = issueAccessCredential({ subjectId: id, scope: "code", label: "clinical test", expiresAt: new Date(Date.now() + 86400000) }); identity.insertAccessCredential(key.record); return { authorization: `Bearer ${key.token}` }; });
  const provider: ProviderAdapter = { kind: "fake", health: async () => ({ state: "healthy", checkedAt: new Date() }), async *message() { yield { type: "completed" }; } };
  const app = buildGateway({ provider, sessionStore: identity, authMode: "credential", aipalService: mode === "aipal" ? service : null, panechoService: mode === "panecho" ? service : null, imagingService: null,
    logger: logs ? { stream: { write(line: string) { logs.push(line); } } } : false, clientEventsStore: null, phoneAuthService: null });
  cleanup.push(() => app.close());
  const request = (method: "GET" | "POST" | "PUT" | "DELETE", suffix: string, body?: unknown, account = 0, headers: Record<string, string> = {}) => app.inject({ method, url: prefix(mode) + suffix, headers: { ...credentials[account], ...(body !== undefined && !Buffer.isBuffer(body) ? { "content-type": "application/json" } : {}), ...headers }, payload: body as string });
  const create = (key = "clinical-create-0001", body = mode === "aipal" ? aipalInput() : echoInput(), account = 0) => request("POST", "/jobs", body, account, { "idempotency-key": key });
  return { app, store, service, star, identity, request, create, credentials };
}
describe("clinical public tasks", () => {
  for (const mode of ["aipal", "panecho"] as const) {
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
      const t = setup(mode), input = mode === "aipal" ? aipalInput() : echoInput(); const first = await t.create(); const id = first.json().job_id;
      const reordered = Object.fromEntries(Object.entries(input).reverse()) as Input; expect((await t.create("clinical-create-0001", reordered)).json().job_id).toBe(id);
      expect((await t.create("clinical-create-0001", { ...input, session_id: "another" })).statusCode).toBe(409);
      expect((await t.request("GET", `/jobs/${id}/result`)).statusCode).toBe(409);
      t.star.completed(id); expect((await t.request("GET", `/jobs/${id}/result`)).statusCode).toBe(200);
      const download = await t.request("GET", `/jobs/${id}/artifacts/result.json`); expect(download.rawPayload).toEqual(bytes); expect(download.headers["x-content-sha256"]).toBe(sha256(bytes));
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
  it("PanEcho streams chunks, validates length/hash, resumes and durably retries input completion", async () => {
    const t = setup("panecho"); const id = (await t.create()).json().job_id;
    const upload = (body = bytes, index = "0", hash = sha256(body)) => t.request("PUT", `/jobs/${id}/input/parts/${index}`, body, 0, { "content-type": "application/octet-stream", "content-length": String(body.length), "x-chunk-sha256": hash });
    expect((await upload(bytes, "1")).statusCode).toBe(400); expect((await upload(bytes, "0", "0".repeat(64))).statusCode).toBe(409);
    expect((await upload()).json()).toEqual({ index: 0, size: bytes.length, sha256: sha256(bytes) }); expect((await upload()).statusCode).toBe(200);
    expect((await upload(Buffer.alloc(bytes.length, 4))).statusCode).toBe(409);
    expect((await t.request("GET", `/jobs/${id}/input`)).json().parts).toEqual([{ index: 0, size: bytes.length, sha256: sha256(bytes) }]);
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
