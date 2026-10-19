import { ClinicalError, object, requireClinical, type Json } from "./contract.js";

export const echoNextOutputOrder = [
  "lvef_lte_45", "lvwt_gte_13", "aortic_stenosis_moderate_severe",
  "aortic_regurgitation_moderate_severe", "mitral_regurgitation_moderate_severe",
  "tricuspid_regurgitation_moderate_severe", "pulmonary_regurgitation_moderate_severe",
  "rv_systolic_dysfunction_moderate_severe", "pericardial_effusion_moderate_large",
  "pasp_gte_45", "tr_max_gte_32", "shd"
] as const;

const finite = (v: unknown, low: number, high: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= low && v <= high;

/** Validate the two learning contracts without interpreting independent scores as probabilities. */
export function validateEchoResult(mode: "echonet" | "echonext", data: Json, input: Json | undefined): void {
  try {
    requireClinical(input && data.input_sha256 === input.sha256 && data.clinical_validation === false);
    const provenance = object(data.model_provenance);
    requireClinical(provenance.learning_only === true && provenance.clinical_validation === false && provenance.model === mode &&
      typeof provenance.source_revision === "string" && provenance.source_revision.length > 0);
    if (mode === "echonet") {
      const video = object(data.video), segmentation = object(data.segmentation), normalization = object(data.normalization);
      requireClinical(finite(data.ef_percent, 0, 100) && Number.isSafeInteger(video.frames) && finite(video.frames, 63, 512) &&
        video.view === "a4c" && video.view_confirmation === "human" && segmentation.frame_count === video.frames &&
        normalization.training_statistics === false);
      object(data.sampling);
      requireClinical(Array.isArray(video.roi) && JSON.stringify(video.roi) === JSON.stringify(input.roi));
    } else {
      const scores = object(data.scores);
      requireClinical(Object.keys(scores).length === echoNextOutputOrder.length && echoNextOutputOrder.every(k => finite(scores[k], 0, 1)) &&
        Array.isArray(data.output_order) && data.output_order.length === echoNextOutputOrder.length &&
        data.output_order.every((k, i) => k === echoNextOutputOrder[i]) && data.thresholds === null);
    }
  } catch { throw new ClinicalError(503, "upstream_protocol_error"); }
}
