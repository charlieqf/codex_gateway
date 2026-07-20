import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

export const doctorResearchRunSchemaVersion = "doctor_research_run.v1";
export const doctorResearchModelOutputSchemaVersion =
  "doctor_research_model_output.v1";
export const doctorResearchModelDraftSchemaVersion =
  "doctor_research_model_draft.v1";
export const doctorResearchResultSchemaVersion =
  "doctor_research_result.v1";

export interface DoctorResearchRunReceipt {
  schema_version: "doctor_research_run.v1";
  request_id: string;
  run_id: string;
  status: "queued";
  stage: "validate_input";
  mode: "brief";
  skill: {
    name: "doctor-research-query";
    version: string;
  };
  created_at: string;
  status_url: string;
  result_url: string;
}

export const researchArtifactKinds = [
  "profile",
  "review",
  "questions",
  "answers"
] as const;

export type ResearchArtifactKind = (typeof researchArtifactKinds)[number];

export interface DoctorResearchSource {
  source_id: string;
  source_type: "official_web" | "pubmed" | "crossref" | "orcid";
  title: string;
  url: string;
  accessed_at: string;
  content_sha256: string;
}

export interface DoctorResearchClaim {
  claim_id: string;
  claim_type: DoctorResearchClaimType;
  text: string;
  source_ids: string[];
  verification_status: "verified";
}

export const doctorResearchClaimTypes = [
  "identity",
  "position",
  "expertise",
  "education_and_career",
  "research_direction",
  "representative_output"
] as const;

export type DoctorResearchClaimType =
  (typeof doctorResearchClaimTypes)[number];

export interface DoctorResearchReference {
  reference_id: string;
  title: string;
  journal: string;
  publication_year: number;
  pmid: string | null;
  doi: string | null;
  verification_status: "verified";
}

export interface DoctorResearchArtifactManifest {
  artifact_id: string;
  kind: ResearchArtifactKind;
  filename: string;
  content_type:
    | "text/markdown; charset=utf-8"
    | "text/plain; charset=utf-8";
  size_bytes: number;
  sha256: string;
  expires_at: string;
  download_url: string;
}

export interface DoctorResearchContent {
  doctor: {
    name: string;
    hospital: string | null;
    department: string | null;
  };
  identity_resolution: {
    status: "verified";
    confidence: "high" | "medium";
    canonical_identity_id: string;
    matched_by: Array<
      "institution" | "department" | "coauthor" | "research_topic" | "orcid"
    >;
  };
  sources: DoctorResearchSource[];
  profile: {
    positions: string[];
    expertise: string[];
    education_and_career: string[];
    research_directions: string[];
    representative_outputs: string[];
    claims: DoctorResearchClaim[];
    primary_public_source_ids: string[];
  };
  review: {
    title: string;
    abstract: string;
    keywords: string[];
    markdown: string;
    core_evidence: Array<{
      reference_id: string;
      study_type: string;
      sample_and_source: string;
      methods: string;
      key_results: string;
      limitations: string;
    }>;
    references: DoctorResearchReference[];
    search_report: {
      databases: string[];
      searched_at: string;
      queries: string[];
      included_count: number;
    };
  };
  source_coverage: {
    literature_sources: string[];
    profile_sources: string[];
    cutoff_date: string;
    warnings: string[];
  };
  predicted_questions: string[];
  answers: Array<{
    question_index: number;
    answer: string;
    source_ids: string[];
  }>;
  quality: {
    status: "passed" | "passed_with_warnings";
    checks: string[];
    warnings: string[];
  };
}

export interface DoctorResearchModelOutput extends DoctorResearchContent {
  schema_version: "doctor_research_model_output.v1";
}

export interface DoctorResearchModelDraft {
  schema_version: "doctor_research_model_draft.v1";
  profile: DoctorResearchContent["profile"];
  review: Omit<
    DoctorResearchContent["review"],
    "references" | "search_report"
  >;
  predicted_questions: DoctorResearchContent["predicted_questions"];
  answers: DoctorResearchContent["answers"];
}

export interface DoctorResearchResult extends DoctorResearchContent {
  schema_version: "doctor_research_result.v1";
  request_id: string;
  run_id: string;
  artifacts: DoctorResearchArtifactManifest[];
}

export type DoctorResearchContractFailureKind =
  | "parse_error"
  | "schema_error"
  | "semantic_error";

export type DoctorResearchContractResult<
  T = DoctorResearchResult
> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: DoctorResearchContractFailureKind;
      errors: string[];
    };

const idPattern = "^[a-z][a-z0-9_:-]{2,127}$";
const sha256Pattern = "^[a-f0-9]{64}$";
const isoInstantPattern =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{3})?Z$";

export const doctorResearchRunReceiptSchema = {
  $id: `${doctorResearchRunSchemaVersion}.receipt`,
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "request_id",
    "run_id",
    "status",
    "stage",
    "mode",
    "skill",
    "created_at",
    "status_url",
    "result_url"
  ],
  properties: {
    schema_version: { const: doctorResearchRunSchemaVersion },
    request_id: { type: "string", pattern: "^req[_:-][A-Za-z0-9._:-]+$" },
    run_id: { type: "string", pattern: "^drr_[a-f0-9]{32}$" },
    status: { const: "queued" },
    stage: { const: "validate_input" },
    mode: { const: "brief" },
    skill: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version"],
      properties: {
        name: { const: "doctor-research-query" },
        version: {
          type: "string",
          pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$"
        }
      }
    },
    created_at: { type: "string", pattern: isoInstantPattern },
    status_url: {
      type: "string",
      pattern:
        "^/gateway/research/v1/doctor-runs/drr_[a-f0-9]{32}$"
    },
    result_url: {
      type: "string",
      pattern:
        "^/gateway/research/v1/doctor-runs/drr_[a-f0-9]{32}/result$"
    }
  }
} as const;

export const doctorResearchResultSchema = {
  $id: doctorResearchResultSchemaVersion,
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "request_id",
    "run_id",
    "doctor",
    "identity_resolution",
    "sources",
    "profile",
    "review",
    "source_coverage",
    "predicted_questions",
    "answers",
    "quality",
    "artifacts"
  ],
  properties: {
    schema_version: { const: doctorResearchResultSchemaVersion },
    request_id: { type: "string", pattern: "^req[_:-][A-Za-z0-9._:-]+$" },
    run_id: { type: "string", pattern: "^drr_[a-f0-9]{32}$" },
    doctor: {
      type: "object",
      additionalProperties: false,
      required: ["name", "hospital", "department"],
      properties: {
        name: { type: "string", minLength: 2, maxLength: 100 },
        hospital: { type: ["string", "null"], maxLength: 200 },
        department: { type: ["string", "null"], maxLength: 200 }
      }
    },
    identity_resolution: {
      type: "object",
      additionalProperties: false,
      required: [
        "status",
        "confidence",
        "canonical_identity_id",
        "matched_by"
      ],
      properties: {
        status: { const: "verified" },
        confidence: { enum: ["high", "medium"] },
        canonical_identity_id: {
          type: "string",
          pattern: "^dci_[a-z0-9]{8,64}$"
        },
        matched_by: {
          type: "array",
          minItems: 2,
          uniqueItems: true,
          items: {
            enum: [
              "institution",
              "department",
              "coauthor",
              "research_topic",
              "orcid"
            ]
          }
        }
      }
    },
    sources: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "source_id",
          "source_type",
          "title",
          "url",
          "accessed_at",
          "content_sha256"
        ],
        properties: {
          source_id: { type: "string", pattern: "^src_[a-z0-9_-]{3,80}$" },
          source_type: {
            enum: ["official_web", "pubmed", "crossref", "orcid"]
          },
          title: { type: "string", minLength: 1, maxLength: 500 },
          url: { type: "string", pattern: "^https://", maxLength: 2048 },
          accessed_at: { type: "string", pattern: isoInstantPattern },
          content_sha256: { type: "string", pattern: sha256Pattern }
        }
      }
    },
    profile: {
      type: "object",
      additionalProperties: false,
      required: [
        "positions",
        "expertise",
        "education_and_career",
        "research_directions",
        "representative_outputs",
        "claims",
        "primary_public_source_ids"
      ],
      properties: {
        positions: stringArray(),
        expertise: stringArray(),
        education_and_career: stringArray(),
        research_directions: stringArray(1),
        representative_outputs: stringArray(),
        claims: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "claim_id",
              "claim_type",
              "text",
              "source_ids",
              "verification_status"
            ],
            properties: {
              claim_id: { type: "string", pattern: "^clm_[a-z0-9_-]{3,80}$" },
              claim_type: { enum: doctorResearchClaimTypes },
              text: { type: "string", minLength: 1, maxLength: 2000 },
              source_ids: {
                type: "array",
                minItems: 1,
                uniqueItems: true,
                items: { type: "string", pattern: "^src_[a-z0-9_-]{3,80}$" }
              },
              verification_status: { const: "verified" }
            }
          }
        },
        primary_public_source_ids: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", pattern: "^src_[a-z0-9_-]{3,80}$" }
        }
      }
    },
    review: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "abstract",
        "keywords",
        "markdown",
        "core_evidence",
        "references",
        "search_report"
      ],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 500 },
        abstract: { type: "string", minLength: 1 },
        keywords: stringArray(1),
        markdown: { type: "string", minLength: 1 },
        core_evidence: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "reference_id",
              "study_type",
              "sample_and_source",
              "methods",
              "key_results",
              "limitations"
            ],
            properties: {
              reference_id: {
                type: "string",
                pattern: "^ref_[a-z0-9_-]{3,80}$"
              },
              study_type: { type: "string", minLength: 1 },
              sample_and_source: { type: "string", minLength: 1 },
              methods: { type: "string", minLength: 1 },
              key_results: { type: "string", minLength: 1 },
              limitations: { type: "string", minLength: 1 }
            }
          }
        },
        references: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "reference_id",
              "title",
              "journal",
              "publication_year",
              "pmid",
              "doi",
              "verification_status"
            ],
            anyOf: [
              { properties: { pmid: { type: "string", pattern: "^[0-9]+$" } } },
              {
                properties: {
                  doi: {
                    type: "string",
                    pattern: "^10\\.[0-9]{4,9}/\\S+$"
                  }
                }
              }
            ],
            properties: {
              reference_id: {
                type: "string",
                pattern: "^ref_[a-z0-9_-]{3,80}$"
              },
              title: { type: "string", minLength: 1 },
              journal: { type: "string", minLength: 1 },
              publication_year: {
                type: "integer",
                minimum: 1800,
                maximum: 2200
              },
              pmid: { type: ["string", "null"] },
              doi: { type: ["string", "null"] },
              verification_status: { const: "verified" }
            }
          }
        },
        search_report: {
          type: "object",
          additionalProperties: false,
          required: ["databases", "searched_at", "queries", "included_count"],
          properties: {
            databases: stringArray(1),
            searched_at: { type: "string", pattern: isoInstantPattern },
            queries: stringArray(1),
            included_count: { type: "integer", minimum: 1 }
          }
        }
      }
    },
    source_coverage: {
      type: "object",
      additionalProperties: false,
      required: [
        "literature_sources",
        "profile_sources",
        "cutoff_date",
        "warnings"
      ],
      properties: {
        literature_sources: stringArray(1),
        profile_sources: stringArray(1),
        cutoff_date: {
          type: "string",
          pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
        },
        warnings: stringArray()
      }
    },
    predicted_questions: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      uniqueItems: true,
      items: { type: "string", minLength: 1 }
    },
    answers: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question_index", "answer", "source_ids"],
        properties: {
          question_index: { type: "integer", minimum: 1, maximum: 5 },
          answer: { type: "string", minLength: 1 },
          source_ids: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", pattern: "^src_[a-z0-9_-]{3,80}$" }
          }
        }
      }
    },
    quality: {
      type: "object",
      additionalProperties: false,
      required: ["status", "checks", "warnings"],
      properties: {
        status: { enum: ["passed", "passed_with_warnings"] },
        checks: stringArray(1),
        warnings: stringArray()
      }
    },
    artifacts: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "artifact_id",
          "kind",
          "filename",
          "content_type",
          "size_bytes",
          "sha256",
          "expires_at",
          "download_url"
        ],
        properties: {
          artifact_id: { type: "string", pattern: "^dra_[a-f0-9]{32}$" },
          kind: { enum: researchArtifactKinds },
          filename: { type: "string", minLength: 1, maxLength: 255 },
          content_type: {
            enum: [
              "text/markdown; charset=utf-8",
              "text/plain; charset=utf-8"
            ]
          },
          size_bytes: { type: "integer", minimum: 0 },
          sha256: { type: "string", pattern: sha256Pattern },
          expires_at: { type: "string", pattern: isoInstantPattern },
          download_url: {
            type: "string",
            pattern:
              "^/gateway/research/v1/artifacts/dra_[a-f0-9]{32}/download$"
          }
        }
      }
    }
  }
} as const;

const {
  request_id: _requestIdProperty,
  run_id: _runIdProperty,
  artifacts: _artifactsProperty,
  ...doctorResearchModelOutputProperties
} = doctorResearchResultSchema.properties;

export const doctorResearchModelOutputSchema = {
  $id: doctorResearchModelOutputSchemaVersion,
  type: "object",
  additionalProperties: false,
  required: doctorResearchResultSchema.required.filter(
    (name) => name !== "request_id" && name !== "run_id" && name !== "artifacts"
  ),
  properties: {
    ...doctorResearchModelOutputProperties,
    schema_version: { const: doctorResearchModelOutputSchemaVersion }
  }
} as const;

const {
  references: _draftReferencesProperty,
  search_report: _draftSearchReportProperty,
  ...doctorResearchModelDraftReviewProperties
} = doctorResearchResultSchema.properties.review.properties;

export const doctorResearchModelDraftSchema = {
  $id: doctorResearchModelDraftSchemaVersion,
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "profile",
    "review",
    "predicted_questions",
    "answers"
  ],
  properties: {
    schema_version: { const: doctorResearchModelDraftSchemaVersion },
    profile: doctorResearchResultSchema.properties.profile,
    review: {
      ...doctorResearchResultSchema.properties.review,
      required: doctorResearchResultSchema.properties.review.required.filter(
        (name) => name !== "references" && name !== "search_report"
      ),
      properties: doctorResearchModelDraftReviewProperties
    },
    predicted_questions:
      doctorResearchResultSchema.properties.predicted_questions,
    answers: doctorResearchResultSchema.properties.answers
  }
} as const;

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  allowUnionTypes: true
});
const validateResult = ajv.compile(
  doctorResearchResultSchema
) as ValidateFunction<DoctorResearchResult>;
const validateModelOutput = ajv.compile(
  doctorResearchModelOutputSchema
) as ValidateFunction<DoctorResearchModelOutput>;
const validateModelDraft = ajv.compile(
  doctorResearchModelDraftSchema
) as ValidateFunction<DoctorResearchModelDraft>;
const validateRunReceipt = ajv.compile(
  doctorResearchRunReceiptSchema
) as ValidateFunction<DoctorResearchRunReceipt>;

export function validateDoctorResearchRunReceipt(
  value: unknown
):
  | { ok: true; value: DoctorResearchRunReceipt }
  | { ok: false; errors: string[] } {
  if (!validateRunReceipt(value)) {
    return {
      ok: false,
      errors: sanitizedAjvErrors(validateRunReceipt.errors)
    };
  }
  if (
    !value.status_url.endsWith(value.run_id) ||
    value.result_url !== `${value.status_url}/result`
  ) {
    return {
      ok: false,
      errors: ["run URLs must reference the returned run_id"]
    };
  }
  return { ok: true, value };
}

export function parseAndValidateDoctorResearchResult(
  text: string
): DoctorResearchContractResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      kind: "parse_error",
      errors: ["response must contain exactly one valid JSON value"]
    };
  }
  return validateDoctorResearchResultValue(parsed);
}

export function validateDoctorResearchResultValue(
  value: unknown
): DoctorResearchContractResult {
  if (!validateResult(value)) {
    return {
      ok: false,
      kind: "schema_error",
      errors: sanitizedAjvErrors(validateResult.errors)
    };
  }
  const semanticErrors = [
    ...validateContentSemantics(value),
    ...validateArtifactSemantics(value)
  ];
  if (semanticErrors.length > 0) {
    return {
      ok: false,
      kind: "semantic_error",
      errors: semanticErrors
    };
  }
  return { ok: true, value };
}

export function parseAndValidateDoctorResearchModelOutput(
  text: string
): DoctorResearchContractResult<DoctorResearchModelOutput> {
  const parsed = parseStrictModelJson(text);
  if (!parsed.ok) {
    return {
      ok: false,
      kind: "parse_error",
      errors: ["response must contain exactly one valid JSON value"]
    };
  }
  if (!validateModelOutput(parsed.value)) {
    return {
      ok: false,
      kind: "schema_error",
      errors: sanitizedAjvErrors(validateModelOutput.errors)
    };
  }
  const semanticErrors = validateContentSemantics(parsed.value);
  if (semanticErrors.length > 0) {
    return {
      ok: false,
      kind: "semantic_error",
      errors: semanticErrors
    };
  }
  return { ok: true, value: parsed.value };
}

export function parseAndValidateDoctorResearchModelDraft(
  text: string
): DoctorResearchContractResult<DoctorResearchModelDraft> {
  const parsed = parseStrictModelJson(text);
  if (!parsed.ok) {
    return {
      ok: false,
      kind: "parse_error",
      errors: ["response must contain exactly one valid JSON value"]
    };
  }
  if (!validateModelDraft(parsed.value)) {
    return {
      ok: false,
      kind: "schema_error",
      errors: sanitizedAjvErrors(validateModelDraft.errors)
    };
  }
  const semanticErrors: string[] = [];
  const claimIds = new Set<string>();
  for (const claim of parsed.value.profile.claims) {
    if (claimIds.has(claim.claim_id)) {
      semanticErrors.push(`duplicate claim_id: ${claim.claim_id}`);
    }
    claimIds.add(claim.claim_id);
  }
  if (
    parsed.value.answers.some(
      (answer, index) => answer.question_index !== index + 1
    )
  ) {
    semanticErrors.push(
      "answers must use question_index 1 through 5 in order"
    );
  }
  if (semanticErrors.length > 0) {
    return {
      ok: false,
      kind: "semantic_error",
      errors: semanticErrors
    };
  }
  return { ok: true, value: parsed.value };
}

function parseStrictModelJson(
  text: string
): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const fenced =
      /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/iu.exec(trimmed);
    if (!fenced) {
      return { ok: false };
    }
    try {
      return { ok: true, value: JSON.parse(fenced[1]!.trim()) };
    } catch {
      return { ok: false };
    }
  }
}

export function assembleDoctorResearchResult(input: {
  modelOutput: DoctorResearchModelOutput;
  requestId: string;
  runId: string;
  artifacts: readonly DoctorResearchArtifactManifest[];
}): DoctorResearchResult {
  const {
    schema_version: _modelSchemaVersion,
    ...content
  } = input.modelOutput;
  const candidate = {
    ...content,
    schema_version: doctorResearchResultSchemaVersion,
    request_id: input.requestId,
    run_id: input.runId,
    artifacts: [...input.artifacts]
  };
  const validated = validateDoctorResearchResultValue(candidate);
  if (!validated.ok) {
    throw new Error(
      `Cannot assemble Doctor Research result: ${validated.errors.join(", ")}`
    );
  }
  return validated.value;
}

export interface ContractRepairMetrics {
  firstAttemptPassed: boolean;
  initialFailureKind: DoctorResearchContractFailureKind | null;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  modelContractError: boolean;
}

export async function validateWithSingleRepair(
  initialText: string,
  repair: (errors: readonly string[]) => Promise<string>
): Promise<{
  result: DoctorResearchContractResult<DoctorResearchModelOutput>;
  metrics: ContractRepairMetrics;
}> {
  const first = parseAndValidateDoctorResearchModelOutput(initialText);
  if (first.ok) {
    return {
      result: first,
      metrics: {
        firstAttemptPassed: true,
        initialFailureKind: null,
        repairAttempted: false,
        repairSucceeded: false,
        modelContractError: false
      }
    };
  }
  const repairedText = await repair(first.errors.slice(0, 8));
  const repaired = parseAndValidateDoctorResearchModelOutput(repairedText);
  return {
    result: repaired,
    metrics: {
      firstAttemptPassed: false,
      initialFailureKind: first.kind,
      repairAttempted: true,
      repairSucceeded: repaired.ok,
      modelContractError: !repaired.ok
    }
  };
}

function validateContentSemantics(result: DoctorResearchContent): string[] {
  const errors: string[] = [];
  const sourceIds = new Set(result.sources.map((source) => source.source_id));
  if (sourceIds.size !== result.sources.length) {
    errors.push("sources must use unique source_id values");
  }
  const claimIds = new Set<string>();
  for (const claim of result.profile.claims) {
    if (claimIds.has(claim.claim_id)) {
      errors.push(`duplicate claim_id: ${claim.claim_id}`);
    }
    claimIds.add(claim.claim_id);
    for (const sourceId of claim.source_ids) {
      if (!sourceIds.has(sourceId)) {
        errors.push(`claim ${claim.claim_id} references unknown source_id`);
      }
    }
  }
  for (const sourceId of result.profile.primary_public_source_ids) {
    if (!sourceIds.has(sourceId)) {
      errors.push("primary_public_source_ids contains an unknown source_id");
    }
  }
  const referenceIds = new Set(
    result.review.references.map((reference) => reference.reference_id)
  );
  if (referenceIds.size !== result.review.references.length) {
    errors.push("references must use unique reference_id values");
  }
  for (const evidence of result.review.core_evidence) {
    if (!referenceIds.has(evidence.reference_id)) {
      errors.push(
        `core evidence references unknown reference_id: ${evidence.reference_id}`
      );
    }
  }
  const answerIndexes = result.answers.map((answer) => answer.question_index);
  if (answerIndexes.some((value, index) => value !== index + 1)) {
    errors.push("answers must use question_index 1 through 5 in order");
  }
  for (const answer of result.answers) {
    for (const sourceId of answer.source_ids) {
      if (!sourceIds.has(sourceId)) {
        errors.push(`answer ${answer.question_index} references unknown source_id`);
      }
    }
  }
  return errors;
}

function validateArtifactSemantics(result: DoctorResearchResult): string[] {
  const errors: string[] = [];
  const artifactKinds = new Set(
    result.artifacts.map((artifact) => artifact.kind)
  );
  if (
    artifactKinds.size !== researchArtifactKinds.length ||
    researchArtifactKinds.some((kind) => !artifactKinds.has(kind))
  ) {
    errors.push("artifacts must contain each standard kind exactly once");
  }
  for (const artifact of result.artifacts) {
    const expectedContentType =
      artifact.kind === "questions"
        ? "text/plain; charset=utf-8"
        : "text/markdown; charset=utf-8";
    if (artifact.content_type !== expectedContentType) {
      errors.push(`artifact ${artifact.kind} has the wrong content_type`);
    }
  }
  return errors;
}

function sanitizedAjvErrors(
  errors: ErrorObject[] | null | undefined
): string[] {
  return (errors ?? []).slice(0, 16).map((error) => {
    const path = error.instancePath || "/";
    return `${path}: ${error.keyword}`;
  });
}

function stringArray(minItems = 0) {
  return {
    type: "array",
    minItems,
    uniqueItems: true,
    items: { type: "string", minLength: 1 }
  } as const;
}
