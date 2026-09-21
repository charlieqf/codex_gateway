import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VerifiedStream, type StarClient } from "./client.js";
import { ImagingStore, defaultImagingLimits, type ImagingLimits, type Intent } from "./store.js";
import {
  ImagingError, capabilities, chunkBytes, fingerprint, hashPattern, identifier, idempotencyKey,
  object, ownerReference, parseCapabilities, parseCreate, parseManifest, parsePart, parseResource,
  requireImaging, resourceId, safeArtifactPath, sha256, type Artifact, type CreateInput, type Job, type JobInput,
  type Kind, type Manifest, type Resource, type Study, type StudyInput
} from "./contract.js";

export class ImagingService {
  readonly limits: ImagingLimits;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly admissions = new Map<string, { minute: number; requests: number; active: number; transfers: number }>();
  private active = 0;
  private transfers = 0;
  private timer?: NodeJS.Timeout;
  private syncing?: Promise<void>;
  private closed = false;
  constructor(readonly store: ImagingStore, private readonly star: StarClient, private readonly options: {
    subjects: ReadonlySet<string>; limits?: ImagingLimits; now?: () => number; onRecoveryError?: () => void;
  }) { this.limits = options.limits ?? defaultImagingLimits; }
  now(): number { return this.options.now?.() ?? Date.now() / 1000; }
  allowed(subject: string): boolean { return this.options.subjects.has(subject); }
  enter(subject: string, transfer: boolean): () => void {
    requireImaging(!this.closed && this.allowed(subject), 503, "unavailable");
    const minute = Math.floor(this.now() / 60);
    let entry = this.admissions.get(subject);
    if (!entry) { entry = { minute, requests: 0, active: 0, transfers: 0 }; this.admissions.set(subject, entry); }
    if (entry.minute !== minute) { entry.minute = minute; entry.requests = 0; }
    requireImaging(entry.requests < 240 && entry.active < 4 && this.active < 8 && (!transfer || (entry.transfers < 2 && this.transfers < 4)), 429, "queue_full");
    entry.requests++; entry.active++; this.active++;
    if (transfer) { entry.transfers++; this.transfers++; }
    let released = false;
    return () => {
      if (released) return;
      released = true; entry!.active--; this.active--;
      if (transfer) { entry!.transfers--; this.transfers--; }
    };
  }
  async capabilities(subject: string) {
    if (!this.allowed(subject)) return capabilities(false);
    try { return await this.remote(async () => parseCapabilities((await this.star.json(ownerReference(subject), "GET", "/capabilities")).data)); }
    catch { return capabilities(false); }
  }
  async create(subject: string, kind: Kind, body: unknown, rawKey: unknown): Promise<{ status: number; resource: Resource }> {
    const parsed = parseCreate(kind, body);
    // Correlation remains deterministic without persisting an arbitrary client string (possibly a filename).
    const input = { ...parsed, session_id: sha256(`${ownerReference(subject)}:session:${parsed.session_id}`) } as CreateInput;
    const key = idempotencyKey(rawKey);
    return this.lock(`${subject}:${key}`, async () => {
      const existing = this.store.find(subject, key);
      if (existing && (existing.kind !== kind || existing.fingerprint !== fingerprint(kind, input))) throw new ImagingError(409, "idempotency_conflict");
      if (!existing && kind === "job") {
        const job = input as JobInput;
        const study = await this.get(subject, "study", job.study_id) as Study;
        requireImaging(study.state === "ready", 409, "study_not_ready");
        requireImaging(study.series.some(s => s.series_id === job.series_id && s.eligible), 422, "invalid_series");
      }
      const reservation = this.store.reserve(subject, key, kind, input, this.now(), this.limits);
      const intent = reservation.intent;
      if (intent.errorStatus && intent.errorStatus !== 429 && intent.errorStatus !== 503 && !intent.resourceId) throw new ImagingError(intent.errorStatus, intent.errorCode!);
      const resource = intent.resourceId ? await this.get(subject, kind, intent.resourceId) : await this.submit(intent);
      return { status: reservation.replay ? 200 : kind === "study" ? 201 : 202, resource };
    });
  }
  async get(subject: string, kind: Kind, id: string): Promise<Resource> {
    const intent = this.owned(subject, kind, id);
    return this.refresh(intent);
  }
  private owned(subject: string, kind: Kind, id: string, includeRevoked = false): Intent {
    requireImaging(identifier(id, kind), 404, "not_found");
    const intent = this.store.get(subject, id, this.now(), includeRevoked);
    requireImaging(intent.kind === kind, 404, "not_found");
    return intent;
  }
  private async submit(intent: Intent): Promise<Resource> {
    if (intent.kind === "job") this.owned(intent.subject, "study", (intent.input as JobInput).study_id);
    try {
      // The original idempotency key is persisted before this call; network ambiguity leaves the reservation pending.
      // Session association was sanitized before persistence; retries send exactly those same fields.
      const body = { ...intent.input };
      const result = await this.star.json(ownerReference(intent.subject), "POST", intent.kind === "study" ? "/studies" : "/jobs", { body, key: intent.key });
      const value = await this.remote(async () => parseResource(intent.kind, result.data));
      this.validateCorrelation(intent, value);
      const saved = this.store.save(intent, value, this.now());
      this.owned(intent.subject, intent.kind, resourceId(value));
      requireImaging(saved.resource, 503, "upstream_protocol_error");
      return saved.resource;
    } catch (error) { this.recordFailure(intent, error); throw error; }
  }
  private validateCorrelation(intent: Intent, value: Resource): void {
    requireImaging(!intent.resourceId || resourceId(value) === intent.resourceId, 503, "upstream_protocol_error");
    if (intent.kind === "study") {
      const input = intent.input as StudyInput, study = value as Study;
      requireImaging(study.format === input.format && study.size === input.size && study.sha256 === input.sha256, 503, "upstream_protocol_error");
    } else {
      const input = intent.input as JobInput, job = value as Job;
      requireImaging(job.study_id === input.study_id && job.series_id === input.series_id, 503, "upstream_protocol_error");
    }
  }
  private async refresh(intent: Intent): Promise<Resource> {
    if (intent.pendingAction === "cancel") return this.deliverAction(intent);
    try {
      const result = await this.star.json(ownerReference(intent.subject), "GET", this.path(intent));
      const value = await this.remote(async () => parseResource(intent.kind, result.data));
      this.validateCorrelation(intent, value);
      const saved = this.store.save(intent, value, this.now());
      this.owned(intent.subject, intent.kind, intent.resourceId!);
      return saved.resource!;
    } catch (error) { this.recordFailure(intent, error); throw error; }
  }
  async uploadStatus(subject: string, id: string) {
    const study = this.owned(subject, "study", id).resource as Study;
    const result = await this.star.json(ownerReference(subject), "GET", `/studies/${id}/upload`);
    const response = await this.remote(async () => {
      const b = object(result.data);
      requireImaging(b.study_id === id && b.chunk_bytes === chunkBytes && Array.isArray(b.received) && b.received.length <= 64, 503, "upstream_protocol_error");
      const received = (b.received as unknown[]).map(v => parsePart(v, study));
      requireImaging(new Set(received.map(p => p.index)).size === received.length, 503, "upstream_protocol_error");
      return { study_id: id, chunk_bytes: chunkBytes, received };
    });
    this.owned(subject, "study", id);
    this.store.saveParts(id, response.received);
    return response;
  }
  async upload(subject: string, id: string, rawIndex: string, length: unknown, digest: unknown, stream: Readable, signal?: AbortSignal) {
    const study = this.owned(subject, "study", id).resource as Study;
    requireImaging(study.state === "uploading", 409, "state_conflict");
    requireImaging(/^(0|[1-9][0-9]?)$/.test(rawIndex), 400, "invalid_chunk");
    const index = Number(rawIndex);
    const expected = Math.min(chunkBytes, study.size - index * chunkBytes);
    requireImaging(typeof length === "string" && /^[0-9]+$/.test(length), 400, "invalid_chunk");
    requireImaging(Number(length) <= chunkBytes, 413, "size_limit");
    requireImaging(expected > 0 && Number(length) === expected, 400, "invalid_chunk");
    requireImaging(typeof digest === "string" && hashPattern.test(digest));
    const guarded = new VerifiedStream(expected, digest, () => { this.owned(subject, "study", id); });
    const feeding = pipeline(stream, guarded);
    // Attach handlers immediately, including when the transport rejects before it starts consuming.
    const sending = this.star.json(ownerReference(subject), "PUT", `/studies/${id}/upload/parts/${index}`, { stream: guarded, length: expected, digest, signal });
    try {
      const [result] = await Promise.all([sending, feeding]);
      const part = await this.remote(async () => parsePart(result.data, study));
      requireImaging(part.index === index && part.sha256 === digest, 503, "upstream_protocol_error");
      this.owned(subject, "study", id);
      this.store.saveParts(id, [part]);
      return part;
    } finally { guarded.destroy(); }
  }
  async complete(subject: string, id: string): Promise<Resource> {
    const intent = this.owned(subject, "study", id);
    const result = await this.star.json(ownerReference(subject), "POST", `/studies/${id}/complete`, { body: {} });
    const resource = await this.remote(async () => parseResource("study", result.data));
    this.validateCorrelation(intent, resource);
    const saved = this.store.save(intent, resource, this.now());
    this.owned(subject, "study", id);
    return saved.resource!;
  }
  async cancel(subject: string, id: string): Promise<Resource> {
    this.owned(subject, "job", id);
    const intent = this.store.action(subject, id, "cancel", this.now());
    if (!intent.pendingAction) return intent.resource!;
    return this.deliverAction(intent);
  }
  async delete(subject: string, id: string): Promise<Resource> {
    this.owned(subject, "study", id, true);
    const intent = this.store.action(subject, id, "delete", this.now());
    // Durable revocation is the accepted operation. star cleanup is retried even if this connection disappears.
    try { await this.deliverAction(intent); } catch (error) { if (!(error instanceof ImagingError) || error.status !== 503) throw error; }
    return intent.resource!;
  }
  private async deliverAction(intent: Intent): Promise<Resource> {
    try {
      const deleting = intent.pendingAction === "delete";
      const result = await this.star.json(ownerReference(intent.subject), deleting ? "DELETE" : "POST", `${this.path(intent)}${deleting ? "" : "/cancel"}`, deleting ? {} : { body: {} });
      const value = await this.remote(async () => parseResource(intent.kind, result.data));
      this.validateCorrelation(intent, value);
      if (deleting) {
        requireImaging(["deleting", "deleted", "expired"].includes(value.state), 503, "upstream_protocol_error");
        this.store.actionDone(intent, this.now());
        return intent.resource!;
      }
      this.store.save(intent, value, this.now());
      this.owned(intent.subject, "job", intent.resourceId!);
      return this.store.find(intent.subject, intent.key)!.resource!;
    } catch (error) {
      if (error instanceof ImagingError && error.status === 404 && intent.pendingAction === "delete") {
        this.store.actionDone(intent, this.now());
        return intent.resource!;
      }
      this.recordFailure(intent, error); throw error;
    }
  }
  async result(subject: string, id: string): Promise<Manifest> {
    const job = await this.get(subject, "job", id) as Job;
    requireImaging(job.state === "completed" && job.result_revision === 1, 409, "result_not_ready");
    const response = await this.star.json(ownerReference(subject), "GET", `/jobs/${id}/result`);
    const manifest = await this.remote(async () => parseManifest(response.data, id));
    this.owned(subject, "job", id);
    this.store.saveManifest(id, manifest);
    return manifest;
  }
  async artifact(subject: string, id: string, path: unknown, signal?: AbortSignal): Promise<{ artifact: Artifact; stream: Readable }> {
    this.owned(subject, "job", id);
    requireImaging(safeArtifactPath(path), 404, "not_found");
    const manifest = await this.result(subject, id);
    const artifact = manifest.artifacts.find(a => a.path === path);
    requireImaging(artifact, 404, "not_found");
    const source = await this.star.artifact(ownerReference(subject), `/jobs/${id}/artifacts?path=${encodeURIComponent(path)}`, artifact, signal);
    const stream = new VerifiedStream(artifact.size, artifact.sha256, () => { this.owned(subject, "job", id); });
    void pipeline(source, stream).catch(() => stream.destroy(new ImagingError(503, "unavailable")));
    stream.once("close", () => source.destroy());
    return { artifact, stream };
  }
  start(): void {
    this.timer = setInterval(() => { void this.reconcile(); }, 2000);
    this.timer.unref();
  }
  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.syncing) return this.syncing;
    this.syncing = this.recover().catch(() => { this.options.onRecoveryError?.(); }).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  private async recover(): Promise<void> {
    for (const intent of this.store.syncCandidates(this.now())) {
      if (this.closed) break;
      try {
        await this.lock(`${intent.subject}:${intent.key}`, async () => {
          const current = this.store.find(intent.subject, intent.key)!;
          this.store.touch(current, this.now());
          if (current.expires <= this.now()) return;
          if (current.pendingAction) await this.deliverAction(current);
          else if (current.revoked && current.resourceId && current.kind === "job") {
            try {
              const result = await this.star.json(ownerReference(current.subject), "GET", this.path(current));
              const value = await this.remote(async () => parseResource("job", result.data));
              this.validateCorrelation(current, value);
              this.store.revokedStatus(current, value.state, this.now());
            } catch (error) { this.recordFailure(current, error); }
          }
          else if (!current.revoked) { if (current.resourceId) await this.refresh(current); else await this.submit(current); }
        });
      } catch { /* Durable intent and sanitized error remain available to the next reconciliation. */ }
    }
    this.store.prune(this.now());
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.star.close();
    await this.syncing;
    await Promise.allSettled(this.locks.values());
    this.store.close();
  }
  private path(intent: Intent): string { return `/${intent.kind === "study" ? "studies" : "jobs"}/${intent.resourceId}`; }
  private recordFailure(intent: Intent, error: unknown): void {
    const safe = error instanceof ImagingError ? error : new ImagingError(503, "unavailable");
    if (safe.status === 404) this.store.expire(intent, this.now());
    else this.store.failure(intent, safe, this.now());
  }
  private async remote<T>(read: () => Promise<T>): Promise<T> {
    try { return await read(); } catch (error) { throw error instanceof ImagingError && error.status === 503 ? error : new ImagingError(503, "upstream_protocol_error"); }
  }
  private async lock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(action);
    this.locks.set(key, current);
    try { return await current; } finally { if (this.locks.get(key) === current) this.locks.delete(key); }
  }
}
