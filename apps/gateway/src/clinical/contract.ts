import { ImagingError, sha256 } from "../imaging/contract.js";

export type Mode = "aipal" | "panecho";
export type Json = Record<string, unknown>;
export const modes: readonly Mode[] = ["aipal", "panecho"];
export const profiles = { aipal: "aipal-adult-research-v1", panecho: "panecho-tte-research-v1" } as const;
export const chunkBytes = 8 * 1024 * 1024, maxUploadBytes = 512 * 1024 * 1024, retention = 86400;
export const fields = {
  age: ["years", 18, 120], WBC_G_L: ["10^9/L", 0.001, 1000], Monocytes_G_L: ["10^9/L", 0, 1000],
  Lymphocytes_G_L: ["10^9/L", 0, 1000], Platelets_G_L: ["10^9/L", 0, 5000], MCV_fL: ["fL", 1, 300],
  MCHC_g_L: ["g/L", 1, 1000], LDH_UI_L: ["U/L", 0, 100000], Fibrinogen_g_L: ["g/L", 0, 50], PT_percent: ["%", 0, 200]
} as const;
export type Input = { session_id: string; analysis_profile: string; data_policy: "public_or_deidentified"; input: Json };
export type Artifact = { name: string; size: number; sha256: string };
export type Job = { job_id: string; analysis_profile: string; state: string; created_at: number; updated_at: number; expires_at: number;
  result_revision: 1 | null; progress: Json; artifacts?: Artifact[]; chunk_bytes?: number; error?: Json };
export const terminal = new Set(["completed", "failed", "cancelled", "deleted", "expired"]);
export const hashPattern = /^[a-f0-9]{64}$/;
export const identifier = (id: unknown): id is string => typeof id === "string" && /^job_[a-f0-9]{32}$/.test(id);
export const prefix = (mode: Mode) => `/gateway/${mode}/v1`;
export const owner = (mode: Mode, subject: string) => sha256(`medevidence-${mode}-v1:subject:${subject}`);
const messages: Record<string, string> = {
  invalid_request: "Invalid clinical request.", invalid_idempotency_key: "An Idempotency-Key of 8-128 safe characters is required.",
  idempotency_conflict: "Idempotency key was used for different input.", not_found: "Task not found or expired.",
  missing_measurements: "All ten measurements are required.", invalid_unit: "Measurement unit is invalid; PT percent is required.",
  invalid_value: "Measurement is outside the supported range.", inconsistent_differential: "Monocytes plus lymphocytes exceed WBC.",
  unsupported_context: "Adult suspected acute leukemia context is required.", unsupported_profile: "Unsupported clinical profile.",
  data_policy: "Research pilot accepts public or deidentified inputs.", unsupported_format: "Unsupported input format.",
  invalid_roi: "A valid normalized ROI excluding labels is required.", unsupported_acquisition: "Only 2D TTE cine is supported.",
  size_limit: "Input size limit exceeded.", invalid_chunk: "Chunk index or length is invalid.", hash_mismatch: "Content SHA-256 mismatch.",
  chunk_conflict: "Chunk differs from the previous upload.", incomplete_upload: "Upload has missing chunks.",
  state_conflict: "Operation is not allowed in the current state.", result_not_ready: "Result is not ready.",
  quota_exceeded: "Clinical pilot daily allowance reached.", queue_full: "Clinical capacity is full.",
  upstream_protocol_error: "Clinical service returned an invalid response.", unavailable: "Clinical service is unavailable.",
  worker_restarted: "Execution was interrupted; explicit retry is required.", execution_failed: "Clinical processing failed.",
  mixed_study: "Upload contains more than one study.", cine_limit: "Input is outside supported cine limits.", unsafe_archive: "Input archive was rejected."
};
export class ClinicalError extends ImagingError {
  constructor(status: number, code: string) { super(status, code); this.message = messages[code] ?? (status < 500 ? messages.invalid_request! : messages.unavailable!); }
}
export function requireClinical(condition: unknown, status = 400, code = "invalid_request"): asserts condition { if (!condition) throw new ClinicalError(status, code); }
export function object(value: unknown): Json { requireClinical(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Json; }
function exact(value: Json, keys: readonly string[]) { requireClinical(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k))); }
export function parseInput(mode: Mode, raw: unknown): Input {
  const body = object(raw); exact(body, ["session_id", "analysis_profile", "data_policy", "input"]);
  requireClinical(typeof body.session_id === "string" && body.session_id.length > 0 && body.session_id.length <= 200);
  requireClinical(body.analysis_profile === profiles[mode], 422, "unsupported_profile");
  requireClinical(body.data_policy === "public_or_deidentified", 422, "data_policy");
  const input = object(body.input); let normalized: Json;
  if (mode === "aipal") {
    exact(input, ["clinical_context", "measurements"]);
    requireClinical(input.clinical_context === "suspected_acute_leukemia", 422, "unsupported_context");
    const measurements = object(input.measurements);
    requireClinical(Object.keys(measurements).length === 10 && Object.keys(fields).every(k => Object.hasOwn(measurements, k)), 422, "missing_measurements");
    const output: Json = {}, values: Record<string, number> = {};
    for (const [name, [unit, low, high]] of Object.entries(fields)) {
      const item = object(measurements[name]); exact(item, ["value", "unit"]);
      requireClinical(item.unit === unit, 422, "invalid_unit");
      requireClinical(typeof item.value === "number" && Number.isFinite(item.value) && item.value >= low && item.value <= high, 422, "invalid_value");
      output[name] = { value: item.value, unit }; values[name] = item.value;
    }
    requireClinical(values.Monocytes_G_L! + values.Lymphocytes_G_L! <= values.WBC_G_L! * 1.01, 422, "inconsistent_differential");
    normalized = { clinical_context: "suspected_acute_leukemia", measurements: output };
  } else {
    exact(input, ["format", "size", "sha256", "acquisition", "roi"]);
    requireClinical(["video", "video_zip", "dicom_zip"].includes(String(input.format)), 422, "unsupported_format");
    requireClinical(Number.isSafeInteger(input.size) && Number(input.size) > 0 && Number(input.size) <= maxUploadBytes, 413, "size_limit");
    requireClinical(typeof input.sha256 === "string" && hashPattern.test(input.sha256));
    requireClinical(input.acquisition === "2d_tte", 422, "unsupported_acquisition");
    requireClinical(Array.isArray(input.roi) && input.roi.length === 4 && input.roi.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) && input.roi[0] < input.roi[2] && input.roi[1] < input.roi[3], 422, "invalid_roi");
    normalized = { format: input.format, size: input.size, sha256: input.sha256, acquisition: input.acquisition, roi: input.roi };
  }
  return { session_id: body.session_id, analysis_profile: profiles[mode], data_policy: "public_or_deidentified", input: normalized };
}
export function parseArtifacts(mode: Mode, raw: unknown): Artifact[] {
  requireClinical(Array.isArray(raw) && raw.length >= 2 && raw.length <= 3, 503, "upstream_protocol_error");
  const allowed = mode === "aipal" ? ["result.json", "report.csv"] : ["result.json", "report.csv", "preview.png"];
  const artifacts = raw.map(value => { const a = object(value);
    requireClinical(allowed.includes(String(a.name)) && Number.isSafeInteger(a.size) && Number(a.size) >= 0 && Number(a.size) <= maxUploadBytes && typeof a.sha256 === "string" && hashPattern.test(a.sha256), 503, "upstream_protocol_error");
    return { name: String(a.name), size: Number(a.size), sha256: a.sha256 as string };
  });
  requireClinical(new Set(artifacts.map(a => a.name)).size === artifacts.length && allowed.every(name => artifacts.some(a => a.name === name)), 503, "upstream_protocol_error");
  return artifacts;
}
export function parseJob(mode: Mode, raw: unknown): Job {
  const b = object(raw), states = ["uploading", "queued", "running", "completed", "failed", "cancel_requested", "cancelled", "deleting", "deleted", "expired"];
  requireClinical(identifier(b.job_id) && b.analysis_profile === profiles[mode] && states.includes(String(b.state)) &&
    [b.created_at, b.updated_at, b.expires_at].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) &&
    Number(b.expires_at) <= Number(b.created_at) + retention && (b.state === "completed" ? b.result_revision === 1 : b.result_revision === null) &&
    (mode !== "panecho" || b.chunk_bytes === chunkBytes), 503, "upstream_protocol_error");
  const p = object(b.progress);
  requireClinical(["uploading", "queued", "verifying_upload", "waiting_resources", "inference", "completed", "failed", "cancel_requested", "cancelled", "deleting", "deleted", "expired"].includes(String(p.phase)) &&
    (p.poll_after_ms === undefined || (Number.isSafeInteger(p.poll_after_ms) && Number(p.poll_after_ms) >= 2000 && Number(p.poll_after_ms) <= 30000)) &&
    (p.wait_reason === undefined || ["queued", "waiting_memory", "waiting_gpu", "scheduler_unavailable", "recovering"].includes(String(p.wait_reason))), 503, "upstream_protocol_error");
  const progress = { phase: p.phase, ...(p.poll_after_ms === undefined ? {} : { poll_after_ms: p.poll_after_ms }), ...(p.wait_reason === undefined ? {} : { wait_reason: p.wait_reason }) };
  let error: Json | undefined;
  if (b.error !== undefined) { const e = object(b.error); requireClinical(typeof e.code === "string" && /^[a-z0-9_]{1,80}$/.test(e.code), 503, "upstream_protocol_error");
    const code = Object.hasOwn(messages, e.code) ? e.code : "execution_failed";
    error = { code, message: messages[code], retryable: false };
  }
  return { job_id: b.job_id as string, analysis_profile: profiles[mode], state: String(b.state), created_at: Number(b.created_at), updated_at: Number(b.updated_at), expires_at: Number(b.expires_at), result_revision: b.result_revision as 1 | null, progress,
    ...(mode === "panecho" ? { chunk_bytes: chunkBytes } : {}), ...(error ? { error } : {}), ...(b.state === "completed" ? { artifacts: parseArtifacts(mode, b.artifacts) } : {}) };
}
export function capabilities(mode: Mode, available: boolean) {
  return { schema_version: 1, analysis_profile: profiles[mode], available, research_only: true, retention_seconds: retention, source_path: `${prefix(mode)}/source`,
    fields: mode === "aipal" ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { unit: v[0] }])) : { formats: ["video", "video_zip", "dicom_zip"], max_upload_bytes: maxUploadBytes, chunk_bytes: chunkBytes, acquisition: "2d_tte" }, poll_after_ms: 2000 };
}
