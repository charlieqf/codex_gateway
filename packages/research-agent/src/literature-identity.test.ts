import type { ResearchDoctorInput } from "@codex-gateway/core";
import { describe, expect, it } from "vitest";
import {
  literatureAffiliationMatches,
  literatureAuthorMatches,
  resolveDoctorLiteratureIdentity
} from "./literature-identity.js";

const fixtures: ReadonlyArray<{
  name: string;
  hospital: string;
  department: string;
  city: string;
  pubmedAuthor: string;
  affiliation: string;
}> = [
  {
    name: "郎景和",
    hospital: "北京协和医院",
    department: "妇产科",
    city: "北京",
    pubmedAuthor: "Lang JH",
    affiliation:
      "Department of Obstetrics and Gynecology, Peking Union Medical College Hospital, Beijing, China."
  },
  {
    name: "赵玉沛",
    hospital: "北京协和医院",
    department: "基本外科",
    city: "北京",
    pubmedAuthor: "Zhao YP",
    affiliation:
      "Department of General Surgery, Peking Union Medical College Hospital, Beijing, China."
  },
  {
    name: "杨璐",
    hospital: "北京协和医院",
    department: "皮肤科",
    city: "北京",
    pubmedAuthor: "Yang L",
    affiliation:
      "Department of Dermatology, Peking Union Medical College Hospital, Beijing, China."
  },
  {
    name: "文煜冰",
    hospital: "北京协和医院",
    department: "肾内科",
    city: "北京",
    pubmedAuthor: "Wen YB",
    affiliation:
      "Department of Nephrology, Peking Union Medical College Hospital, Beijing, China."
  },
  {
    name: "张文宏",
    hospital: "复旦大学附属华山医院",
    department: "感染科",
    city: "上海",
    pubmedAuthor: "Zhang WH",
    affiliation:
      "Department of Infectious Diseases, Huashan Hospital, Fudan University, Shanghai, China."
  },
  {
    name: "乔杰",
    hospital: "北京大学第三医院",
    department: "妇产科",
    city: "北京",
    pubmedAuthor: "Qiao J",
    affiliation:
      "Department of Obstetrics and Gynecology, Peking University Third Hospital, Beijing, China."
  },
  {
    name: "葛均波",
    hospital: "复旦大学附属中山医院",
    department: "心内科",
    city: "上海",
    pubmedAuthor: "Ge JB",
    affiliation:
      "Department of Cardiology, Zhongshan Hospital, Fudan University, Shanghai, China."
  },
  {
    name: "陈赛娟",
    hospital: "上海交通大学医学院附属瑞金医院",
    department: "血液科",
    city: "上海",
    pubmedAuthor: "Chen SJ",
    affiliation:
      "Shanghai Institute of Hematology, Ruijin Hospital Affiliated to Shanghai Jiao Tong University School of Medicine, Shanghai, China."
  },
  {
    name: "李为民",
    hospital: "四川大学华西医院",
    department: "呼吸与危重症医学科",
    city: "成都",
    pubmedAuthor: "Li WM",
    affiliation:
      "Department of Respiratory and Critical Care Medicine, West China Hospital, Sichuan University, Chengdu, China."
  },
  {
    name: "王伟林",
    hospital: "浙江大学医学院附属第二医院",
    department: "肝胆胰外科",
    city: "杭州",
    pubmedAuthor: "Wang WL",
    affiliation:
      "Department of Hepatobiliary and Pancreatic Surgery, Second Affiliated Hospital, Zhejiang University School of Medicine, Hangzhou, China."
  }
];

describe("runtime Chinese doctor literature identity", () => {
  it.each(fixtures)(
    "generates bounded author candidates and strictly matches $name",
    (fixture) => {
      const identity = resolveDoctorLiteratureIdentity(doctor(fixture));

      expect(identity.runtimeGenerated).toBe(true);
      expect(identity.authorNames.length).toBeGreaterThan(0);
      expect(identity.authorNames.length).toBeLessThanOrEqual(5);
      expect(literatureAuthorMatches(identity, fixture.pubmedAuthor)).toBe(true);
      expect(literatureAffiliationMatches(identity, fixture.affiliation)).toBe(
        true
      );
    }
  );

  it("rejects the same author when either hospital or department is wrong", () => {
    const identity = resolveDoctorLiteratureIdentity(doctor(fixtures[0]!));

    expect(
      literatureAffiliationMatches(
        identity,
        "Department of Cardiology, Peking Union Medical College Hospital, Beijing, China."
      )
    ).toBe(false);
    expect(
      literatureAffiliationMatches(
        identity,
        "Department of Obstetrics and Gynecology, Peking University Third Hospital, Beijing, China."
      )
    ).toBe(false);
  });

  it("keeps a verified explicit English literature identity exact", () => {
    const identity = resolveDoctorLiteratureIdentity({
      ...doctor(fixtures[0]!),
      literatureIdentity: {
        name: "Jinghe Lang",
        hospital: "Peking Union Medical College Hospital",
        department: "Obstetrics and Gynecology"
      }
    });

    expect(identity.runtimeGenerated).toBe(false);
    expect(literatureAuthorMatches(identity, "Lang JH")).toBe(true);
    expect(
      literatureAffiliationMatches(identity, fixtures[0]!.affiliation)
    ).toBe(true);
  });
});

function doctor(
  fixture: Pick<
    (typeof fixtures)[number],
    "name" | "hospital" | "department" | "city"
  >
): ResearchDoctorInput {
  return {
    name: fixture.name,
    hospital: fixture.hospital,
    department: fixture.department,
    title: null,
    city: fixture.city,
    orcid: null
  };
}
