import { describe, expect, it } from "vitest";
import {
  buildResearchPromptProjection,
  doctorResearchPromptProjectionVersion,
  maximumPromptAbstractCharacters
} from "./research-prompt-projection.js";

describe("Doctor Research prompt projection", () => {
  it("deduplicates titles and sends only the shard's bounded evidence", () => {
    const repeatedAbstract = "METHODS and RESULTS. ".repeat(500);
    const references = [
      {
        reference_id: "ref_pmid_1001",
        title: "Unique reference title one",
        journal: "Journal One",
        publication_year: 2025,
        pmid: "1001",
        doi: null
      },
      {
        reference_id: "ref_pmid_1002",
        title: "Unique reference title two",
        journal: "Journal Two",
        publication_year: 2024,
        pmid: "1002",
        doi: null
      }
    ];
    const publicationEvidence = references.map((reference) => ({
      reference_id: reference.reference_id,
      authors: Array.from({ length: 20 }, (_, index) => `Author ${index}`),
      abstract: repeatedAbstract
    }));

    const first = buildResearchPromptProjection({
      doctor: {
        name: "Example Doctor",
        hospital: "Example Hospital",
        department: "Cardiology"
      },
      searchQueries: ["bounded query"],
      references,
      publicationEvidence,
      localReferenceIndexes: [1]
    });
    const second = buildResearchPromptProjection({
      doctor: first.doctor_context,
      searchQueries: ["bounded query"],
      references,
      publicationEvidence,
      localReferenceIndexes: [1]
    });
    const serialized = JSON.stringify(first);

    expect(first).toEqual(second);
    expect(first.projection_version).toBe(
      doctorResearchPromptProjectionVersion
    );
    expect(first.closed_evidence).toHaveLength(1);
    expect(first.closed_evidence[0]).toMatchObject({
      evidence_id: "ref_pmid_1002",
      citation: 2,
      source_id: "src_pubmed_1002",
      omitted_author_count: 8
    });
    expect(Array.from(first.closed_evidence[0]!.abstract ?? "")).toHaveLength(
      maximumPromptAbstractCharacters
    );
    expect(serialized.match(/Unique reference title one/gu)).toHaveLength(1);
    expect(serialized.match(/Unique reference title two/gu)).toHaveLength(1);

    const legacyDuplicatedPayload = JSON.stringify({
      doctor: {
        name: "Example Doctor",
        hospital: "Example Hospital",
        department: "Cardiology"
      },
      search_queries: ["bounded query"],
      reference_titles: references.map((reference) => reference.title),
      publications: publicationEvidence.map((publication, index) => ({
        ...references[index],
        ...publication
      }))
    });
    expect(serialized.length).toBeLessThan(legacyDuplicatedPayload.length / 2);
  });
});
