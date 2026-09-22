import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueAccessCredential, type ProviderAdapter } from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { buildGateway } from "../index.js";
import { ImagingError, capabilities, chunkBytes, imagingPrefix as prefix, imagingProfile, ownerReference, sha256, type Artifact, type Job, type JobInput, type Resource, type Study, type StudyInput } from "./contract.js";
import type { StarClient, StarRequest } from "./client.js";
import { ImagingStore, defaultImagingLimits } from "./store.js";
import { ImagingService } from "./service.js";
import { resolveImagingService } from "./runtime.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
const subjectA = "subj_imaging_a", subjectB = "subj_imaging_b";
const bytes = Buffer.from("public test volume bytes");
const studyInput = (body = bytes): StudyInput => ({ format: "nifti", size: body.length, sha256: sha256(body), session_id: "session_shared", data_policy: "public_or_deidentified" });
const jobInput = (study: string): JobInput => ({ study_id: study, study_revision: 1, series_id: "series_0001", analysis_profile: imagingProfile, session_id: "session_shared" });

class FakeStar implements StarClient {
  readonly resources = new Map<string, { owner: string; value: Resource }>();
  readonly keys = new Map<string, string>();
  readonly parts = new Map<string, { index: number; size: number; sha256: string }[]>();
  readonly calls: { owner: string; method: string; path: string; key?: string; body?: unknown }[] = [];
  readonly bundle = Buffer.from('{"real_test_fixture":true}');
  now = Date.now() / 1000;
  offline = false;
  rejectNextCreate = false;
  loseNextCreate = false;
  close() {}
  async json(owner: string, method: string, path: string, options: StarRequest = {}) {
    this.calls.push({ owner, method, path, key: options.key, body: options.body });
    if (this.offline) throw new ImagingError(503, "unavailable");
    if (path === "/capabilities") return { status: 200, data: capabilities(true) };
    if (method === "POST" && ["/studies", "/jobs"].includes(path)) {
      if (this.rejectNextCreate) { this.rejectNextCreate = false; throw new ImagingError(429, "queue_full"); }
      const key = `${owner}:${path}:${options.key}`;
      const old = this.keys.get(key);
      if (old) return { status: 200, data: structuredClone(this.resources.get(old)!.value) };
      const b = options.body!;
      const id = `${path === "/studies" ? "study" : "job"}_${randomUUID().replaceAll("-", "")}`;
      const value: Resource = path === "/studies" ? {
        study_id: id, study_revision: 1, format: b.format as string, size: b.size as number, sha256: b.sha256 as string,
        state: "uploading", chunk_bytes: chunkBytes, series: [], expires_at: this.now + 86400
      } : { job_id: id, study_id: b.study_id as string, series_id: b.series_id as string, state: "queued", stage: "queued",
        result_revision: null, created_at: this.now, updated_at: this.now, expires_at: this.now + 86400 };
      this.keys.set(key, id); this.resources.set(id, { owner, value });
      if (this.loseNextCreate) { this.loseNextCreate = false; throw new ImagingError(503, "unavailable"); }
      return { status: path === "/studies" ? 201 : 202, data: structuredClone(value) };
    }
    const segments = path.split("/");
    const id = segments[2]!;
    const stored = this.resources.get(id);
    if (!stored || stored.owner !== owner) throw new ImagingError(404, "not_found");
    const value = stored.value;
    if (method === "DELETE") { value.state = "deleting"; return { status: 202, data: structuredClone(value) }; }
    if (["deleting", "deleted", "expired"].includes(value.state)) throw new ImagingError(404, "not_found");
    if (method === "PUT") {
      const data: Buffer[] = [];
      for await (const chunk of options.stream!) data.push(chunk);
      const content = Buffer.concat(data);
      if (sha256(content) !== options.digest) throw new ImagingError(409, "hash_mismatch");
      const index = Number(segments[5]);
      const parts = this.parts.get(id) ?? [];
      const old = parts.find(p => p.index === index);
      if (old && old.sha256 !== options.digest) throw new ImagingError(409, "chunk_conflict");
      const part = { index, size: content.length, sha256: options.digest! };
      if (!old) parts.push(part);
      this.parts.set(id, parts);
      return { status: 200, data: part };
    }
    if (segments[3] === "upload") return { status: 200, data: { study_id: id, chunk_bytes: chunkBytes, received: this.parts.get(id) ?? [] } };
    if (segments[3] === "complete") {
      if ((this.parts.get(id) ?? []).length !== Math.ceil((value as Study).size / chunkBytes)) throw new ImagingError(409, "incomplete_upload");
      if (value.state === "uploading") value.state = "validating";
    }
    if (segments[3] === "cancel") { value.state = "cancelled"; (value as Job).stage = "cancelled"; (value as Job).updated_at++; }
    if (segments[3] === "result") return { status: 200, data: { schema_version: 1, job_id: id, result_revision: 1, bundle_path: "bundle.json", artifacts: [{ path: "bundle.json", size: this.bundle.length, sha256: sha256(this.bundle) }] } };
    return { status: 200, data: structuredClone(value) };
  }
  async artifact(owner: string, path: string, _artifact: Artifact) {
    if (this.resources.get(path.split("/")[2]!)?.owner !== owner) throw new ImagingError(404, "not_found");
    return Readable.from([this.bundle]);
  }
  ready(id: string) {
    const study = this.resources.get(id)!.value as Study;
    study.state = "ready";
    study.series = [{ series_id: "series_0001", modality: "CT", shape_xyz: [2, 2, 2], spacing_xyz: [1, 1, 1], phase: null, eligible: true }];
  }
  completed(id: string) {
    Object.assign(this.resources.get(id)!.value, { state: "completed", stage: "completed", result_revision: 1, updated_at: ++this.now });
  }
}
function setup(path = ":memory:", limits = defaultImagingLimits, logs?: string[]) {
  const star = new FakeStar();
  const control = new ImagingStore(path);
  const imaging = new ImagingService(control, star, { subjects: new Set([subjectA, subjectB]), limits, now: () => star.now });
  const identity = createSqliteStore({ path: ":memory:" });
  const credentials = [subjectA, subjectB, "subj_not_allowed"].map(id => {
    identity.upsertSubject({ id, label: id, state: "active", createdAt: new Date() });
    const key = issueAccessCredential({ subjectId: id, scope: "code", label: "imaging test", expiresAt: new Date(Date.now() + 86400000) });
    identity.insertAccessCredential(key.record);
    return { authorization: `Bearer ${key.token}` };
  });
  const provider: ProviderAdapter = { kind: "fake", health: async () => ({ state: "healthy", checkedAt: new Date() }), async *message() { yield { type: "completed" }; } };
  const app = buildGateway({ provider, sessionStore: identity, authMode: "credential", imagingService: imaging,
    logger: logs ? { stream: { write: (line: string) => { logs.push(line); } } } : false, clientEventsStore: null, phoneAuthService: null });
  cleanup.push(() => app.close());
  const request = (method: "GET" | "POST" | "PUT" | "DELETE", suffix: string, payload?: unknown, account = 0, headers: Record<string, string> = {}) => app.inject({ method, url: prefix + suffix,
    headers: { ...credentials[account], ...(payload !== undefined && !Buffer.isBuffer(payload) ? { "content-type": "application/json" } : {}), ...headers }, payload: payload as string });
  const create = async (key = "create-study-0001", account = 0, input = studyInput()) => request("POST", "/studies", input, account, { "idempotency-key": key });
  return { app, star, control, imaging, identity, credentials, request, create };
}

describe("imaging public v1", () => {
  it("projects resource waits without private scheduler details and clears them on completion", async () => {
    const t = setup(); const id = (await t.create()).json().study_id;
    const study = t.star.resources.get(id)!.value as Study;
    Object.assign(study, { state: "validating", progress: { phase: "waiting_resources", wait_reason: "waiting_memory", poll_after_ms: 2000,
      message: "/private/task/path", task_id: "private-scheduler-id", host_available_mib: 44400 } });
    const read = await t.request("GET", `/studies/${id}`);
    expect(read.statusCode).toBe(200);
    expect(read.json().progress).toEqual({ phase: "waiting_resources", wait_reason: "waiting_memory", poll_after_ms: 2000 });
    expect(read.body).not.toContain("private");
    expect((await t.request("GET", `/studies/${id}`, undefined, 1)).statusCode).toBe(404);
    t.star.ready(id);
    expect((await t.request("GET", `/studies/${id}`)).json()).not.toHaveProperty("progress");
    const created = await t.request("POST", "/jobs", jobInput(id), 0, { "idempotency-key": "wait-progress-job" });
    const jobId = created.json().job_id;
    const job = t.star.resources.get(jobId)!.value as Job;
    for (const wait_reason of ["queued", "waiting_memory", "waiting_gpu", "scheduler_unavailable", "recovering"] as const) {
      job.progress = { phase: "waiting_resources", wait_reason, poll_after_ms: 2000 };
      expect((await t.request("GET", `/jobs/${jobId}`)).json().progress.wait_reason).toBe(wait_reason);
    }
    t.star.completed(jobId);
    expect((await t.request("GET", `/jobs/${jobId}`)).json()).not.toHaveProperty("progress");
  });
  it("rejects malformed progress but accepts older resources without it", async () => {
    const t = setup(); const id = (await t.create()).json().study_id;
    const study = t.star.resources.get(id)!.value;
    study.state = "validating";
    expect((await t.request("GET", `/studies/${id}`)).statusCode).toBe(200);
    for (const progress of [
      null, [], "private-status-message",
      { phase: "waiting_resources", wait_reason: "private-code", poll_after_ms: 2000 },
      { phase: "waiting_resources", poll_after_ms: 2000 },
      { phase: "parsing", wait_reason: "waiting_memory", poll_after_ms: 2000 },
      { phase: "parsing", poll_after_ms: 1 },
    ]) {
      Object.assign(study, { progress });
      expect((await t.request("GET", `/studies/${id}`)).statusCode).toBe(503);
    }
  });
  it("persists successful and rejected HTTP operations in the independent audit database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "imaging-audit-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "imaging.db"), logs: string[] = [];
    const t = setup(path, defaultImagingLimits, logs);
    const created = await t.create();
    const id = created.json().study_id;
    const denied = await t.request("GET", `/studies/${id}`, undefined, 1);
    await t.app.close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("SELECT subject,request_id,operation,resource_id,status,error_code FROM imaging_audit ORDER BY id").all()).toEqual([
        { subject: subjectA, request_id: created.headers["x-request-id"], operation: `POST ${prefix}/studies`, resource_id: null, status: 201, error_code: null },
        { subject: subjectB, request_id: denied.headers["x-request-id"], operation: `GET ${prefix}/studies/:id`, resource_id: id, status: 404, error_code: "not_found" }
      ]);
      expect(logs.some(line => line.includes("Imaging audit write failed"))).toBe(false);
    } finally { db.close(); }
  });
  it("uses authoritative credentials, isolates owners despite the same session, and refuses forged service headers", async () => {
    const t = setup();
    const anonymous = await t.app.inject({ url: prefix + "/capabilities" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { retryable: false }, request_id: expect.any(String) });
    expect((await t.request("GET", "/capabilities", undefined, 2)).json().available).toBe(false);
    expect((await t.create("create-denied-001", 2)).statusCode).toBe(503);
    const created = await t.create(); expect(created.statusCode).toBe(201);
    const id = created.json().study_id;
    for (const [method, suffix, body] of [["GET", "", undefined], ["GET", "/upload", undefined], ["POST", "/complete", {}], ["DELETE", "", undefined]] as const) {
      const response = await t.request(method, `/studies/${id}${suffix}`, body, 1, { "x-imaging-owner": ownerReference(subjectA), "x-service-authorization": "forged" });
      expect(response.statusCode).toBe(404);
    }
    expect(t.star.calls.filter(c => c.path !== "/capabilities").every(c => c.owner === ownerReference(subjectA))).toBe(true);
    expect((t.star.calls[0]?.body as StudyInput).session_id).not.toBe("session_shared");
    expect((await t.create("create-study-0001", 1)).statusCode).toBe(201);
  });
  it("replays identical requests and conflicts on any changed input including endpoint", async () => {
    const t = setup();
    const created = await t.create();
    expect((await t.create()).json().study_id).toBe(created.json().study_id);
    expect((await t.create()).statusCode).toBe(200);
    expect((await t.create("create-study-0001", 0, { ...studyInput(), size: 10 })).statusCode).toBe(409);
    expect((await t.request("POST", "/jobs", jobInput(created.json().study_id), 0, { "idempotency-key": "create-study-0001" })).statusCode).toBe(409);
    expect(t.star.resources.size).toBe(1);
  });
  it("streams chunks with exact size/hash, supports resume/replay and idempotent complete", async () => {
    const t = setup(); const id = (await t.create()).json().study_id;
    expect((await t.request("POST", `/studies/${id}/complete`, {})).statusCode).toBe(409);
    const upload = (body: Buffer, digest = sha256(body), index = "0") => t.request("PUT", `/studies/${id}/upload/parts/${index}`, body, 0,
      { "content-type": "application/octet-stream", "content-length": String(body.length), "x-content-sha256": digest });
    expect((await upload(bytes, "0".repeat(64))).statusCode).toBe(409);
    expect((await upload(bytes.subarray(0, 3))).statusCode).toBe(400);
    expect((await upload(bytes, sha256(bytes), "1")).statusCode).toBe(400);
    expect((await upload(bytes)).statusCode).toBe(200);
    expect((await upload(bytes)).statusCode).toBe(200);
    expect((await upload(Buffer.alloc(bytes.length, 5))).statusCode).toBe(409);
    expect((await t.request("GET", `/studies/${id}/upload`)).json().received).toEqual([{ index: 0, size: bytes.length, sha256: sha256(bytes) }]);
    for (let i = 0; i < 2; i++) expect((await t.request("POST", `/studies/${id}/complete`, {})).json().state).toBe("validating");
  });
  it("rejects oversized/malformed/unsupported input before any upstream submission", async () => {
    const t = setup();
    const cases = [{ value: { ...studyInput(), filename: "patient-name.nii" }, status: 400 },
      { value: { ...studyInput(), size: 512 * 1024 * 1024 + 1 }, status: 413 },
      { value: { ...studyInput(), format: "png" }, status: 422 },
      { value: { ...studyInput(), data_policy: "identifiable" }, status: 422 }];
    for (const c of cases) expect((await t.request("POST", "/studies", c.value, 0, { "idempotency-key": "invalid-request-test" })).statusCode).toBe(c.status);
    expect(t.star.calls.length).toBe(0);
    const oversized = await t.request("POST", "/studies", { text: "x".repeat(20000) });
    expect(oversized.statusCode).toBe(413); expect(oversized.json().request_id).toBeTruthy();
    const malformed = await t.app.inject({ method: "POST", url: prefix + "/studies", headers: { ...t.credentials[0], "content-type": "application/json" }, payload: "{" });
    expect(malformed.statusCode).toBe(400);
  });
  it("persists ambiguous submissions across restart and reuses the same upstream key without another inference", async () => {
    const directory = mkdtempSync(join(tmpdir(), "imaging-recovery-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "imaging.db"); const t = setup(path);
    const study = (await t.create()).json().study_id; t.star.ready(study);
    t.star.loseNextCreate = true;
    const failed = await t.request("POST", "/jobs", jobInput(study), 0, { "idempotency-key": "ambiguous-job-0001" });
    expect(failed.statusCode).toBe(503); expect(t.star.resources.size).toBe(2);
    await t.app.close();
    const reopened = new ImagingStore(path);
    const recovered = new ImagingService(reopened, t.star, { subjects: new Set([subjectA]), now: () => t.star.now });
    cleanup.push(() => recovered.close());
    t.star.now += 3;
    await recovered.reconcile();
    const replay = await recovered.create(subjectA, "job", jobInput(study), "ambiguous-job-0001");
    expect(replay.status).toBe(200); expect(replay.resource.state).toBe("queued"); expect(t.star.resources.size).toBe(2);
    const submissions = t.star.calls.filter(c => c.method === "POST" && c.path === "/jobs");
    expect(new Set(submissions.map(c => c.key)).size).toBe(1);
    const db = new DatabaseSync(path, { readOnly: true });
    try { expect(db.prepare("SELECT gpu_seconds FROM imaging_intents WHERE kind='job'").get()?.gpu_seconds).toBeNull(); }
    finally { db.close(); }
  });
  it("persists job quota, cancels explicitly, restricts artifact paths and revokes every related read on deletion", async () => {
    const t = setup(); const id = (await t.create()).json().study_id; t.star.ready(id);
    const job = await t.request("POST", "/jobs", jobInput(id), 0, { "idempotency-key": "analysis-job-0001" });
    expect(job.statusCode).toBe(202); const jobId = job.json().job_id;
    expect((await t.request("POST", "/jobs", jobInput(id), 0, { "idempotency-key": "analysis-job-0002" })).statusCode).toBe(429);
    expect((await t.request("GET", `/jobs/${jobId}/result`)).statusCode).toBe(409);
    t.star.completed(jobId);
    expect((await t.request("GET", `/jobs/${jobId}/result`)).json().result_revision).toBe(1);
    for (const suffix of ["", "/result", "/artifacts?path=bundle.json"]) expect((await t.request("GET", `/jobs/${jobId}${suffix}`, undefined, 1)).statusCode).toBe(404);
    for (const path of ["../bundle.json", "/etc/passwd", "https://private/secret", "unknown.png"]) expect((await t.request("GET", `/jobs/${jobId}/artifacts?path=${encodeURIComponent(path)}`)).statusCode).toBe(404);
    const download = await t.request("GET", `/jobs/${jobId}/artifacts?path=bundle.json`);
    expect(download.rawPayload).toEqual(t.star.bundle); expect(download.headers["x-content-sha256"]).toBe(sha256(t.star.bundle));
    const second = await t.request("POST", "/jobs", jobInput(id), 0, { "idempotency-key": "analysis-job-0002" });
    expect(second.statusCode).toBe(202);
    t.star.offline = true;
    expect((await t.request("POST", `/jobs/${second.json().job_id}/cancel`, {})).statusCode).toBe(503);
    t.star.offline = false; t.star.now += 3; await t.imaging.reconcile();
    expect((await t.request("GET", `/jobs/${second.json().job_id}`)).json().state).toBe("cancelled");
    t.star.offline = true;
    expect((await t.request("DELETE", `/studies/${id}`)).statusCode).toBe(202);
    expect((await t.request("GET", `/jobs/${jobId}/artifacts?path=bundle.json`)).statusCode).toBe(404);
    expect((await t.request("GET", `/studies/${id}`)).statusCode).toBe(404);
    t.star.offline = false; t.star.now += 3; await t.imaging.reconcile();
    expect(t.star.resources.get(id)!.value.state).toBe("deleting");
  });
  it("expires locally even while star is unreachable and rejects old idempotency keys", async () => {
    const t = setup(); const id = (await t.create()).json().study_id;
    t.star.now += 86401; t.star.offline = true;
    expect((await t.request("GET", `/studies/${id}`)).statusCode).toBe(404);
    expect((await t.create()).statusCode).toBe(404);
  });
  it("enforces durable daily allowances independently of chat admission", async () => {
    const t = setup(":memory:", { ...defaultImagingLimits, dailyJobs: 1 });
    const id = (await t.create()).json().study_id; t.star.ready(id);
    const first = await t.request("POST", "/jobs", jobInput(id), 0, { "idempotency-key": "limited-job-0001" });
    await t.request("POST", `/jobs/${first.json().job_id}/cancel`, {});
    const next = await t.request("POST", "/jobs", jobInput(id), 0, { "idempotency-key": "limited-job-0002" });
    expect(next.statusCode).toBe(429); expect(next.json().error.code).toBe("quota_exceeded");
    expect((await t.app.inject({ url: "/gateway/health" })).statusCode).toBe(200);
    const permits = Array.from({ length: 4 }, () => t.imaging.enter(subjectA, false));
    expect(() => t.imaging.enter(subjectA, false)).toThrow(ImagingError);
    permits.forEach(release => release()); expect(() => t.imaging.enter(subjectA, false)()).not.toThrow();
  });
  it("keeps malformed imaging configuration fail-closed and separate from identity storage", () => {
    const warn = vi.fn();
    expect(resolveImagingService({}, { warn })).toBeNull();
    expect(resolveImagingService({ GATEWAY_IMAGING_MODE: "pilot", GATEWAY_IMAGING_SQLITE_PATH: "gateway.db", GATEWAY_SQLITE_PATH: "gateway.db" }, { warn })).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
  it("never logs client filenames, raw idempotency keys, session associations or artifact queries", async () => {
    const logs: string[] = []; const t = setup(":memory:", defaultImagingLimits, logs);
    for (const url of [prefix + "/jobs/job_patient-name/artifacts?path=patient-name.nii", prefix + "/unknown/patient-name.nii", "/gateway/%69maging/v1/unknown/patient-name.nii"]) {
      await t.app.inject({ url, headers: { "idempotency-key": "secret-idempotency-key" } });
    }
    await t.create("secret-idempotency-key", 0, { ...studyInput(), session_id: "private-session" });
    const output = logs.join("\n");
    expect(output).toContain("/gateway/imaging/:operation");
    for (const forbidden of ["patient-name", "secret-idempotency-key", "private-session", "public test volume bytes"]) expect(output).not.toContain(forbidden);
  });
  it("never opens an identity database for imaging migrations", () => {
    const directory = mkdtempSync(join(tmpdir(), "imaging-wrong-db-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "identity.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE subjects(id TEXT); PRAGMA user_version=34;"); db.close();
    const before = readFileSync(path);
    expect(() => new ImagingStore(path)).toThrow(ImagingError);
    expect(readFileSync(path)).toEqual(before);
  });
  it("requires explicit retries of definite 429s, and never replays worker-restarted executions", async () => {
    const t = setup(); const id = (await t.create()).json().study_id; t.star.ready(id);
    t.star.rejectNextCreate = true;
    const createJob = () => t.request("POST", "/jobs", jobInput(id), 0, { "idempotency-key": "rejected-job-0001" });
    expect((await createJob()).statusCode).toBe(429);
    t.star.now += 3; await t.imaging.reconcile();
    expect(t.star.resources.size).toBe(1);
    const retry = await createJob(); expect(retry.statusCode).toBe(200);
    const jobId = retry.json().job_id;
    Object.assign(t.star.resources.get(jobId)!.value, { state: "failed", stage: "interrupted", updated_at: ++t.star.now,
      error: { code: "worker_restarted", message: "/private/path/should-not-escape", retryable: true } });
    const result = await createJob();
    expect(result.json()).toMatchObject({ job_id: jobId, state: "failed", error: { code: "worker_restarted" } });
    expect(result.body).not.toContain("/private/path");
    expect(t.star.resources.size).toBe(2);
  });
  it("preserves rejected series without invented geometry, while eligible series require validated dimensions", async () => {
    const t = setup(); const id = (await t.create()).json().study_id; t.star.ready(id);
    const study = t.star.resources.get(id)!.value as Study;
    study.series.push({ series_id: "series_0002", modality: "CT", phase: null, eligible: false, reason: "slice_count_out_of_range" });
    const read = await t.request("GET", `/studies/${id}`);
    expect(read.statusCode).toBe(200);
    expect(read.json().series[1]).toEqual(study.series[1]);
    study.series[1]!.eligible = true;
    expect((await t.request("GET", `/studies/${id}`)).statusCode).toBe(503);
  });
});
