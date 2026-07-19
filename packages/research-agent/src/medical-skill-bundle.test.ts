import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadMedicalSkillBundle,
  medicalSkillRelativePaths,
  renderMedicalSkillBundleForPrompt
} from "./medical-skill-bundle.js";

describe("medical-team Research Skill bundle", () => {
  it("loads the four authoritative SKILL.md files byte-for-byte", () => {
    const root = path.resolve("docs/research/采访skill");
    const bundle = loadMedicalSkillBundle(root);

    expect(bundle.documents.map((document) => document.relativePath)).toEqual(
      medicalSkillRelativePaths
    );
    expect(bundle.digest).toMatch(/^[a-f0-9]{64}$/u);
    for (const document of bundle.documents) {
      const bytes = readFileSync(path.resolve(root, document.relativePath));
      expect(document.content).toBe(bytes.toString("utf8"));
      expect(document.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex")
      );
      expect(Object.isFrozen(document)).toBe(true);
    }
    const prompt = renderMedicalSkillBundleForPrompt(bundle);
    expect(prompt).toContain("BEGIN MEDICAL TEAM SKILL BUNDLE");
    expect(prompt).toContain("doctor-research-query/SKILL.md");
    expect(prompt).toContain("literature-review/SKILL.md");
    expect(prompt).toContain("citation-management/SKILL.md");
    expect(prompt).toContain("scientific-writing/SKILL.md");
  });
});
