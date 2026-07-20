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
    expect(bundle.digest).toBe(
      "6d5e839f942f87f1064a6d855c37b54302300aacd700360aa5fef8907a2fa351"
    );
    for (const document of bundle.documents) {
      const bytes = readFileSync(path.resolve(root, document.relativePath));
      expect(document.content).toBe(bytes.toString("utf8"));
      expect(document.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex")
      );
      expect(Object.isFrozen(document)).toBe(true);
    }
    const prompt = renderMedicalSkillBundleForPrompt(bundle);
    expect(prompt).toContain(
      "BEGIN MEDICAL TEAM SKILL EXECUTION PROJECTION"
    );
    expect(prompt).toContain(`bundle_sha256: ${bundle.digest}`);
    expect(prompt).toMatch(/projection_sha256: [a-f0-9]{64}/u);
    expect(prompt).toContain("doctor-research-query/SKILL.md");
    expect(prompt).toContain("literature-review/SKILL.md");
    expect(prompt).toContain("citation-management/SKILL.md");
    expect(prompt).toContain("scientific-writing/SKILL.md");
    expect(prompt).toContain("Core Workflow");
    expect(prompt).toContain("Common Pitfalls to Avoid");
    expect(prompt).not.toContain(
      "Visual Enhancement with Scientific Schematics"
    );
    expect(prompt).not.toContain("Required Python Packages");
    expect(prompt).not.toContain("七、完整输出示例（参考样例）");
  });
});
