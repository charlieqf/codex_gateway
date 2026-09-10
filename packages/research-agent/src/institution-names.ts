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
  ["University Hospital in Pisa", "比萨大学医院"]
];

const departmentNames: readonly (readonly string[])[] = [
  // https://www.ukaachen.de/en/clinics-institutes/klinik-fuer-nuklearmedizin/
  ["Nuklearmedizin", "核医学科", "Klinik für Nuklearmedizin"],
  // https://www.professoren.tum.de/en/schwaiger-markus
  ["Nuclear Medical Clinic and Policlinic", "核医学诊所"],
  // https://www.europeancancer.org/content/paola-anna-erba.html
  ["Regional Center of Nuclear Medicine", "区域核医学中心"]
];

export function reviewedInstitutionNames(value: string): readonly string[] {
  return reviewedNames(value, institutionNames);
}

export function reviewedInstitutionHomepage(value: string): string | undefined {
  const name = reviewedInstitutionNames(value)[0];
  if (name === "Uniklinik RWTH Aachen") return "https://www.ukaachen.de/en/";
  if (name === "Technical University of Munich") return "https://www.tum.de/en/";
  return undefined;
}

export function reviewedDepartmentNames(value: string): readonly string[] {
  return reviewedNames(value, departmentNames);
}

function reviewedNames(value: string, groups: readonly (readonly string[])[]): readonly string[] {
  const normalize = (name: string): string => name.normalize("NFKC").trim().toLowerCase();
  const requested = normalize(value);
  return groups.find((names) => names.some((name) => normalize(name) === requested)) ?? [value];
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


export function reviewedInstitutionHostMatches(institution: string, hostname: string): boolean {
  const homepage = reviewedInstitutionHomepage(institution);
  if (!homepage) return false;
  const domain = new URL(homepage).hostname.replace(/^www\./u, "");
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function reviewedProfessionalPublisher(hostname: string): boolean {
  return hostname.endsWith(".edu.cn") || hostname.endsWith(".gov.cn");
}
