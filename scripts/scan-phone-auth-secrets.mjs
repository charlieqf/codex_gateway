import { execFileSync } from "node:child_process";

const base = process.argv[2];
if (!base || base.startsWith("-")) {
  throw new Error(
    "Usage: npm run scan:phone-auth-secrets -- <trusted-base-revision>"
  );
}

const diff = execFileSync(
  "git",
  ["diff", "--no-ext-diff", "--unified=0", base, "--"],
  { encoding: "utf8", maxBuffer: 32 * 1_024 * 1_024 }
);

const syntheticPhones = new Set(["13800138000", "13900139000"]);
const detectors = [
  {
    kind: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/u
  },
  {
    kind: "refresh_token",
    pattern: /rft_[A-Za-z0-9_-]{64}/u
  },
  {
    kind: "complete_cgu_key",
    pattern: /cgu_live_[A-Za-z0-9_-]{24,}/u
  },
  {
    kind: "provider_key",
    pattern: /(?:sk|xai|AIza)[-_][A-Za-z0-9_-]{20,}/u
  },
  {
    kind: "private_key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u
  }
];

const findings = [];
let file = null;
let addedLine = 0;
for (const line of diff.split(/\r?\n/u)) {
  if (line.startsWith("+++ b/")) {
    file = line.slice(6);
    continue;
  }
  const hunk = /^@@ -[^+]+\+(\d+)/u.exec(line);
  if (hunk) {
    addedLine = Number(hunk[1]);
    continue;
  }
  if (!line.startsWith("+") || line.startsWith("+++")) {
    continue;
  }
  const content = line.slice(1);
  for (const detector of detectors) {
    if (detector.pattern.test(content)) {
      findings.push({ file, line: addedLine, kind: detector.kind });
    }
  }
  for (const match of content.matchAll(/(?<![0-9])1[3-9][0-9]{9}(?![0-9])/gu)) {
    if (!syntheticPhones.has(match[0])) {
      findings.push({ file, line: addedLine, kind: "unapproved_phone" });
    }
  }
  addedLine += 1;
}

if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(
      `${finding.kind}: ${finding.file ?? "unknown"}:${finding.line}\n`
    );
  }
  throw new Error(`Sensitive artifact scan found ${findings.length} issue(s).`);
}

process.stdout.write(
  "Phone-auth sensitive artifact scan passed (no concrete JWT, Refresh Token, complete cgu key, provider key, private key, or unapproved phone).\n"
);
