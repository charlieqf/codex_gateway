import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultMedicalSkillBundle,
  repairBoundedReviewPresentationIntegrity,
  runDoctorResearchReplayFixture,
  type DoctorResearchReplayFixture
} from "./index.js";

const fixtureRoot = path.resolve(
  "packages/research-agent/test-fixtures/replay"
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Doctor Research offline model-response replay", () => {
  const fixtures = loadReplayFixtures();

  it("loads only the independent reviewed replay directory", () => {
    expect(fixtureRoot.replaceAll("\\", "/")).not.toContain(
      "samples/known-invalid"
    );
    expect(fixtures.map((fixture) => fixture.fixture_id)).toEqual([
      ...fixtures.map((fixture) => fixture.fixture_id)
    ].sort());
    expect(fixtures.length).toBeGreaterThanOrEqual(13);
  });

  for (const fixture of fixtures) {
    it(`replays ${fixture.fixture_id} deterministically without network`, () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const activeSkillBundleSha256 =
        getDefaultMedicalSkillBundle().digest;
      const first = runDoctorResearchReplayFixture({
        fixture,
        activeSkillBundleSha256
      });
      const second = runDoctorResearchReplayFixture({
        fixture,
        activeSkillBundleSha256
      });
      expect(fetchSpy).not.toHaveBeenCalled();

      expect(first.terminalStatus).toBe(
        fixture.expected.terminal_status
      );
      expect(first.diagnostics).toEqual(
        fixture.expected.diagnostics
      );
      expect(second).toEqual(first);
      if (first.terminalStatus !== "succeeded") {
        expect(first.artifacts).toEqual([]);
        expect(first.artifactContentSha256).toBeNull();
        return;
      }

      const semantics = fixture.expected.artifact_semantics;
      expect(first.artifacts.map((artifact) => artifact.kind)).toEqual(
        semantics.exact_kinds
      );
      expect(
        first.artifacts.filter((artifact) =>
          artifact.contentType.startsWith("text/markdown")
        )
      ).toHaveLength(semantics.markdown_count);
      expect(
        first.artifacts.filter((artifact) =>
          artifact.contentType.startsWith("text/plain")
        )
      ).toHaveLength(semantics.text_count);
      expect(new Set(first.artifacts.map((artifact) => artifact.kind))).toHaveLength(4);
      for (const artifact of first.artifacts) {
        expect(
          createHash("sha256")
            .update(artifact.content, "utf8")
            .digest("hex")
        ).toBe(artifact.contentSha256);
      }
      expect(first.artifactContentSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(first.artifactContentSha256).toBe(
        semantics.aggregate_content_sha256
      );
    });
  }

  it("fails closed when the medical-team Skill digest changes", () => {
    expect(() =>
      runDoctorResearchReplayFixture({
        fixture: fixtures[0]!,
        activeSkillBundleSha256: "f".repeat(64)
      })
    ).toThrow("requires review");
  });

  it("fails closed when a derived policy version changes", () => {
    const fixture = structuredClone(fixtures[0]!);
    fixture.validation_version = "doctor_research_validation.v999";
    expect(() =>
      runDoctorResearchReplayFixture({
        fixture,
        activeSkillBundleSha256:
          getDefaultMedicalSkillBundle().digest
      })
    ).toThrow("policy versions are stale");
  });

  it("accepts the controlled-trial soft floor with explicit warnings", () => {
    const fixture = structuredClone(
      fixtures.find(
        (item) => item.fixture_id === "doctor_research_replay_valid"
      )!
    );
    fixture.fixture_id =
      "doctor_research_replay_controlled_trial_soft_floor";
    for (const call of fixture.model_calls) {
      if (
        call.role === "body" &&
        call.response_or_error.type === "synthetic_response"
      ) {
        call.response_or_error.variant =
          "controlled_trial_soft_floor";
      }
    }

    const first = runDoctorResearchReplayFixture({
      fixture,
      activeSkillBundleSha256: getDefaultMedicalSkillBundle().digest
    });
    const second = runDoctorResearchReplayFixture({
      fixture,
      activeSkillBundleSha256: getDefaultMedicalSkillBundle().digest
    });

    expect(first.terminalStatus).toBe("succeeded");
    expect(first.diagnostics).toEqual([]);
    expect(first.warnings).toEqual(
      expect.arrayContaining([
        "controlled_trial_review_content_below_target",
        "controlled_trial_topic_section_below_target"
      ])
    );
    expect(first.artifacts.map((artifact) => artifact.kind)).toEqual([
      "profile",
      "review",
      "questions",
      "answers"
    ]);
    expect(first.artifactContentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toEqual(first);
  });

  it("repairs a sole unmatched delimiter and reruns every hard gate", () => {
    const fixture = fixtures.find(
      (item) =>
        item.fixture_id ===
        "doctor_research_replay_unbalanced_delimiter"
    )!;
    const result = runDoctorResearchReplayFixture({
      fixture,
      activeSkillBundleSha256: getDefaultMedicalSkillBundle().digest
    });

    expect(result.terminalStatus).toBe("succeeded");
    expect(result.diagnostics).toEqual([
      "review_unbalanced_delimiter"
    ]);
    expect(result.warnings).toContain(
      "deterministic_delimiter_balance_applied"
    );
    expect(result.artifacts).toHaveLength(4);
  });

  it("repairs the bounded presentation-integrity bundle deterministically", () => {
    const fixture = structuredClone(
      fixtures.find(
        (item) => item.fixture_id === "doctor_research_replay_valid"
      )!
    );
    fixture.fixture_id =
      "doctor_research_replay_presentation_integrity_bundle";
    fixture.model_calls.push({
      stage: "validate_outputs",
      attempt: 4,
      role: "peer_review",
      response_or_error: {
        type: "synthetic_response",
        variant: "presentation_integrity_bundle"
      }
    });

    const first = runDoctorResearchReplayFixture({
      fixture,
      activeSkillBundleSha256: getDefaultMedicalSkillBundle().digest
    });
    const second = runDoctorResearchReplayFixture({
      fixture,
      activeSkillBundleSha256: getDefaultMedicalSkillBundle().digest
    });

    expect(first.terminalStatus).toBe("succeeded");
    expect(first.diagnostics).toEqual([
      "paragraph_citation_coverage",
      "review_unbalanced_delimiter",
      "review_inline_enumeration_sequence",
      "numeric_evidence_closure"
    ]);
    expect(first.warnings).toContain(
      "deterministic_safety_normalization_applied"
    );
    expect(first.artifacts).toHaveLength(4);
    expect(first.artifactContentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toEqual(first);
  });

  it("mechanically closes the exact production presentation bundle", () => {
    const paragraph =
      "公开摘要能够支持研究问题、资料来源和方法边界的结构化比较，未披露的信息不作补写，观察性关联不解释为因果，正式判断仍需结合全文与独立复核。[1-3]";
    const markdown = [
      "## 研究主题",
      paragraph,
      paragraph,
      "（1）核对公开摘要，（3）保留证据边界。） [1-3]"
    ].join("\n\n");
    const repaired = repairBoundedReviewPresentationIntegrity({
      markdown,
      language: "zh-CN",
      errorCodes: [
        "review_duplicate_paragraph",
        "review_unbalanced_delimiter",
        "review_inline_enumeration_sequence"
      ]
    });

    expect(repaired).toMatchObject({
      changed: true,
      duplicateParagraphRemoved: true,
      delimiterBalanceRepaired: true,
      inlineEnumerationNormalized: true
    });
    expect(repaired.markdown.match(/公开摘要能够支持/gu)).toHaveLength(1);
    expect(repaired.markdown).toContain("（一）核对公开摘要，（二）");
    expect(repaired.markdown).not.toContain("。）");

    const refused = repairBoundedReviewPresentationIntegrity({
      markdown,
      language: "zh-CN",
      errorCodes: [
        "review_duplicate_paragraph",
        "numeric_evidence_closure"
      ]
    });
    expect(refused).toMatchObject({ markdown, changed: false });
  });

  it("repairs fragment JSON encoding and normalizes unambiguous envelopes without changing artifact hashes", () => {
    const fixture = fixtures.find(
      (item) =>
        item.fixture_id ===
        "doctor_research_replay_body_fragment_envelope"
    )!;
    const first = runDoctorResearchReplayFixture({
      fixture,
      activeSkillBundleSha256: getDefaultMedicalSkillBundle().digest
    });
    const second = runDoctorResearchReplayFixture({
      fixture,
      activeSkillBundleSha256: getDefaultMedicalSkillBundle().digest
    });

    expect(first.terminalStatus).toBe("succeeded");
    expect(first.diagnostics).toEqual([]);
    expect(first.warnings).toContain(
      "deterministic_body_fragment_envelope_normalization_applied"
    );
    expect(first.warnings).toContain(
      "deterministic_fragment_json_encoding_repair_applied"
    );
    expect(first.warnings).toContain(
      "deterministic_review_fragment_envelope_normalization_applied"
    );
    expect(first.artifacts).toHaveLength(4);
    expect(first.artifactContentSha256).toBe(
      fixture.expected.artifact_semantics.aggregate_content_sha256
    );
    expect(second).toEqual(first);
  });

  it("removes extra unknown QA source IDs without changing accepted replay artifacts", () => {
    const fixture = structuredClone(
      fixtures.find(
        (item) => item.fixture_id === "doctor_research_replay_valid"
      )!
    );
    fixture.fixture_id =
      "doctor_research_replay_extra_unknown_qa_source";
    const body = fixture.model_calls.find(
      (call) => call.role === "body"
    )!;
    body.response_or_error = {
      type: "synthetic_response",
      variant: "extra_unknown_qa_source"
    };

    const first = runDoctorResearchReplayFixture({
      fixture,
      activeSkillBundleSha256: getDefaultMedicalSkillBundle().digest
    });
    const second = runDoctorResearchReplayFixture({
      fixture,
      activeSkillBundleSha256: getDefaultMedicalSkillBundle().digest
    });

    expect(first.terminalStatus).toBe("succeeded");
    expect(first.diagnostics).toEqual([]);
    expect(first.warnings).toContain(
      "deterministic_body_fragment_unknown_qa_source_removed"
    );
    expect(first.artifactContentSha256).toBe(
      fixtures.find(
        (item) => item.fixture_id === "doctor_research_replay_valid"
      )!.expected.artifact_semantics.aggregate_content_sha256
    );
    expect(JSON.stringify(first.artifacts)).not.toContain(
      "src_pubmed_999999999"
    );
    expect(second).toEqual(first);
  });

  it("fails closed when every QA source ID is outside closed evidence", () => {
    const fixture = structuredClone(
      fixtures.find(
        (item) => item.fixture_id === "doctor_research_replay_valid"
      )!
    );
    fixture.fixture_id =
      "doctor_research_replay_unknown_qa_source";
    const body = fixture.model_calls.find(
      (call) => call.role === "body"
    )!;
    body.response_or_error = {
      type: "synthetic_response",
      variant: "unknown_qa_source"
    };

    const first = runDoctorResearchReplayFixture({
      fixture,
      activeSkillBundleSha256: getDefaultMedicalSkillBundle().digest
    });
    const second = runDoctorResearchReplayFixture({
      fixture,
      activeSkillBundleSha256: getDefaultMedicalSkillBundle().digest
    });

    expect(first.terminalStatus).toBe("failed");
    expect(first.warnings).toEqual(
      expect.arrayContaining([
        "deterministic_body_fragment_qa_source_closure_deferred",
        "deterministic_body_fragment_qa_deferred_to_targeted_repair"
      ])
    );
    expect(first.artifacts).toEqual([]);
    expect(first.artifactContentSha256).toBeNull();
    expect(second).toEqual(first);
  });

  it("rejects ambiguous closing envelopes without choosing model content", () => {
    const fixture = structuredClone(
      fixtures.find(
        (item) => item.fixture_id === "doctor_research_replay_valid"
      )!
    );
    fixture.fixture_id =
      "doctor_research_replay_ambiguous_closing_envelope";
    const closing = fixture.model_calls.find(
      (call) => call.role === "closing"
    )!;
    closing.response_or_error = {
      type: "synthetic_response",
      variant: "ambiguous_review_fragment_envelope"
    };

    const result = runDoctorResearchReplayFixture({
      fixture,
      activeSkillBundleSha256: getDefaultMedicalSkillBundle().digest
    });

    expect(result.terminalStatus).toBe("failed");
    expect(result.diagnostics).toEqual(["fragment_contract_error"]);
    expect(result.artifacts).toEqual([]);
  });
});

function loadReplayFixtures(): DoctorResearchReplayFixture[] {
  return readdirSync(fixtureRoot)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      JSON.parse(
        readFileSync(path.join(fixtureRoot, name), "utf8")
      ) as DoctorResearchReplayFixture
    )
    .sort((left, right) =>
      left.fixture_id.localeCompare(right.fixture_id)
    );
}
