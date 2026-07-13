#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MIN_AGE_HOURS = 24;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function createArchivePlan({
  dbPath,
  accounts,
  archiveRoot,
  minAgeHours = DEFAULT_MIN_AGE_HOURS,
  nowMs = Date.now()
}) {
  const normalizedDbPath = requireAbsoluteExistingFile(dbPath, "Gateway database");
  const normalizedArchiveRoot = normalizeArchiveRoot(archiveRoot);
  const normalizedAccounts = normalizeAccounts(accounts);
  const minAgeMs = requireMinAgeHours(minAgeHours) * 60 * 60 * 1000;
  const cutoffMs = nowMs - minAgeMs;

  for (const account of normalizedAccounts) {
    if (
      pathIsInside(normalizedArchiveRoot, account.codexHome) ||
      pathIsInside(account.codexHome, normalizedArchiveRoot)
    ) {
      throw new Error(
        `Archive root must not overlap CODEX_HOME for account '${account.id}'.`
      );
    }
  }

  const refsByAccount = loadProviderSessionRefs(normalizedDbPath);
  const configuredIds = new Set(normalizedAccounts.map((account) => account.id));
  const unmapped = [...refsByAccount.keys()].filter((id) => !configuredIds.has(id));
  if (unmapped.length > 0) {
    throw new Error(
      `Gateway sessions reference unmapped upstream accounts: ${unmapped.sort().join(", ")}`
    );
  }

  const accountPlans = normalizedAccounts.map((account) => {
    const refs = refsByAccount.get(account.id) ?? new Set();
    const files = listRolloutFiles(account.sessionsRoot);
    const matchedRefs = new Set();
    const candidates = [];
    let totalBytes = 0;
    let referencedFiles = 0;
    let referencedBytes = 0;
    let freshFiles = 0;
    let freshBytes = 0;

    for (const file of files) {
      totalBytes += file.size;
      const matchedRef = [...refs].find((ref) => file.name.includes(ref));
      if (matchedRef) {
        matchedRefs.add(matchedRef);
        referencedFiles += 1;
        referencedBytes += file.size;
        continue;
      }
      if (file.mtimeMs > cutoffMs) {
        freshFiles += 1;
        freshBytes += file.size;
        continue;
      }

      candidates.push({
        accountId: account.id,
        source: file.path,
        sourceRelative: file.relativePath,
        destination: join(normalizedArchiveRoot, account.id, file.relativePath),
        size: file.size,
        mtimeMs: file.mtimeMs,
        dev: file.dev,
        ino: file.ino
      });
    }

    const missingRefs = [...refs].filter((ref) => !matchedRefs.has(ref));
    if (missingRefs.length > 0) {
      throw new Error(
        `Refusing to archive account '${account.id}': ${missingRefs.length} referenced provider session file(s) were not found.`
      );
    }

    return {
      id: account.id,
      codexHome: account.codexHome,
      sessionsRoot: account.sessionsRoot,
      providerSessionRefs: refs.size,
      matchedProviderSessionRefs: matchedRefs.size,
      totalFiles: files.length,
      totalBytes,
      referencedFiles,
      referencedBytes,
      freshFiles,
      freshBytes,
      candidateFiles: candidates.length,
      candidateBytes: candidates.reduce((sum, file) => sum + file.size, 0),
      candidates
    };
  });

  return {
    dbPath: normalizedDbPath,
    archiveRoot: normalizedArchiveRoot,
    minAgeHours,
    cutoffMs,
    createdAt: new Date(nowMs).toISOString(),
    accounts: accountPlans,
    totals: {
      providerSessionRefs: accountPlans.reduce(
        (sum, account) => sum + account.providerSessionRefs,
        0
      ),
      totalFiles: accountPlans.reduce((sum, account) => sum + account.totalFiles, 0),
      totalBytes: accountPlans.reduce((sum, account) => sum + account.totalBytes, 0),
      referencedFiles: accountPlans.reduce(
        (sum, account) => sum + account.referencedFiles,
        0
      ),
      referencedBytes: accountPlans.reduce(
        (sum, account) => sum + account.referencedBytes,
        0
      ),
      freshFiles: accountPlans.reduce((sum, account) => sum + account.freshFiles, 0),
      freshBytes: accountPlans.reduce((sum, account) => sum + account.freshBytes, 0),
      candidateFiles: accountPlans.reduce(
        (sum, account) => sum + account.candidateFiles,
        0
      ),
      candidateBytes: accountPlans.reduce(
        (sum, account) => sum + account.candidateBytes,
        0
      )
    }
  };
}

export function applyArchivePlan(plan, { manifestPath } = {}) {
  const normalizedManifestPath = requireAbsolutePath(
    manifestPath ?? join(plan.archiveRoot, `manifest-${timestampForPath(plan.createdAt)}.json`),
    "manifest path"
  );
  if (!pathIsInside(normalizedManifestPath, plan.archiveRoot)) {
    throw new Error("Manifest path must be inside the archive root.");
  }
  if (existsSync(normalizedManifestPath)) {
    throw new Error(`Manifest already exists: ${normalizedManifestPath}`);
  }

  mkdirSecure(plan.archiveRoot);
  const archiveStats = lstatSync(plan.archiveRoot);
  if (!archiveStats.isDirectory() || archiveStats.isSymbolicLink()) {
    throw new Error(`Archive root must be a real directory: ${plan.archiveRoot}`);
  }
  for (const account of plan.accounts) {
    const accountDevice = lstatSync(account.sessionsRoot).dev;
    if (accountDevice !== archiveStats.dev) {
      throw new Error(
        `Archive root must be on the same filesystem as account '${account.id}'.`
      );
    }
  }
  const manifest = {
    version: 1,
    createdAt: plan.createdAt,
    dbPath: plan.dbPath,
    archiveRoot: plan.archiveRoot,
    minAgeHours: plan.minAgeHours,
    totals: plan.totals,
    files: plan.accounts.flatMap((account) =>
      account.candidates.map((file) => ({
        accountId: file.accountId,
        source: file.source,
        destination: file.destination,
        size: file.size,
        mtimeMs: file.mtimeMs
      }))
    )
  };
  writeFileSync(normalizedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  const manifestFd = openSync(normalizedManifestPath, "r+");
  try {
    fsyncSync(manifestFd);
  } finally {
    closeSync(manifestFd);
  }

  let movedFiles = 0;
  let movedBytes = 0;
  for (const account of plan.accounts) {
    for (const file of account.candidates) {
      const current = lstatSync(file.source);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== file.dev ||
        current.ino !== file.ino ||
        current.size !== file.size ||
        current.mtimeMs !== file.mtimeMs
      ) {
        throw new Error(`Rollout changed after planning; refusing to move: ${file.source}`);
      }
      if (existsSync(file.destination)) {
        throw new Error(`Archive destination already exists: ${file.destination}`);
      }
      mkdirSecure(dirname(file.destination));
      renameSync(file.source, file.destination);
      movedFiles += 1;
      movedBytes += file.size;
    }
  }

  return { manifestPath: normalizedManifestPath, movedFiles, movedBytes };
}

export function summarizeArchivePlan(plan, mode, result) {
  return {
    mode,
    created_at: plan.createdAt,
    db_path: plan.dbPath,
    archive_root: plan.archiveRoot,
    min_age_hours: plan.minAgeHours,
    accounts: plan.accounts.map((account) => ({
      id: account.id,
      codex_home: account.codexHome,
      provider_session_refs: account.providerSessionRefs,
      matched_provider_session_refs: account.matchedProviderSessionRefs,
      total_files: account.totalFiles,
      total_bytes: account.totalBytes,
      referenced_files: account.referencedFiles,
      referenced_bytes: account.referencedBytes,
      fresh_files: account.freshFiles,
      fresh_bytes: account.freshBytes,
      candidate_files: account.candidateFiles,
      candidate_bytes: account.candidateBytes
    })),
    totals: plan.totals,
    ...(result
      ? {
          manifest_path: result.manifestPath,
          moved_files: result.movedFiles,
          moved_bytes: result.movedBytes
        }
      : {})
  };
}

export function archiveOptionsFromEnvironment(env = process.env) {
  const dbPath = env.GATEWAY_SQLITE_PATH;
  const archiveRoot = env.CODEX_GATEWAY_ROLLOUT_ARCHIVE_ROOT;
  if (!dbPath || !archiveRoot) {
    throw new Error(
      "Startup archive requires GATEWAY_SQLITE_PATH and CODEX_GATEWAY_ROLLOUT_ARCHIVE_ROOT."
    );
  }

  let accounts;
  if (env.GATEWAY_UPSTREAM_ACCOUNTS_JSON) {
    const configPath = requireAbsoluteExistingFile(
      env.GATEWAY_UPSTREAM_ACCOUNTS_JSON,
      "upstream account config"
    );
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
      throw new Error("Upstream account config must contain a non-empty accounts array.");
    }
    accounts = parsed.accounts.map((account, index) => {
      if (!isRecord(account)) {
        throw new Error(`Upstream account at index ${index} must be an object.`);
      }
      if (account.provider !== "openai-codex") {
        throw new Error(`Unsupported provider for upstream account at index ${index}.`);
      }
      if (typeof account.id !== "string" || typeof account.codexHome !== "string") {
        throw new Error(`Upstream account at index ${index} must define id and codexHome.`);
      }
      return { id: account.id, codexHome: account.codexHome };
    });
  } else {
    if (!env.CODEX_HOME) {
      throw new Error(
        "Startup archive requires GATEWAY_UPSTREAM_ACCOUNTS_JSON or CODEX_HOME."
      );
    }
    accounts = [
      {
        id: env.CODEX_GATEWAY_DEFAULT_UPSTREAM_ACCOUNT_ID ?? "sub_openai_codex_dev",
        codexHome: env.CODEX_HOME
      }
    ];
  }

  return {
    dbPath,
    archiveRoot,
    accounts,
    minAgeHours: Number(
      env.CODEX_GATEWAY_ROLLOUT_ARCHIVE_MIN_AGE_HOURS ?? DEFAULT_MIN_AGE_HOURS
    )
  };
}

function loadProviderSessionRefs(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT upstream_account_id, provider_session_ref
         FROM sessions
         WHERE provider_session_ref IS NOT NULL
           AND provider_session_ref <> ''`
      )
      .all();
    const refsByAccount = new Map();
    for (const row of rows) {
      const accountId = String(row.upstream_account_id ?? "");
      const providerSessionRef = String(row.provider_session_ref ?? "");
      if (!accountId || !providerSessionRef) {
        throw new Error("Gateway session has an incomplete upstream account/session reference.");
      }
      const refs = refsByAccount.get(accountId) ?? new Set();
      refs.add(providerSessionRef);
      refsByAccount.set(accountId, refs);
    }
    return refsByAccount;
  } finally {
    db.close();
  }
}

function normalizeAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("At least one --account <id>=<CODEX_HOME> mapping is required.");
  }
  const seen = new Set();
  return accounts.map((account) => {
    if (!ACCOUNT_ID_PATTERN.test(account.id)) {
      throw new Error(`Unsafe upstream account id: ${account.id}`);
    }
    if (seen.has(account.id)) {
      throw new Error(`Duplicate upstream account id: ${account.id}`);
    }
    seen.add(account.id);
    const codexHome = requireAbsoluteExistingDirectory(account.codexHome, "CODEX_HOME");
    const sessionsRoot = requireAbsoluteExistingDirectory(
      join(codexHome, "sessions"),
      `sessions directory for '${account.id}'`
    );
    return { id: account.id, codexHome, sessionsRoot };
  });
}

function listRolloutFiles(sessionsRoot) {
  const files = [];
  const stack = [sessionsRoot];
  while (stack.length > 0) {
    const directory = stack.pop();
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to scan symbolic link under sessions: ${path}`);
      }
      if (stats.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!stats.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      files.push({
        path,
        relativePath: relative(sessionsRoot, path),
        name: entry.name,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        dev: stats.dev,
        ino: stats.ino
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function requireAbsoluteExistingFile(value, label) {
  const path = requireAbsolutePath(value, label);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
  return realpathSync(path);
}

function requireAbsoluteExistingDirectory(value, label) {
  const path = requireAbsolutePath(value, label);
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return realpathSync(path);
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !value || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return resolve(value);
}

function normalizeArchiveRoot(value) {
  const requested = requireAbsolutePath(value, "archive root");
  if (existsSync(requested)) {
    return requireAbsoluteExistingDirectory(requested, "archive root");
  }
  const parent = requireAbsoluteExistingDirectory(dirname(requested), "archive root parent");
  return join(parent, basename(requested));
}

function requireMinAgeHours(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("--min-age-hours must be a finite number greater than or equal to 1.");
  }
  return parsed;
}

function pathIsInside(candidate, parent) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function mkdirSecure(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestampForPath(value) {
  return value.replace(/[-:.]/g, "");
}

function parseCli(argv) {
  let fromEnv = false;
  const options = { accounts: [], apply: false, minAgeHours: DEFAULT_MIN_AGE_HOURS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--from-env") {
      fromEnv = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${arg}`);
    }
    if (arg === "--db") options.dbPath = value;
    else if (arg === "--archive-root") options.archiveRoot = value;
    else if (arg === "--manifest") options.manifestPath = value;
    else if (arg === "--min-age-hours") options.minAgeHours = Number(value);
    else if (arg === "--account") {
      const separator = value.indexOf("=");
      if (separator <= 0) {
        throw new Error("--account must use <id>=<CODEX_HOME> format.");
      }
      options.accounts.push({ id: value.slice(0, separator), codexHome: value.slice(separator + 1) });
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    index += 1;
  }
  if (fromEnv) {
    if (
      options.dbPath ||
      options.archiveRoot ||
      options.accounts.length > 0 ||
      options.manifestPath ||
      options.minAgeHours !== DEFAULT_MIN_AGE_HOURS
    ) {
      throw new Error("--from-env cannot be combined with explicit archive configuration.");
    }
    Object.assign(options, archiveOptionsFromEnvironment());
  }
  if (!options.dbPath || !options.archiveRoot) {
    throw new Error(
      "Usage: node scripts/archive-unreferenced-codex-rollouts.mjs (--from-env | --db <gateway.db> --account <id>=<CODEX_HOME> [--account ...] --archive-root <path> [--min-age-hours 24] [--manifest <path>]) [--apply]"
    );
  }
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const plan = createArchivePlan(options);
  const result = options.apply
    ? applyArchivePlan(plan, { manifestPath: options.manifestPath })
    : undefined;
  process.stdout.write(
    `${JSON.stringify(summarizeArchivePlan(plan, options.apply ? "apply" : "dry-run", result), null, 2)}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`error=${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
