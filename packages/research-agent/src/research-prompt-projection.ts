export const doctorResearchPromptProjectionVersion =
  "doctor_research_prompt_projection.v1";

export const maximumPromptAbstractCharacters = 4_000;

interface PromptProjectionReference {
  reference_id: string;
  title: string;
  journal: string | null;
  publication_year: number | null;
  pmid: string | null;
  doi: string | null;
}

interface PromptProjectionPublication {
  reference_id: string;
  authors: readonly string[];
  abstract: string | null;
}

export function buildResearchPromptProjection(input: {
  doctor: {
    name: string;
    hospital: string | null;
    department: string | null;
  };
  searchQueries: readonly string[];
  references: readonly PromptProjectionReference[];
  publicationEvidence: readonly PromptProjectionPublication[];
  localReferenceIndexes: readonly number[];
}): {
  projection_version: typeof doctorResearchPromptProjectionVersion;
  doctor_context: {
    name: string;
    hospital: string | null;
    department: string | null;
  };
  search_scope: Array<{ search_id: string; expression: string }>;
  global_reference_map: Array<{
    citation: number;
    evidence_id: string;
    source_id: string | null;
    title: string;
  }>;
  closed_evidence: Array<{
    evidence_id: string;
    citation: number;
    source_id: string | null;
    journal: string | null;
    publication_year: number | null;
    pmid: string | null;
    doi: string | null;
    authors: string[];
    omitted_author_count: number;
    abstract: string | null;
  }>;
} {
  const publicationByReferenceId = new Map(
    input.publicationEvidence.map((publication) => [
      publication.reference_id,
      publication
    ])
  );
  const global_reference_map = input.references.map((reference, index) => ({
    citation: index + 1,
    evidence_id: reference.reference_id,
    source_id: reference.pmid ? `src_pubmed_${reference.pmid}` : null,
    title: reference.title
  }));
  const closed_evidence = [
    ...new Set(input.localReferenceIndexes)
  ]
    .sort((left, right) => left - right)
    .map((index) => {
      const reference = input.references[index];
      if (!reference) {
        return null;
      }
      const publication = publicationByReferenceId.get(
        reference.reference_id
      );
      const authors = (publication?.authors ?? [])
        .slice(0, 12)
        .map((author) => mechanicallyBoundPromptText(author, 160));
      return {
        evidence_id: reference.reference_id,
        citation: index + 1,
        source_id: reference.pmid
          ? `src_pubmed_${reference.pmid}`
          : null,
        journal: reference.journal,
        publication_year: reference.publication_year,
        pmid: reference.pmid,
        doi: reference.doi,
        authors,
        omitted_author_count: Math.max(
          0,
          (publication?.authors.length ?? 0) - authors.length
        ),
        abstract: publication?.abstract
          ? mechanicallyBoundPromptText(
              publication.abstract,
              maximumPromptAbstractCharacters,
              " [bounded abstract: middle omitted] "
            )
          : null
      };
    })
    .filter((item) => item !== null);
  return {
    projection_version: doctorResearchPromptProjectionVersion,
    doctor_context: {
      name: input.doctor.name,
      hospital: input.doctor.hospital,
      department: input.doctor.department
    },
    search_scope: input.searchQueries.map((query, index) => ({
      search_id: `search_${index + 1}`,
      expression: mechanicallyBoundPromptText(query, 1_000)
    })),
    global_reference_map,
    closed_evidence
  };
}

export function mechanicallyBoundPromptText(
  value: string,
  maximumCharacters: number,
  marker = " [bounded text: middle omitted] "
): string {
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= maximumCharacters) {
    return normalized;
  }
  const markerCharacters = Array.from(marker);
  if (maximumCharacters <= markerCharacters.length + 2) {
    return characters.slice(0, maximumCharacters).join("");
  }
  const available = maximumCharacters - markerCharacters.length;
  const leading = Math.ceil(available * 0.6);
  return [
    ...characters.slice(0, leading),
    ...markerCharacters,
    ...characters.slice(-(available - leading))
  ].join("");
}
