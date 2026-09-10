// Reviewed name translations, not identity records. A name match still needs
// fetched evidence containing the person, institution and department.
// The first name is used for discovery; the original request is preserved.
// Reviewed 2026-09-07 against the sources below.
const institutionNames: readonly (readonly string[])[] = [
  // https://www.ukaachen.de/en/
  [
    "Uniklinik RWTH Aachen",
    "德国亚琛工业大学医院",
    "亚琛工业大学医院",
    "Universitätsklinikum Aachen"
  ],
  // https://www.tum.de/en/
  // This is the university, not an alias for every affiliated hospital.
  [
    "Technical University of Munich",
    "德国慕尼黑工业大学（TUM）",
    "慕尼黑工业大学",
    "Technische Universität München"
  ],
  // https://www.europeancancer.org/content/paola-anna-erba.html
  // This institution appears in the historical career record. It is not an
  // alias for Bicocca University or ASST Papa Giovanni XXIII in Bergamo.
  ["University Hospital in Pisa", "比萨大学医院"],
  // Reviewed 2026-09-10 against the institutions' own sites.
  // https://www.insel.ch/de/
  ["Inselspital", "瑞士伯尔尼大学小岛医院", "伯尔尼大学小岛医院", "Inselspital Bern", "Universitätsspital Bern"],
  // https://www.umcg.nl/ and https://www.umcg.nl/-/r-slart
  ["University Medical Center Groningen", "荷兰格罗宁根大学医学中心", "格罗宁根大学医学中心", "UMCG", "UMC Groningen", "Universitair Medisch Centrum Groningen"],
  // https://www.novartis.com/
  ["Novartis", "诺华", "Novartis Pharma AG"],
  // https://eanm.org/
  ["European Association of Nuclear Medicine", "欧洲核医学协会", "EANM"],
  // https://www.fahcqmu.cn/gw_ksjs_ck_ysjs/020027900004870.html
  ["重庆医科大学附属第一医院", "重医附一院"],
  // https://www.njfybjy.com/about/about3.aspx
  ["南京市妇幼保健院"],
  // https://www.wchscu.cn/expertlist/detail/68892.html
  ["四川大学华西医院", "华西医院"]
];

const departmentNames: readonly (readonly string[])[] = [
  // https://www.ukaachen.de/en/clinics-institutes/klinik-fuer-nuklearmedizin/
  ["Nuklearmedizin", "核医学科", "Klinik für Nuklearmedizin", "Nuclear Medicine", "Nucleaire Geneeskunde"],
  // https://www.professoren.tum.de/en/schwaiger-markus
  ["Nuclear Medical Clinic and Policlinic", "核医学诊所"],
  // https://www.europeancancer.org/content/paola-anna-erba.html
  ["Regional Center of Nuclear Medicine", "区域核医学中心"],
  // https://www.umcg.nl/-/behandelteam-thoracale-oncologie
  ["Nuclear Medicine and Molecular Imaging", "Nuclear Medicine & Molecular Imaging", "核医学与分子影像科", "Nucleaire Geneeskunde en Moleculaire Beeldvorming"],
  // https://www.novartis.com/research-and-development/technology-platforms/radioligand-therapy
  ["Radioligand Therapy", "Radioligand Therapies", "放射配体治疗部门", "放射配体治疗（RLT）部门", "放射配体治疗", "RLT"],
  // https://www.rsna.org/news/2021/september/QIBA-EARL
  ["Accreditation", "Accreditation Programme", "Accreditation Program", "认证项目"]
];

export function reviewedInstitutionNames(value: string): readonly string[] {
  return reviewedNames(value, institutionNames);
}

export function reviewedInstitutionHomepage(value: string): string | undefined {
  const name = reviewedInstitutionNames(value)[0];
  if (name === "Uniklinik RWTH Aachen") return "https://www.ukaachen.de/en/";
  if (name === "Technical University of Munich") return "https://www.tum.de/en/";
  if (name === "Inselspital") return "https://www.insel.ch/de/";
  if (name === "University Medical Center Groningen") return "https://www.umcg.nl/";
  if (name === "Novartis") return "https://www.novartis.com/";
  if (name === "European Association of Nuclear Medicine") return "https://eanm.org/";
  if (name === "重庆医科大学附属第一医院") return "https://www.fahcqmu.cn/";
  if (name === "南京市妇幼保健院") return "https://www.njfybjy.com/";
  if (name === "四川大学华西医院") return "https://www.wchscu.cn/";
  return undefined;
}

export function reviewedInstitutionHostMatches(institution: string, hostname: string): boolean {
  const homepage = reviewedInstitutionHomepage(institution);
  if (!homepage) return false;
  const domain = new URL(homepage).hostname.replace(/^www\./u, "");
  // UMCG's own research portal links back to the medical center and publishes
  // its staff profiles: https://umcgresearch.org/about-umcg-research
  if (domain === "umcg.nl" && (hostname === "umcgresearch.org" || hostname.endsWith(".umcgresearch.org"))) return true;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

// These organizations publish first-hand professional profiles and collaboration
// records. Their pages must still name the requested person AND affiliation.
// https://www.europeancancer.org/content/leonhard-schaetz.html
// https://www.rsna.org/news/2021/september/QIBA-EARL
export function reviewedProfessionalPublisher(hostname: string): boolean {
  // Chinese universities publish their affiliated hospitals' staff and news.
  // Unlike a reviewed institution domain, this still requires explicit
  // person + requested hospital + department evidence in the fetched page.
  if (hostname.endsWith(".edu.cn") || hostname.endsWith(".gov.cn")) return true;
  // DECISIVE publishes its own initiators' professional profiles:
  // https://www.ngfdecisive.nl/initiators/riemer-slart
  return ["europeancancer.org", "rsna.org", "ngfdecisive.nl"].some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
}

export function reviewedProfileDirectoryCandidates(name: string): readonly string[] {
  // ECO's public speaker/profile directory uses full-name slugs, e.g.
  // /content/paola-anna-erba.html and /content/leonhard-schaetz.html.
  // This is only a URL candidate: missing pages and identity mismatches must
  // fail normal fetched-evidence verification. No person records are stored.
  const words = name.normalize("NFKC").trim().toLowerCase();
  if (!/^[a-z]+(?:[ -][a-z]+){1,3}$/u.test(words)) return [];
  return [`https://www.europeancancer.org/content/${words.replaceAll(" ", "-")}.html`];
}

export function requestedDepartmentEvidenceGroups(value: string): readonly (readonly string[])[] {
  const normalized = value.normalize("NFKC").trim();
  const roles = [...normalized.matchAll(/党委书记|党委副书记|副院长|院长/gu)].map((match) => match[0]);
  if (roles.length === 0) return [reviewedDepartmentNames(value)];
  // Some clients put a composite administrative role in the department field.
  // A parenthetical clinical specialty identifies the person independently of
  // an administrative appointment. Appointments must be supported separately
  // by profile claims; report headers label the original field as search input.
  const specialty = /\(([^()]*)\)/u.exec(normalized)?.[1];
  const specialties = specialty?.split(/[、,，/]/u)
    .map((part) => part.replace(/方向$/u, "").trim()).filter((part) => part.length >= 2) ?? [];
  return specialties.length > 0
    ? [specialties.flatMap((part) => reviewedDepartmentNames(part))]
    : [roles];
}

export function reviewedDepartmentNames(value: string): readonly string[] {
  return reviewedNames(value, departmentNames);
}

function reviewedNames(value: string, groups: readonly (readonly string[])[]): readonly string[] {
  const normalize = (name: string): string => name.normalize("NFKC").trim().toLowerCase();
  const requested = normalize(value);
  return groups.find((names) => names.some((name) => normalize(name) === requested)) ?? [value];
}
