import { describe, expect, it } from "vitest";
import { reviewedDepartmentNames, reviewedInstitutionHomepage, reviewedInstitutionNames } from "./institution-names.js";

describe("reviewed institution translations", () => {
  it("preserves unreviewed institutions and distinguishes universities from hospitals", () => {
    for (const name of ["亚琛工业大学", "慕尼黑大学", "慕尼黑工业大学附属右岸医院", "比萨大学", "Università degli Studi di Milano-Bicocca", "ASST Papa Giovanni XXIII"]) {
      expect(reviewedInstitutionNames(name)).toEqual([name]);
      expect(reviewedInstitutionHomepage(name)).toBeUndefined();
    }
  });

  it("does not infer a hospital from a generic acronym or a department from a keyword", () => {
    expect(reviewedInstitutionNames("TUM")).toEqual(["TUM"]);
    expect(reviewedDepartmentNames("心脏核医学研究中心")).toEqual(["心脏核医学研究中心"]);
    expect(reviewedDepartmentNames("心内科")).toEqual(["心内科"]);
  });
});
