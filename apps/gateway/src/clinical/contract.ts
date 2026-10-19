import { ImagingError, sha256 } from "../imaging/contract.js";

export type Mode = "aipal" | "panecho" | "echonet" | "echonext";
export type Json = Record<string, unknown>;
export const modes: readonly Mode[] = ["aipal", "panecho", "echonet", "echonext"];
export const profiles = { aipal: "aipal-adult-research-v1", panecho: "panecho-tte-research-v1", echonet: "echonet-a4c-research-v1", echonext: "echonext-mini-ecg-research-v1" } as const;
export const chunkBytes = 8 * 1024 * 1024, maxUploadBytes = 512 * 1024 * 1024, retention = 86400;
export const usesUpload = (mode: Mode) => mode !== "aipal";
export const uploadLimit = (mode: Mode) => mode === "echonext" ? 16 * 1024 * 1024 : maxUploadBytes;
export const artifactLimit = (mode: Mode) => mode === "echonet" || mode === "echonext" ? 32 * 1024 * 1024 : maxUploadBytes;
export const artifactNames = (mode: Mode): string[] => mode === "aipal" ? ["result.json", "report.csv"]
  : mode === "echonet" ? ["result.json", "report.csv", "preview.png", "overlay.mp4", "contours.json"] : ["result.json", "report.csv", "preview.png"];
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
  mixed_study: "Upload contains more than one study.", cine_limit: "Input is outside supported cine limits.", unsafe_archive: "Input archive was rejected.",
  invalid_ecg: "ECG input is invalid.", unsupported_voltage_scale: "ECG voltage scale is unsupported.", flatline_lead: "ECG contains a flatline lead.",
  invalid_age: "Age is outside the supported range.", unsupported_view: "Human-confirmed A4C view is required.",
  quality_confirmation_required: "Human review of nonpaced ECG quality is required.", recording_limit: "Exactly one ECG recording is required.",
  unsupported_pixels: "Pixel format is unsupported.", unsupported_modality: "Input modality is unsupported.", decode_failed: "Input could not be decoded.",
  model_integrity: "Model integrity check failed.", invalid_output: "Model output is invalid.", artifact_integrity: "Artifact integrity check failed.", artifact_missing: "Required artifact is missing."
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
  } else if (mode === "echonext") {
    exact(input, ["format", "size", "sha256", "acquisition", "recording_count", "quality_confirmation"]);
    requireClinical(input.format === "ge_muse_xml", 422, "unsupported_format");
    requireClinical(Number.isSafeInteger(input.size) && Number(input.size) > 0 && Number(input.size) <= uploadLimit(mode), 413, "size_limit");
    requireClinical(typeof input.sha256 === "string" && hashPattern.test(input.sha256));
    requireClinical(input.acquisition === "resting_12_lead_ecg", 422, "unsupported_modality");
    requireClinical(input.recording_count === 1, 422, "recording_limit");
    requireClinical(input.quality_confirmation === "human_reviewed_nonpaced", 422, "quality_confirmation_required");
    normalized = { format: input.format, size: input.size, sha256: input.sha256, acquisition: input.acquisition, recording_count: 1, quality_confirmation: input.quality_confirmation };
  } else {
    exact(input, ["format", "size", "sha256", "acquisition", "roi", ...(mode === "echonet" ? ["view", "view_confirmation", "cine_count"] : [])]);
    requireClinical(["video", "video_zip", "dicom_zip"].includes(String(input.format)), 422, "unsupported_format");
    requireClinical(Number.isSafeInteger(input.size) && Number(input.size) > 0 && Number(input.size) <= maxUploadBytes, 413, "size_limit");
    requireClinical(typeof input.sha256 === "string" && hashPattern.test(input.sha256));
    requireClinical(input.acquisition === "2d_tte", 422, "unsupported_acquisition");
    requireClinical(Array.isArray(input.roi) && input.roi.length === 4 && input.roi.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) && input.roi[0] < input.roi[2] && input.roi[1] < input.roi[3], 422, "invalid_roi");
    normalized = { format: input.format, size: input.size, sha256: input.sha256, acquisition: input.acquisition, roi: input.roi };
    if (mode === "echonet") {
      requireClinical(input.view === "a4c" && input.view_confirmation === "human", 422, "unsupported_view");
      requireClinical(input.cine_count === 1, 422, "cine_limit");
      Object.assign(normalized, { view: "a4c", view_confirmation: "human", cine_count: 1 });
    }
  }
  return { session_id: body.session_id, analysis_profile: profiles[mode], data_policy: "public_or_deidentified", input: normalized };
}
export function parseArtifacts(mode: Mode, raw: unknown): Artifact[] {
  const allowed = artifactNames(mode);
  requireClinical(Array.isArray(raw) && raw.length === allowed.length, 503, "upstream_protocol_error");
  const artifacts = raw.map(value => { const a = object(value);
    requireClinical(allowed.includes(String(a.name)) && Number.isSafeInteger(a.size) && Number(a.size) >= 0 && Number(a.size) <= artifactLimit(mode) && typeof a.sha256 === "string" && hashPattern.test(a.sha256), 503, "upstream_protocol_error");
    return { name: String(a.name), size: Number(a.size), sha256: a.sha256 as string };
  });
  requireClinical(new Set(artifacts.map(a => a.name)).size === artifacts.length && allowed.every(name => artifacts.some(a => a.name === name)), 503, "upstream_protocol_error");
  return artifacts;
}
export function parseJob(mode: Mode, raw: unknown): Job {
  const b = object(raw), states = ["uploading", "queued", "running", "completed", "failed", "cancel_requested", "cancelled", "deleting", "deleted", "expired"];
  requireClinical(identifier(b.job_id) && b.analysis_profile === profiles[mode] && states.includes(String(b.state)) &&
    [b.created_at, b.updated_at, b.expires_at].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) &&
    Number(b.expires_at) <= Number(b.created_at) + retention && (b.state === "completed" ? b.result_revision === 1 :
      ["deleting", "deleted", "expired"].includes(String(b.state)) ? b.result_revision === null || b.result_revision === 1 : b.result_revision === null) &&
    (!usesUpload(mode) || b.chunk_bytes === chunkBytes), 503, "upstream_protocol_error");
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
  return { job_id: b.job_id as string, analysis_profile: profiles[mode], state: String(b.state), created_at: Number(b.created_at), updated_at: Number(b.updated_at), expires_at: Number(b.expires_at), result_revision: b.state === "completed" ? 1 : null, progress,
    ...(usesUpload(mode) ? { chunk_bytes: chunkBytes } : {}), ...(error ? { error } : {}), ...(b.state === "completed" ? { artifacts: parseArtifacts(mode, b.artifacts) } : {}) };
}
export function capabilities(mode: Mode, available: boolean) {
  return { schema_version: 1, analysis_profile: profiles[mode], available, research_only: true, retention_seconds: retention, source_path: `${prefix(mode)}/source`,
    ...(mode === "echonet" || mode === "echonext" ? { artifact_names: artifactNames(mode), max_artifact_bytes: artifactLimit(mode) } : {}),
    fields: mode === "aipal" ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { unit: v[0] }]))
      : mode === "echonext" ? { formats: ["ge_muse_xml"], max_upload_bytes: uploadLimit(mode), chunk_bytes: chunkBytes, acquisition: "resting_12_lead_ecg", sample_rates_hz: [250, 500], seconds: 10, validated_mv_per_lsb: 0.00488, quality_confirmation_required: true }
      : { formats: ["video", "video_zip", "dicom_zip"], max_upload_bytes: maxUploadBytes, chunk_bytes: chunkBytes, acquisition: "2d_tte",
        ...(mode === "echonet" ? { view: "a4c", cine_count: 1, min_frames: 63, max_frames: 512, normalization: "fixed_public_demo_statistics_learning_only" } : {}) }, poll_after_ms: 2000 };
}
