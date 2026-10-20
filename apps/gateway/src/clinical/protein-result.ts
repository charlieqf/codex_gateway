import { sha256 } from "../imaging/contract.js";
import { ClinicalError, object, requireClinical, type Json } from "./contract.js";

export const proteinContentTypes: Record<string, string> = {
  "result.json": "application/octet-stream", "report.csv": "text/csv", "preview.png": "image/png",
  "structure.pdb": "chemical/x-pdb", "scores.json": "application/json", "structure.html": "text/html; charset=utf-8", "models.zip": "application/zip"
};
const finite = (value: unknown, max: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
export function validateProteinResult(data: Json, input: Json | undefined): void {
  try {
    requireClinical(typeof input?.sequence === "string" && data.length === input.sequence.length && data.sequence_sha256 === sha256(input.sequence));
    requireClinical(finite(data.mean_plddt, 100) && finite(data.ptm, 1) && Number.isSafeInteger(data.residues_below_70) && finite(data.residues_below_70, input.sequence.length));
    const settings = object(data.settings), msa = object(data.msa);
    requireClinical(settings.model_type === "alphafold2_ptm" && settings.num_models === 5 && settings.num_recycle === 3 && settings.random_seed === 0 && settings.templates === false && settings.relaxation === false);
    requireClinical(msa.host === "https://api.colabfold.com" && msa.database_version === null);
    object(data.model_provenance);
    requireClinical(Array.isArray(data.models) && data.models.length === 5);
    data.models.forEach((raw, i) => { const model = object(raw); requireClinical(model.rank === i + 1 && finite(model.mean_plddt, 100) && finite(model.ptm, 1)); });
  } catch { throw new ClinicalError(503, "upstream_protocol_error"); }
}
