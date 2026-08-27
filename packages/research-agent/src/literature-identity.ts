import type { ResearchDoctorInput } from "@codex-gateway/core";
import { pinyin } from "pinyin-pro";

export interface DoctorLiteratureIdentity {
  runtimeGenerated: boolean;
  authorNames: readonly string[];
  hospitalQueryTerms: readonly string[];
  departmentQueryTerms: readonly string[];
  hospitalMatchGroups: readonly (readonly string[])[];
  departmentMatchGroups: readonly (readonly string[])[];
}

interface AffiliationComponent {
  chinese: string;
  aliases: readonly string[];
  kind: "distinctive" | "anchor" | "generic";
}

const compoundSurnames = new Set([
  "欧阳",
  "司马",
  "上官",
  "诸葛",
  "夏侯",
  "东方",
  "皇甫",
  "尉迟",
  "公孙",
  "慕容",
  "长孙",
  "司徒",
  "司空",
  "令狐"
]);

const hospitalComponents: readonly AffiliationComponent[] = [
  { chinese: "中国医学科学院", aliases: ["chinese academy of medical sciences"], kind: "distinctive" },
  { chinese: "中国科学院", aliases: ["chinese academy of sciences"], kind: "distinctive" },
  { chinese: "协和", aliases: ["union", "xiehe"], kind: "distinctive" },
  { chinese: "华西", aliases: ["west china", "huaxi"], kind: "distinctive" },
  { chinese: "友谊", aliases: ["friendship", "youyi"], kind: "distinctive" },
  { chinese: "人民", aliases: ["people", "renmin"], kind: "distinctive" },
  { chinese: "儿童", aliases: ["children", "pediatric", "paediatric"], kind: "distinctive" },
  { chinese: "肿瘤", aliases: ["cancer", "oncology"], kind: "distinctive" },
  { chinese: "第一", aliases: ["first", "1st"], kind: "distinctive" },
  { chinese: "第二", aliases: ["second", "2nd"], kind: "distinctive" },
  { chinese: "第三", aliases: ["third", "3rd"], kind: "distinctive" },
  { chinese: "第四", aliases: ["fourth", "4th"], kind: "distinctive" },
  { chinese: "第五", aliases: ["fifth", "5th"], kind: "distinctive" },
  { chinese: "医学中心", aliases: ["medical center", "medical centre"], kind: "anchor" },
  { chinese: "医疗中心", aliases: ["medical center", "medical centre"], kind: "anchor" },
  { chinese: "研究所", aliases: ["institute"], kind: "anchor" },
  { chinese: "医院", aliases: ["hospital"], kind: "anchor" },
  { chinese: "中心", aliases: ["center", "centre"], kind: "anchor" },
  { chinese: "医学院", aliases: ["medical college", "school of medicine"], kind: "generic" },
  { chinese: "大学", aliases: ["university"], kind: "generic" },
  { chinese: "附属", aliases: ["affiliated"], kind: "generic" }
];

const departmentComponents: ReadonlyArray<{
  chinese: string;
  groups: readonly (readonly string[])[];
}> = [
  { chinese: "呼吸与危重症医学科", groups: [["respiratory", "pulmonary"], ["critical care"]] },
  { chinese: "肝胆胰外科", groups: [["hepatobiliary"], ["pancreatic", "pancreas"]] },
  { chinese: "创伤骨科", groups: [["trauma"], ["orthopedic", "orthopaedic"]] },
  { chinese: "心血管内科", groups: [["cardiology", "cardiovascular"]] },
  { chinese: "生殖医学科", groups: [["reproductive medicine"]] },
  { chinese: "感染性疾病科", groups: [["infectious", "infection"]] },
  { chinese: "普通外科", groups: [["general surgery"]] },
  { chinese: "基本外科", groups: [["general surgery"]] },
  { chinese: "神经外科", groups: [["neurosurgery", "neurological surgery"]] },
  { chinese: "血管外科", groups: [["vascular surgery"]] },
  { chinese: "泌尿外科", groups: [["urology", "urologic surgery", "urological surgery"]] },
  { chinese: "妇产科", groups: [["obstetrics", "obstetric"], ["gynecology", "gynaecology"]] },
  { chinese: "肾内科", groups: [["nephrology", "renal medicine"]] },
  { chinese: "肾脏内科", groups: [["nephrology", "renal medicine"]] },
  { chinese: "消化内科", groups: [["gastroenterology", "digestive diseases"]] },
  { chinese: "内分泌科", groups: [["endocrinology"]] },
  { chinese: "风湿免疫科", groups: [["rheumatology", "rheumatic"]] },
  { chinese: "神经内科", groups: [["neurology"]] },
  { chinese: "呼吸科", groups: [["respiratory", "pulmonary"]] },
  { chinese: "血液科", groups: [["hematology", "haematology"]] },
  { chinese: "心内科", groups: [["cardiology", "cardiovascular"]] },
  { chinese: "感染科", groups: [["infectious", "infection"]] },
  { chinese: "皮肤科", groups: [["dermatology"]] },
  { chinese: "肿瘤科", groups: [["oncology", "cancer"]] },
  { chinese: "骨科", groups: [["orthopedic", "orthopaedic"]] },
  { chinese: "眼科", groups: [["ophthalmology"]] },
  { chinese: "耳鼻喉科", groups: [["otolaryngology", "otorhinolaryngology"]] }
];

export function resolveDoctorLiteratureIdentity(
  doctor: ResearchDoctorInput
): DoctorLiteratureIdentity {
  if (doctor.literatureIdentity) {
    return {
      runtimeGenerated: false,
      authorNames: latinAuthorVariants(doctor.literatureIdentity.name),
      hospitalQueryTerms: [doctor.literatureIdentity.hospital],
      departmentQueryTerms: [doctor.literatureIdentity.department],
      hospitalMatchGroups: [[doctor.literatureIdentity.hospital]],
      departmentMatchGroups: [[doctor.literatureIdentity.department]]
    };
  }

  const authorNames = chineseAuthorVariants(doctor.name);
  if (authorNames.length === 0) {
    return {
      runtimeGenerated: false,
      authorNames: latinAuthorVariants(doctor.name),
      hospitalQueryTerms: doctor.hospital ? [doctor.hospital] : [],
      departmentQueryTerms: doctor.department ? [doctor.department] : [],
      hospitalMatchGroups: doctor.hospital ? [[doctor.hospital]] : [],
      departmentMatchGroups: doctor.department ? [[doctor.department]] : []
    };
  }

  const hospital = chineseHospitalIdentity(
    doctor.hospital ?? "",
    doctor.city ?? ""
  );
  const departmentMatchGroups = chineseDepartmentGroups(
    doctor.department ?? ""
  );
  return {
    runtimeGenerated: true,
    authorNames,
    hospitalQueryTerms: uniqueStrings(
      hospital.distinctiveGroups.flatMap((group) => group)
    ).slice(0, 8),
    departmentQueryTerms: uniqueStrings(
      departmentMatchGroups.flatMap((group) => group)
    ).slice(0, 6),
    hospitalMatchGroups: [
      ...hospital.distinctiveGroups,
      ...(hospital.anchorGroups.length > 0
        ? [uniqueStrings(hospital.anchorGroups.flatMap((group) => group))]
        : [])
    ],
    departmentMatchGroups
  };
}

export function literatureAuthorMatches(
  identity: DoctorLiteratureIdentity,
  candidate: string
): boolean {
  return identity.authorNames.some((name) => namesCompatible(name, candidate));
}

export function literatureAffiliationMatches(
  identity: DoctorLiteratureIdentity,
  affiliation: string
): boolean {
  return (
    identity.hospitalMatchGroups.length >= (identity.runtimeGenerated ? 2 : 1) &&
    identity.departmentMatchGroups.length > 0 &&
    [...identity.hospitalMatchGroups, ...identity.departmentMatchGroups].every(
      (group) => group.some((alias) => phraseContains(affiliation, alias))
    )
  );
}

function chineseAuthorVariants(value: string): string[] {
  const chinese = value.replace(/[\s·•・]+/gu, "");
  if (!/^[\p{Script=Han}]{2,6}$/u.test(chinese)) {
    return [];
  }
  const tokens = pinyin(chinese, {
    toneType: "none",
    type: "array",
    surname: "head",
    nonZh: "removed",
    v: true
  });
  if (!Array.isArray(tokens) || tokens.length !== Array.from(chinese).length) {
    return [];
  }
  const surnameLength = compoundSurnames.has(chinese.slice(0, 2)) ? 2 : 1;
  const surname = titleCase(tokens.slice(0, surnameLength).join(""));
  const givenPinyin = tokens.slice(surnameLength);
  const givenTokens = givenPinyin.map(titleCase);
  if (!surname || givenTokens.length === 0 || givenTokens.some((token) => !token)) {
    return [];
  }
  const givenJoined = titleCase(givenPinyin.join(""));
  const initials = givenTokens.map((token) => token[0]!).join("").toUpperCase();
  return uniqueStrings([
    `${surname} ${initials}`,
    `${givenJoined} ${surname}`,
    `${givenTokens.join(" ")} ${surname}`,
    `${givenTokens.join("-")} ${surname}`,
    `${surname} ${givenJoined}`
  ]).slice(0, 5);
}

function latinAuthorVariants(value: string): string[] {
  const original = value.replace(/["()[\]{}]/gu, " ").trim();
  const tokens = original.match(/[A-Za-z]+/gu) ?? [];
  if (
    tokens.length < 2 ||
    tokens.join("").length !== (original.match(/[A-Za-z]/gu) ?? []).length
  ) {
    return original ? [original] : [];
  }
  const variants = [original];
  const addInitials = (surname: string, givenNames: readonly string[]): void => {
    const initials = givenNames.map((token) => token[0]!.toUpperCase());
    variants.push(`${surname} ${initials.join("")}`, `${surname} ${initials.join(" ")}`);
  };
  addInitials(tokens.at(-1)!, tokens.slice(0, -1));
  addInitials(tokens[0]!, tokens.slice(1));
  return uniqueStrings(variants).slice(0, 5);
}

function chineseHospitalIdentity(
  hospital: string,
  city: string
): {
  distinctiveGroups: string[][];
  anchorGroups: string[][];
} {
  let remaining = hospital.replace(/[^\p{Script=Han}]+/gu, "");
  const distinctiveGroups: string[][] = [];
  const anchorGroups: string[][] = [];
  const cityName = city.replace(/(?:特别行政区|自治区|自治州|地区|省|市|县|区)$/u, "");
  if (cityName && remaining.includes(cityName)) {
    distinctiveGroups.push(locationAliases(cityName));
    remaining = remaining.replaceAll(cityName, " ");
  }
  for (const component of hospitalComponents) {
    if (!remaining.includes(component.chinese)) {
      continue;
    }
    remaining = remaining.replaceAll(component.chinese, " ");
    if (component.kind === "distinctive") {
      distinctiveGroups.push([...component.aliases]);
    } else if (component.kind === "anchor") {
      anchorGroups.push([...component.aliases]);
    }
  }
  for (const chunk of remaining.match(/\p{Script=Han}+/gu) ?? []) {
    const aliases = romanizedAliases(chunk);
    if (aliases.length > 0) {
      distinctiveGroups.push(aliases);
    }
  }
  return {
    distinctiveGroups: uniqueGroups(distinctiveGroups),
    anchorGroups: uniqueGroups(anchorGroups)
  };
}

function chineseDepartmentGroups(value: string): string[][] {
  const normalized = value.replace(/\s+/gu, "");
  const match = departmentComponents.find((item) =>
    normalized.includes(item.chinese)
  );
  return match ? match.groups.map((group) => [...group]) : [];
}

function locationAliases(value: string): string[] {
  const aliases = romanizedAliases(value);
  if (value === "北京") {
    aliases.push("peking");
  }
  return uniqueStrings(aliases);
}

function romanizedAliases(value: string): string[] {
  const tokens = pinyin(value, {
    toneType: "none",
    type: "array",
    nonZh: "removed",
    v: true
  });
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return [];
  }
  return uniqueStrings([tokens.join(""), tokens.join(" ")]);
}

function titleCase(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1).toLowerCase() : "";
}

function namesCompatible(left: string, right: string): boolean {
  const aTokens = normalize(left).split(" ").filter(Boolean);
  const bTokens = normalize(right).split(" ").filter(Boolean);
  if (aTokens.length < 2 || bTokens.length < 2) {
    return normalize(left) === normalize(right);
  }
  for (const shared of aTokens.filter(
    (token) => token.length >= 2 && bTokens.includes(token)
  )) {
    const aRemaining = aTokens.filter((token) => token !== shared);
    const bRemaining = bTokens.filter((token) => token !== shared);
    if (
      initialsCovered(aRemaining, bRemaining) ||
      initialsCovered(bRemaining, aRemaining)
    ) {
      return true;
    }
  }
  return aTokens.every((token) => bTokens.includes(token)) ||
    bTokens.every((token) => aTokens.includes(token));
}

function initialsCovered(fullTokens: string[], abbreviatedTokens: string[]): boolean {
  return (
    fullTokens.length > 0 &&
    abbreviatedTokens.length > 0 &&
    abbreviatedTokens.every(
      (abbreviated) =>
        (abbreviated.length === 1 &&
          fullTokens.some((full) => full.startsWith(abbreviated))) ||
        (abbreviated.length === fullTokens.length &&
          [...abbreviated].every((initial, index) =>
            fullTokens[index]!.startsWith(initial)
          ))
    )
  );
}

function phraseContains(haystack: string, needle: string): boolean {
  const normalizedHaystack = ` ${normalize(haystack)} `;
  const normalizedNeedle = normalize(needle);
  return normalizedNeedle.length >= 2 &&
    normalizedHaystack.includes(` ${normalizedNeedle} `);
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Map(
    values
      .map((value) => value.replace(/\s+/gu, " ").trim())
      .filter(Boolean)
      .map((value) => [normalize(value), value] as const)
  ).values()];
}

function uniqueGroups(values: readonly (readonly string[])[]): string[][] {
  return [...new Map(
    values
      .map((group) => uniqueStrings(group))
      .filter((group) => group.length > 0)
      .map((group) => [group.map(normalize).join("|"), group] as const)
  ).values()];
}
