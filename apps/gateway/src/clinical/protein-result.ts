import { sha256 } from "../imaging/contract.js";
import { ClinicalError, object, requireClinical, type Json } from "./contract.js";

export const proteinContentTypes: Record<string, string> = {
  "result.json": "application/octet-stream", "report.csv": "text/csv", "preview.png": "image/png",
  "structure.cif": "chemical/x-mmcif", "scores.json": "application/json", "structure.html": "text/html; charset=utf-8", "models.zip": "application/zip"
};
const finite = (value: unknown, max: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
export function validateAlphaFold3Result(data: Json, input: Json | undefined): void {
  try {
    requireClinical(typeof input?.sequence === "string" && data.length === input.sequence.length && data.sequence_sha256 === sha256(input.sequence));
    const scores = (value: Json) => {
      requireClinical(finite(value.mean_atom_plddt, 100) && finite(value.mean_ca_plddt, 100) && finite(value.ptm, 1));
      requireClinical(typeof value.ranking_score === "number" && Number.isFinite(value.ranking_score) && value.ranking_score >= -100 && value.ranking_score <= 1.5);
      requireClinical(value.has_clash === 0 || value.has_clash === 1);
      requireClinical(value.seed === 0 && Number.isSafeInteger(value.sample) && finite(value.sample, 4));
    };
    scores(data);
    requireClinical(Number.isSafeInteger(data.ca_residues_below_70) && finite(data.ca_residues_below_70, input.sequence.length));
    const settings = object(data.settings), msa = object(data.msa);
    requireClinical(settings.num_models === 1 && settings.num_diffusion_samples === 5 && settings.num_recycles === 10 && settings.random_seed === 0 &&
      settings.templates === false && settings.relaxation === false && settings.run_data_pipeline === false && settings.bucket === 256 && settings.attention === "xla");
    requireClinical(msa.host === "https://api.colabfold.com" && msa.database_version === null);
    const provenance = object(data.model_provenance);
    requireClinical(provenance.model === "AlphaFold 3" && provenance.learning_only === true && provenance.clinical_validation === false);
    requireClinical(Array.isArray(data.samples) && data.samples.length === 5);
    const samples = data.samples.map(raw => { const sample = object(raw); scores(sample); return sample; });
    requireClinical(new Set(samples.map(sample => sample.sample)).size === 5);
    const selected = samples.find(sample => sample.sample === data.sample)!;
    requireClinical(["mean_atom_plddt", "mean_ca_plddt", "ptm", "ranking_score", "has_clash"].every(key => selected[key] === data[key]));
  } catch { throw new ClinicalError(503, "upstream_protocol_error"); }
}
