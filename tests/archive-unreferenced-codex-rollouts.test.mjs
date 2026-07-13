import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyArchivePlan,
  archiveOptionsFromEnvironment,
  createArchivePlan
} from "../scripts/archive-unreferenced-codex-rollouts.mjs";

const roots = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe("archive-unreferenced-codex-rollouts", () => {
  it("preserves referenced and fresh rollouts while planning old unreferenced files", () => {
    const fixture = createFixture();
    const referenced = writeRollout(
      fixture.home,
      `rollout-2026-07-01T00-00-00-${fixture.providerRef}.jsonl`,
      "referenced",
      48
    );
    const fresh = writeRollout(fixture.home, "rollout-fresh.jsonl", "fresh", 2);
    const candidate = writeRollout(fixture.home, "rollout-old.jsonl", "candidate", 48);

    const plan = createArchivePlan({
      dbPath: fixture.dbPath,
      accounts: [{ id: fixture.accountId, codexHome: fixture.home }],
      archiveRoot: fixture.archiveRoot,
      minAgeHours: 24,
      nowMs: fixture.nowMs
    });

    expect(plan.totals).toMatchObject({
      providerSessionRefs: 1,
      totalFiles: 3,
      referencedFiles: 1,
      freshFiles: 1,
      candidateFiles: 1
    });
    expect(plan.accounts[0].candidates[0].source).toBe(candidate);
    expect(existsSync(referenced)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  it("writes a manifest and atomically moves only planned rollouts", () => {
    const fixture = createFixture();
    const referenced = writeRollout(
      fixture.home,
      `rollout-${fixture.providerRef}.jsonl`,
      "referenced",
      72
    );
    const candidate = writeRollout(fixture.home, "rollout-old.jsonl", "candidate", 72);
    const plan = createArchivePlan({
      dbPath: fixture.dbPath,
      accounts: [{ id: fixture.accountId, codexHome: fixture.home }],
      archiveRoot: fixture.archiveRoot,
      minAgeHours: 24,
      nowMs: fixture.nowMs
    });

    const result = applyArchivePlan(plan);
    const destination = plan.accounts[0].candidates[0].destination;

    expect(result).toMatchObject({ movedFiles: 1, movedBytes: 9 });
    expect(existsSync(candidate)).toBe(false);
    expect(existsSync(destination)).toBe(true);
    expect(existsSync(referenced)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]).toMatchObject({
      accountId: fixture.accountId,
      source: candidate,
      destination
    });
  });

  it("fails closed when a referenced provider session file is missing", () => {
    const fixture = createFixture();
    writeRollout(fixture.home, "rollout-unrelated.jsonl", "old", 72);

    expect(() =>
      createArchivePlan({
        dbPath: fixture.dbPath,
        accounts: [{ id: fixture.accountId, codexHome: fixture.home }],
        archiveRoot: fixture.archiveRoot,
        minAgeHours: 24,
        nowMs: fixture.nowMs
      })
    ).toThrow("referenced provider session file(s) were not found");
  });

  it("rejects an archive root inside CODEX_HOME", () => {
    const fixture = createFixture({ withReference: false });

    expect(() =>
      createArchivePlan({
        dbPath: fixture.dbPath,
        accounts: [{ id: fixture.accountId, codexHome: fixture.home }],
        archiveRoot: join(fixture.home, "quarantine"),
        minAgeHours: 24,
        nowMs: fixture.nowMs
      })
    ).toThrow("Archive root must not overlap CODEX_HOME");
  });

  it("rejects an archive root that contains CODEX_HOME", () => {
    const fixture = createFixture({ withReference: false });

    expect(() =>
      createArchivePlan({
        dbPath: fixture.dbPath,
        accounts: [{ id: fixture.accountId, codexHome: fixture.home }],
        archiveRoot: fixture.root,
        minAgeHours: 24,
        nowMs: fixture.nowMs
      })
    ).toThrow("Archive root must not overlap CODEX_HOME");
  });

  it("loads startup account mappings from the upstream pool config", () => {
    const fixture = createFixture({ withReference: false });
    const configPath = join(fixture.root, "upstream-accounts.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        accounts: [
          {
            id: fixture.accountId,
            provider: "openai-codex",
            codexHome: fixture.home
          }
        ]
      })
    );

    expect(
      archiveOptionsFromEnvironment({
        GATEWAY_SQLITE_PATH: fixture.dbPath,
        GATEWAY_UPSTREAM_ACCOUNTS_JSON: configPath,
        CODEX_GATEWAY_ROLLOUT_ARCHIVE_ROOT: fixture.archiveRoot,
        CODEX_GATEWAY_ROLLOUT_ARCHIVE_MIN_AGE_HOURS: "48"
      })
    ).toEqual({
      dbPath: fixture.dbPath,
      archiveRoot: fixture.archiveRoot,
      accounts: [{ id: fixture.accountId, codexHome: fixture.home }],
      minAgeHours: 48
    });
  });

  it("uses the stable default account id for a single CODEX_HOME", () => {
    const fixture = createFixture({ withReference: false });

    expect(
      archiveOptionsFromEnvironment({
        GATEWAY_SQLITE_PATH: fixture.dbPath,
        CODEX_HOME: fixture.home,
        CODEX_GATEWAY_ROLLOUT_ARCHIVE_ROOT: fixture.archiveRoot
      }).accounts
    ).toEqual([{ id: "sub_openai_codex_dev", codexHome: fixture.home }]);
  });
});

function createFixture({ withReference = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "codex-rollout-archive-test-"));
  roots.push(root);
  const home = join(root, "codex-home");
  const sessions = join(home, "sessions", "2026", "07", "01");
  const archiveRoot = join(root, "archive");
  const dbPath = join(root, "gateway.db");
  const accountId = "codex-test-1";
  const providerRef = "019c0000-0000-7000-8000-000000000001";
  const nowMs = Date.parse("2026-07-13T12:00:00.000Z");
  mkdirSync(sessions, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE sessions (upstream_account_id TEXT, provider_session_ref TEXT)"
  );
  if (withReference) {
    db.prepare(
      "INSERT INTO sessions (upstream_account_id, provider_session_ref) VALUES (?, ?)"
    ).run(accountId, providerRef);
  }
  db.close();
  return { root, home, sessions, archiveRoot, dbPath, accountId, providerRef, nowMs };
}

function writeRollout(home, name, content, ageHours) {
  const path = join(home, "sessions", "2026", "07", "01", name);
  writeFileSync(path, content, "utf8");
  const timestamp = new Date(Date.parse("2026-07-13T12:00:00.000Z") - ageHours * 3600000);
  utimesSync(path, timestamp, timestamp);
  return path;
}
