import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VerifiedStream, type StarClient } from "../imaging/client.js";
import { ImagingError, sha256 } from "../imaging/contract.js";
import { ClinicalStore, type Action, type Intent, type Limits } from "./store.js";
import { capabilities, chunkBytes, ClinicalError, hashPattern, identifier, object, owner, parseInput, parseJob, profiles, requireClinical, terminal, type Input, type Job, type Mode } from "./contract.js";

export type ClinicalClient = StarClient & { source(owner: string, signal?: AbortSignal): Promise<Buffer> };
export class ClinicalService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly admissions = new Map<string, { minute: number; requests: number; active: number; transfers: number }>();
  private active = 0; private transfers = 0; private closed = false; private timer?: NodeJS.Timeout; private syncing?: Promise<void>;
  constructor(readonly mode: Mode, readonly store: ClinicalStore, private readonly star: ClinicalClient, private readonly options: {
    subjects: ReadonlySet<string>; limits?: Limits; now?: () => number; onRecoveryError?: () => void
  }) {}
  now() { return this.options.now?.() ?? Date.now() / 1000; }
  allowed(subject: string) { return this.options.subjects.has(subject); }
  enter(subject: string, transfer: boolean) {
    requireClinical(!this.closed && this.allowed(subject), 503, "unavailable");
    const minute = Math.floor(this.now() / 60), entry = this.admissions.get(subject) ?? { minute, requests: 0, active: 0, transfers: 0 };
    this.admissions.set(subject, entry); if (entry.minute !== minute) { entry.minute = minute; entry.requests = 0; }
    requireClinical(entry.requests < 240 && entry.active < 4 && this.active < 8 && (!transfer || (entry.transfers < 2 && this.transfers < 4)), 429, "queue_full");
    entry.requests++; entry.active++; this.active++; if (transfer) { entry.transfers++; this.transfers++; }
    let released = false;
    return () => { if (released) return; released = true; entry.active--; this.active--; if (transfer) { entry.transfers--; this.transfers--; } };
  }
  async capabilities(subject: string) {
    if (!this.allowed(subject)) return capabilities(this.mode, false);
    try {
      const b = object((await this.star.json(owner(this.mode, subject), "GET", "/capabilities")).data);
      requireClinical(b.schema_version === 1 && b.analysis_profile === profiles[this.mode] && b.retention_seconds === 86400 && b.research_only === true, 503, "upstream_protocol_error");
      return capabilities(this.mode, true);
    } catch { return capabilities(this.mode, false); }
  }
  async create(subject: string, raw: unknown, rawKey: unknown) {
    const parsed = parseInput(this.mode, raw), input: Input = { ...parsed, session_id: sha256(`${owner(this.mode, subject)}:session:${parsed.session_id}`) };
    requireClinical(typeof rawKey === "string" && /^[A-Za-z0-9_.:-]{8,128}$/.test(rawKey), 400, "invalid_idempotency_key");
    const key = sha256(rawKey);
    return this.lock(`${subject}:${key}`, async () => {
      const { intent, replay } = this.store.reserve(subject, key, input, this.now(), this.options.limits ?? { dailyJobs: 10, activeJobs: 1 });
      if (intent.errorStatus && ![429, 503].includes(intent.errorStatus) && !intent.id) throw new ClinicalError(intent.errorStatus, intent.errorCode!);
      const job = intent.id ? await this.refresh(intent) : await this.submit(intent);
      return { status: replay ? 200 : this.mode === "aipal" ? 202 : 201, job };
    });
  }
  owned(subject: string, id: string, includeRevoked = false) {
    requireClinical(identifier(id), 404, "not_found"); return this.store.get(subject, id, this.now(), includeRevoked);
  }
  async get(subject: string, id: string) { return this.refresh(this.owned(subject, id)); }
  private checked(intent: Intent, raw: unknown) {
    const job = parseJob(this.mode, raw);
    requireClinical(!intent.id || intent.id === job.job_id, 503, "upstream_protocol_error");
    const saved = this.store.save(intent, job, this.now());
    this.owned(intent.subject, job.job_id); return saved.job!;
  }
  private async submit(intent: Intent) {
    requireClinical(intent.input && !intent.revoked && intent.expires > this.now(), 404, "not_found");
    try { const result = await this.star.json(owner(this.mode, intent.subject), "POST", "/jobs", { body: intent.input, key: intent.key }); return this.checked(intent, result.data); }
    catch (error) { this.failure(intent, error); throw error; }
  }
  private async refresh(intent: Intent): Promise<Job> {
    if (intent.action) return this.deliverAction(intent);
    try { return this.checked(intent, (await this.star.json(owner(this.mode, intent.subject), "GET", `/jobs/${intent.id}`)).data); }
    catch (error) { this.failure(intent, error); throw error; }
  }
  async inputStatus(subject: string, id: string) {
    const intent = this.owned(subject, id); requireClinical(this.mode === "panecho", 404, "not_found");
    const response = object((await this.star.json(owner(this.mode, subject), "GET", `/jobs/${id}/input`)).data);
    const size = Number(intent.input?.input.size);
    requireClinical(Array.isArray(response.parts) && response.parts.length <= 64 && ["uploading", "queued", "running", "completed", "failed", "cancel_requested", "cancelled"].includes(String(response.state)), 503, "upstream_protocol_error");
    const parts = response.parts.map(value => { const p = object(value); const index = Number(p.index);
      requireClinical(Number.isSafeInteger(p.index) && index >= 0 && index < Math.ceil(size / chunkBytes) && p.size === Math.min(chunkBytes, size - index * chunkBytes) && typeof p.sha256 === "string" && hashPattern.test(p.sha256), 503, "upstream_protocol_error");
      return { index, size: Number(p.size), sha256: p.sha256 as string };
    });
    requireClinical(new Set(parts.map(p => p.index)).size === parts.length, 503, "upstream_protocol_error");
    this.owned(subject, id); return { job_id: id, chunk_bytes: chunkBytes, state: response.state, parts };
  }
  async upload(subject: string, id: string, rawIndex: string, length: unknown, digest: unknown, stream: Readable, signal?: AbortSignal) {
    const intent = this.owned(subject, id);
    requireClinical(this.mode === "panecho" && intent.state === "uploading" && !intent.action, 409, "state_conflict");
    requireClinical(/^(0|[1-9][0-9]?)$/.test(rawIndex), 400, "invalid_chunk");
    const index = Number(rawIndex), size = Number(intent.input?.input.size), expected = Math.min(chunkBytes, size - index * chunkBytes);
    requireClinical(expected > 0 && typeof length === "string" && /^[0-9]+$/.test(length) && Number(length) === expected, 400, "invalid_chunk");
    requireClinical(typeof digest === "string" && hashPattern.test(digest));
    const guarded = new VerifiedStream(expected, digest, () => { this.owned(subject, id); });
    const feeding = pipeline(stream, guarded);
    const sending = this.star.json(owner(this.mode, subject), "PUT", `/jobs/${id}/input/parts/${index}`, { stream: guarded, length: expected, digest, signal });
    try {
      const [result] = await Promise.all([sending, feeding]); const part = object(result.data);
      requireClinical(part.index === index && part.sha256 === digest, 503, "upstream_protocol_error");
      this.owned(subject, id); return { index, size: expected, sha256: digest };
    } finally { guarded.destroy(); }
  }
  async action(subject: string, id: string, action: Action) {
    const intent = this.owned(subject, id, action === "delete");
    if (action === "complete") requireClinical(this.mode === "panecho" && !["cancelled", "cancel_requested", "failed"].includes(intent.state), 409, "state_conflict");
    return this.lock(`${subject}:${intent.key}`, async () => {
      const current = this.store.action(subject, id, action, this.now());
      if (!current.action) return current.job!;
      try { return await this.deliverAction(current); }
      catch (error) { if (action === "delete" && error instanceof ImagingError && error.status === 503) return current.job!; throw error; }
    });
  }
  private async deliverAction(intent: Intent): Promise<Job> {
    const action = intent.action!;
    try {
      const result = await this.star.json(owner(this.mode, intent.subject), action === "delete" ? "DELETE" : "POST",
        `/jobs/${intent.id}${action === "delete" ? "" : action === "complete" ? "/input/complete" : "/cancel"}`, action === "delete" ? {} : { body: {} });
      const job = parseJob(this.mode, result.data); requireClinical(job.job_id === intent.id, 503, "upstream_protocol_error");
      if (action === "delete") { requireClinical(["deleting", "deleted", "expired"].includes(job.state), 503, "upstream_protocol_error"); this.store.actionDone(intent, this.now()); return intent.job!; }
      const saved = this.checked(intent, result.data);
      if (action === "complete" || terminal.has(saved.state)) this.store.clearAction(intent);
      return saved;
    } catch (error) {
      if (error instanceof ImagingError && error.status === 404 && action === "delete") { this.store.actionDone(intent, this.now()); return intent.job!; }
      if (action === "complete" && error instanceof ImagingError && error.status !== 503) this.store.clearAction(intent);
      this.failure(intent, error); throw error;
    }
  }
  async result(subject: string, id: string) {
    const job = await this.get(subject, id); requireClinical(job.state === "completed", 409, "result_not_ready");
    const data = object((await this.star.json(owner(this.mode, subject), "GET", `/jobs/${id}/result`)).data);
    requireClinical(data.schema_version === 1 && data.job_id === id && data.analysis_profile === profiles[this.mode] && data.research_only === true, 503, "upstream_protocol_error");
    if (this.mode === "aipal") {
      const p = object(data.probabilities); requireClinical(Object.keys(p).length === 3 && ["ALL", "AML", "APL"].every(k => typeof p[k] === "number" && Number.isFinite(p[k]) && Number(p[k]) >= 0 && Number(p[k]) <= 1) && Math.abs(Object.values(p).reduce<number>((sum, n) => sum + Number(n), 0) - 1) < 0.0001, 503, "upstream_protocol_error");
    } else {
      requireClinical(Array.isArray(data.tasks) && data.tasks.length === 40, 503, "upstream_protocol_error");
      const names = new Set<string>();
      for (const raw of data.tasks) { const t = object(raw); requireClinical(typeof t.name === "string" && /^[A-Za-z0-9_.|() -]{1,100}$/.test(t.name) && !names.has(t.name), 503, "upstream_protocol_error"); names.add(t.name);
        requireClinical(["regression", "binary_classification", "multi-class_classification"].includes(String(t.type)), 503, "upstream_protocol_error");
        if (t.type === "regression") requireClinical(typeof t.value === "number" && Number.isFinite(t.value) && typeof t.unit === "string", 503, "upstream_protocol_error");
        else if (t.type === "binary_classification") requireClinical(typeof t.probability === "number" && Number.isFinite(t.probability) && t.probability >= 0 && t.probability <= 1 && typeof t.positive_class === "string", 503, "upstream_protocol_error");
        else { const p = object(t.probabilities); requireClinical(Object.keys(p).length > 1 && Object.values(p).every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) && Math.abs(Object.values(p).reduce<number>((sum, n) => sum + Number(n), 0) - 1) < 0.0001, 503, "upstream_protocol_error"); }
      }
    }
    this.owned(subject, id); return data;
  }
  async artifact(subject: string, id: string, name: string, signal?: AbortSignal) {
    const job = await this.get(subject, id); requireClinical(job.state === "completed", 409, "result_not_ready");
    const artifact = job.artifacts?.find(a => a.name === name); requireClinical(artifact, 404, "not_found");
    const source = await this.star.artifact(owner(this.mode, subject), `/jobs/${id}/artifacts/${artifact.name}`, { path: name, size: artifact.size, sha256: artifact.sha256 }, signal);
    const stream = new VerifiedStream(artifact.size, artifact.sha256, () => { this.owned(subject, id); });
    void pipeline(source, stream).catch(() => stream.destroy(new ClinicalError(503, "unavailable"))); stream.once("close", () => source.destroy());
    return { artifact, stream };
  }
  source(subject: string, signal?: AbortSignal) { return this.star.source(owner(this.mode, subject), signal); }
  start() { this.store.prune(this.now()); this.timer = setInterval(() => { void this.reconcile(); }, 2000); this.timer.unref(); }
  reconcile() {
    if (this.closed) return Promise.resolve(); if (this.syncing) return this.syncing;
    this.syncing = this.recover().catch(() => this.options.onRecoveryError?.()).finally(() => { this.syncing = undefined; }); return this.syncing;
  }
  private async recover() {
    this.store.prune(this.now());
    for (const intent of this.store.candidates(this.now())) {
      if (this.closed) break;
      await this.lock(`${intent.subject}:${intent.key}`, async () => { const current = this.store.find(intent.subject, intent.key)!; this.store.touch(current, this.now());
        if (current.expires <= this.now()) return;
        try { if (current.action) await this.deliverAction(current); else if (!current.revoked) { if (current.id) await this.refresh(current); else await this.submit(current); } }
        catch { /* Original input/key or durable action remain available for bounded reconciliation. */ }
      });
    }
  }
  private failure(intent: Intent, error: unknown) {
    const e = error instanceof ImagingError ? error : new ClinicalError(503, "unavailable");
    // An in-flight read denied by local revocation cannot erase an undelivered delete.
    if (e.status === 404 && this.store.find(intent.subject, intent.key)?.action !== "delete") this.store.expire(intent, this.now());
    else this.store.failure(intent, e.status, e.code, this.now());
  }
  private async lock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve(), current = prior.catch(() => {}).then(action); this.locks.set(key, current);
    try { return await current; } finally { if (this.locks.get(key) === current) this.locks.delete(key); }
  }
  async close() { this.closed = true; clearInterval(this.timer); this.star.close(); await this.syncing; await Promise.allSettled(this.locks.values()); this.store.prune(this.now()); this.store.close(); }
}
