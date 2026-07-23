import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultMedicalSkillBundle,
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

  it("normalizes an unambiguous body envelope and preserves artifact hashes", () => {
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
    expect(first.artifacts).toHaveLength(4);
    expect(first.artifactContentSha256).toBe(
      fixture.expected.artifact_semantics.aggregate_content_sha256
    );
    expect(second).toEqual(first);
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
