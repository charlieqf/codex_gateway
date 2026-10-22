import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveDocumentWorker } from "./runtime.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const env = { CODEX_DOCUMENT_EVIDENCE_URL: "http://172.18.0.1:8101", CODEX_DOCUMENT_EVIDENCE_TOKEN: "a".repeat(64) };
it("loads a protected file preferentially and never falls back from a broken configured file", () => {
  const directory = mkdtempSync(join(tmpdir(), "document-config-")); directories.push(directory);
  const file = join(directory, "token"); writeFileSync(file, "b".repeat(64) + "\n", { mode: 0o440 });
  const logger = { warn: vi.fn() };
  expect(resolveDocumentWorker({ ...env, CODEX_DOCUMENT_EVIDENCE_TOKEN_FILE: file }, logger)?.token).toBe("b".repeat(64));
  expect(resolveDocumentWorker({ ...env, CODEX_DOCUMENT_EVIDENCE_TOKEN_FILE: join(directory, "missing") }, logger)).toBeNull();
  if (process.platform !== "win32") {
    chmodSync(file, 0o444);
    expect(resolveDocumentWorker({ ...env, CODEX_DOCUMENT_EVIDENCE_TOKEN_FILE: file }, logger)).toBeNull();
  }
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(directory);
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(env.CODEX_DOCUMENT_EVIDENCE_TOKEN);
});
it("fails closed for public, ambiguous or malformed endpoints without affecting other Gateway services", () => {
  for (const url of ["https://example.com", "http://8.8.8.8", "http://0.0.0.0:8101", "http://172.18.0.1:8101/path", "http://user:secret@172.18.0.1", "http://172.18.0.1/?token=secret", "bad-url"]) {
    expect(resolveDocumentWorker({ ...env, CODEX_DOCUMENT_EVIDENCE_URL: url }, { warn() {} })).toBeNull();
  }
  expect(resolveDocumentWorker({}, { warn() {} })).toBeNull();
  expect(resolveDocumentWorker(env, { warn() {} })).toMatchObject({ base: "http://172.18.0.1:8101", timeoutMs: 85000 });
});
