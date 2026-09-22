import { createHash } from "node:crypto";

export const imagingPrefix = "/gateway/imaging/v1";
export const imagingProfile = "radar-abdominal-research-v1";
export const chunkBytes = 8 * 1024 * 1024;
export const maxUploadBytes = 512 * 1024 * 1024;
export const retentionSeconds = 86_400;
export const hashPattern = /^[a-f0-9]{64}$/;
export type Kind = "study" | "job";
export type Json = Record<string, unknown>;
export type StudyInput = { format: "nifti" | "dicom_zip"; size: number; sha256: string; session_id: string; data_policy: "public_or_deidentified" };
export type JobInput = { study_id: string; study_revision: 1; series_id: string; analysis_profile: typeof imagingProfile; session_id: string };
export type CreateInput = StudyInput | JobInput;
export type Series = { series_id: string; modality: "CT"; shape_xyz?: number[]; spacing_xyz?: number[]; phase: null; eligible: boolean; reason?: string };
export type ImagingProgress = { phase: "verifying_upload" | "waiting_resources" | "parsing" | "inference" | "postprocessing"; wait_reason?: "queued" | "waiting_memory" | "waiting_gpu" | "scheduler_unavailable" | "recovering"; poll_after_ms: number };
export type Study = { study_id: string; study_revision: 1; state: string; format: string; size: number; sha256: string; chunk_bytes: number; expires_at: number; series: Series[]; progress?: ImagingProgress; error?: Json };
export type Job = { job_id: string; study_id: string; series_id: string; state: string; stage: string; result_revision: 1 | null; created_at: number; updated_at: number; expires_at: number; progress?: ImagingProgress; error?: Json };
export type Resource = Study | Job;
export type Part = { index: number; size: number; sha256: string };
export type Artifact = { path: string; size: number; sha256: string };
export type Manifest = { schema_version: 1; job_id: string; result_revision: 1; bundle_path: "bundle.json"; artifacts: Artifact[] };

const messages: Record<string, string> = {
  invalid_request: "Invalid imaging request.", invalid_idempotency_key: "An Idempotency-Key of 8-128 safe characters is required.",
  idempotency_conflict: "Idempotency key was used for another request.", not_found: "Resource not found or expired.",
  size_limit: "Imaging size limit exceeded.", unsupported_format: "Expected NIfTI or DICOM ZIP.",
  unsupported_profile: "Unsupported imaging profile.", data_policy: "Research pilot accepts only public or deidentified data.",
  study_not_ready: "Study must be ready at the selected revision.", invalid_series: "Select an eligible CT series.",
  hash_mismatch: "Content SHA-256 mismatch.", chunk_conflict: "Chunk contains different bytes.",
  incomplete_upload: "Upload has missing chunks.", invalid_chunk: "Chunk index or length is invalid.",
  state_conflict: "Operation is not allowed in the current state.", result_not_ready: "Result is not ready.",
  queue_full: "Imaging capacity is currently full.", quota_exceeded: "Imaging pilot allowance reached.",
  unavailable: "Imaging service is unavailable.", upstream_protocol_error: "Imaging service returned an invalid response.",
  worker_restarted: "Execution was interrupted by a worker restart; explicit retry is required.",
  execution_failed: "Imaging processing failed.", unsafe_archive: "Input archive was rejected.",
  invalid_volume: "Input volume was rejected.", unsupported_series: "Input series was rejected."
};

export class ImagingError extends Error {
  constructor(public status: number, public code: string, public retryable = status === 429 || status === 503) {
    super(messages[code] ?? (status === 503 ? messages.unavailable : "Imaging operation was rejected."));
  }
}
export function requireImaging(condition: unknown, status = 400, code = "invalid_request"): asserts condition {
  if (!condition) throw new ImagingError(status, code);
}
export function object(value: unknown): Json {
  requireImaging(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Json;
}
export function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function ownerReference(subject: string): string { return sha256(`medevidence-imaging-v1:subject:${subject}`); }
export function identifier(value: unknown, kind: Kind): value is string {
  return typeof value === "string" && new RegExp(`^${kind}_[a-f0-9]{32}$`).test(value);
}
export function safeToken(value: unknown, maximum = 200): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9_.:-]+$/.test(value);
}
export function idempotencyKey(value: unknown): string {
  requireImaging(safeToken(value, 128) && value.length >= 8, 400, "invalid_idempotency_key");
  return sha256(value);
}
export function parseCreate(kind: Kind, value: unknown): CreateInput {
  const b = object(value);
  const keys = kind === "study" ? ["format", "size", "sha256", "session_id", "data_policy"] : ["study_id", "study_revision", "series_id", "analysis_profile", "session_id"];
  requireImaging(Object.keys(b).length === keys.length && keys.every(k => Object.hasOwn(b, k)));
  requireImaging(typeof b.session_id === "string" && b.session_id.length > 0 && b.session_id.length <= 200);
  if (kind === "study") {
    requireImaging(b.format === "nifti" || b.format === "dicom_zip", 422, "unsupported_format");
    requireImaging(Number.isSafeInteger(b.size) && Number(b.size) > 0 && Number(b.size) <= maxUploadBytes, 413, "size_limit");
    requireImaging(typeof b.sha256 === "string" && hashPattern.test(b.sha256));
    requireImaging(b.data_policy === "public_or_deidentified", 422, "data_policy");
    return { format: b.format, size: b.size as number, sha256: b.sha256, session_id: b.session_id, data_policy: b.data_policy };
  }
  requireImaging(identifier(b.study_id, "study"));
  requireImaging(b.study_revision === 1, 409, "study_not_ready");
  requireImaging(safeToken(b.series_id), 422, "invalid_series");
  requireImaging(b.analysis_profile === imagingProfile, 422, "unsupported_profile");
  return { study_id: b.study_id, study_revision: 1, series_id: b.series_id, analysis_profile: imagingProfile, session_id: b.session_id };
}
export function fingerprint(kind: Kind, body: CreateInput): string {
  // Canonical field order is fixed by parseCreate; never hash unfiltered client JSON.
  return sha256(JSON.stringify([kind, body]));
}
export function emptyBody(body: unknown): void { requireImaging(Object.keys(object(body)).length === 0); }
export function capabilities(available: boolean) {
  return { schema_version: 1, profile: imagingProfile, available, input_formats: ["nifti", "dicom_zip"], max_upload_bytes: maxUploadBytes, chunk_bytes: chunkBytes, retention_seconds: retentionSeconds, poll_after_ms: 2000 };
}
export function parseCapabilities(value: unknown): ReturnType<typeof capabilities> {
  const b = object(value);
  requireImaging(b.schema_version === 1 && b.profile === imagingProfile && typeof b.available === "boolean" &&
    b.chunk_bytes === chunkBytes && b.max_upload_bytes === maxUploadBytes && b.retention_seconds === retentionSeconds &&
    Array.isArray(b.input_formats) && ["nifti", "dicom_zip"].every(f => (b.input_formats as unknown[]).includes(f)) && b.poll_after_ms === 2000, 503, "upstream_protocol_error");
  return capabilities(b.available);
}
function numeric(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function publicError(value: unknown): Json | undefined {
  if (value === undefined) return undefined;
  const b = object(value);
  requireImaging(safeToken(b.code, 80) && typeof b.retryable === "boolean", 503, "upstream_protocol_error");
  return { code: Object.hasOwn(messages, b.code) ? b.code : "execution_failed", message: messages[b.code] ?? messages.execution_failed, retryable: b.retryable };
}
function publicProgress(value: unknown): ImagingProgress | undefined {
  if (value === undefined) return undefined;
  requireImaging(value !== null && typeof value === "object" && !Array.isArray(value), 503, "upstream_protocol_error");
  const b = object(value);
  requireImaging(["verifying_upload", "waiting_resources", "parsing", "inference", "postprocessing"].includes(String(b.phase)) &&
    Number.isSafeInteger(b.poll_after_ms) && Number(b.poll_after_ms) >= 2000 && Number(b.poll_after_ms) <= 30000 &&
    (b.phase === "waiting_resources"
      ? ["queued", "waiting_memory", "waiting_gpu", "scheduler_unavailable", "recovering"].includes(String(b.wait_reason))
      : b.wait_reason === undefined), 503, "upstream_protocol_error");
  return { phase: b.phase as ImagingProgress["phase"], poll_after_ms: Number(b.poll_after_ms),
    ...(b.phase === "waiting_resources" ? { wait_reason: b.wait_reason as ImagingProgress["wait_reason"] } : {}) };
}
export function parseResource(kind: Kind, value: unknown): Resource {
  const b = object(value);
  requireImaging(numeric(b.expires_at), 503, "upstream_protocol_error");
  const error = publicError(b.error);
  const progress = ["validating", "queued", "preprocessing", "running", "postprocessing"].includes(String(b.state)) ? publicProgress(b.progress) : undefined;
  if (kind === "study") {
    requireImaging(identifier(b.study_id, "study") && b.study_revision === 1 &&
      ["uploading", "validating", "ready", "rejected", "deleting", "deleted", "expired"].includes(String(b.state)) &&
      ["nifti", "dicom_zip"].includes(String(b.format)) && Number.isSafeInteger(b.size) && Number(b.size) > 0 && Number(b.size) <= maxUploadBytes &&
      typeof b.sha256 === "string" && hashPattern.test(b.sha256) && b.chunk_bytes === chunkBytes && Array.isArray(b.series) && b.series.length <= 10000, 503, "upstream_protocol_error");
    const series = (b.series as unknown[]).map(item => {
      const s = object(item);
      const geometry = [s.shape_xyz, s.spacing_xyz].every(a => Array.isArray(a) && a.length === 3 && a.every(n => numeric(n) && n > 0)) &&
        (s.shape_xyz as number[]).every(Number.isSafeInteger);
      requireImaging(safeToken(s.series_id) && s.modality === "CT" && s.phase === null && typeof s.eligible === "boolean" &&
        (geometry || (s.eligible === false && s.shape_xyz === undefined && s.spacing_xyz === undefined)), 503, "upstream_protocol_error");
      const reasons = ["slice_count_out_of_range", "non_ct_localizer_multiframe_or_inconsistent_geometry", "unsupported_volume_geometry"];
      return { series_id: s.series_id as string, modality: "CT" as const,
        ...(geometry ? { shape_xyz: s.shape_xyz as number[], spacing_xyz: s.spacing_xyz as number[] } : {}), phase: null, eligible: s.eligible,
        ...(s.reason === undefined ? {} : { reason: reasons.includes(String(s.reason)) ? String(s.reason) : "unsupported_series" }) };
    });
    requireImaging(new Set(series.map(s => s.series_id)).size === series.length, 503, "upstream_protocol_error");
    return { study_id: b.study_id as string, study_revision: 1, state: String(b.state), format: String(b.format), size: Number(b.size), sha256: b.sha256 as string, chunk_bytes: chunkBytes, expires_at: b.expires_at, series, ...(progress ? { progress } : {}), ...(error ? { error } : {}) };
  }
  const states = ["queued", "preprocessing", "running", "postprocessing", "completed", "failed", "cancel_requested", "cancelled", "expired"];
  requireImaging(identifier(b.job_id, "job") && identifier(b.study_id, "study") && safeToken(b.series_id) && states.includes(String(b.state)) &&
    [...states, "waiting_gpu", "interrupted"].includes(String(b.stage)) && numeric(b.created_at) && numeric(b.updated_at) &&
    (b.state === "completed" ? b.result_revision === 1 : b.result_revision === null), 503, "upstream_protocol_error");
  return { job_id: b.job_id as string, study_id: b.study_id as string, series_id: b.series_id as string, state: String(b.state), stage: String(b.stage), result_revision: b.result_revision as 1 | null, created_at: b.created_at, updated_at: b.updated_at, expires_at: b.expires_at, ...(progress ? { progress } : {}), ...(error ? { error } : {}) };
}
export function resourceId(value: Resource): string { return "job_id" in value ? value.job_id : value.study_id; }
export function parsePart(value: unknown, study: Study): Part {
  const b = object(value);
  requireImaging(Number.isSafeInteger(b.index) && Number(b.index) >= 0 && Number(b.index) < Math.ceil(study.size / chunkBytes) &&
    b.size === Math.min(chunkBytes, study.size - Number(b.index) * chunkBytes) && typeof b.sha256 === "string" && hashPattern.test(b.sha256), 503, "upstream_protocol_error");
  return { index: Number(b.index), size: Number(b.size), sha256: b.sha256 };
}
export function safeArtifactPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 240 && /^[A-Za-z0-9_./-]+$/.test(value) &&
    value.split("/").every(p => p.length > 0 && p !== "." && p !== "..");
}
export function parseManifest(value: unknown, jobId: string): Manifest {
  const b = object(value);
  requireImaging(b.schema_version === 1 && b.job_id === jobId && b.result_revision === 1 && b.bundle_path === "bundle.json" &&
    Array.isArray(b.artifacts) && b.artifacts.length > 0 && b.artifacts.length <= 256, 503, "upstream_protocol_error");
  const artifacts = (b.artifacts as unknown[]).map(item => {
    const a = object(item);
    requireImaging(safeArtifactPath(a.path) && Number.isSafeInteger(a.size) && Number(a.size) >= 0 && Number(a.size) <= maxUploadBytes &&
      typeof a.sha256 === "string" && hashPattern.test(a.sha256), 503, "upstream_protocol_error");
    return { path: a.path, size: Number(a.size), sha256: a.sha256 };
  });
  requireImaging(artifacts.some(a => a.path === "bundle.json") && new Set(artifacts.map(a => a.path)).size === artifacts.length, 503, "upstream_protocol_error");
  return { schema_version: 1, job_id: jobId, result_revision: 1, bundle_path: "bundle.json", artifacts };
}
