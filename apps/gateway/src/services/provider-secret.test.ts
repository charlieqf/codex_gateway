import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProviderApiKey } from "./provider-secret.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("provider secret resolution", () => {
  it("preserves direct environment credentials for compatibility", () => {
    expect(
      resolveProviderApiKey(
        { MEDCODE_QIANFAN_API_KEY: "provider-test-key" },
        "MEDCODE_QIANFAN_API_KEY"
      )
    ).toEqual({
      apiKey: "provider-test-key",
      sourceEnvName: "MEDCODE_QIANFAN_API_KEY"
    });
  });

  it("reads a permission-restricted file without copying the secret into env", () => {
    const filename = createSecretFile("provider-file-test-key");
    expect(
      resolveProviderApiKey(
        { MEDCODE_QIANFAN_API_KEY_FILE: filename },
        "MEDCODE_QIANFAN_API_KEY"
      )
    ).toEqual({
      apiKey: "provider-file-test-key",
      sourceEnvName: "MEDCODE_QIANFAN_API_KEY_FILE"
    });
  });

  it("fails closed for ambiguous, broad or non-canonical secret files", () => {
    const filename = createSecretFile("provider-file-test-key");
    expect(() =>
      resolveProviderApiKey(
        {
          MEDCODE_QIANFAN_API_KEY: "provider-env-test-key",
          MEDCODE_QIANFAN_API_KEY_FILE: filename
        },
        "MEDCODE_QIANFAN_API_KEY"
      )
    ).toThrow("must not both be configured");

    if (process.platform !== "win32") {
      chmodSync(filename, 0o644);
      expect(() =>
        resolveProviderApiKey(
          { MEDCODE_QIANFAN_API_KEY_FILE: filename },
          "MEDCODE_QIANFAN_API_KEY"
        )
      ).toThrow("permissions are too broad");

      chmodSync(filename, 0o600);
      const link = path.join(path.dirname(filename), "provider-link");
      symlinkSync(filename, link);
      expect(() =>
        resolveProviderApiKey(
          { MEDCODE_QIANFAN_API_KEY_FILE: link },
          "MEDCODE_QIANFAN_API_KEY"
        )
      ).toThrow("canonical secret file");
    }
  });
});

function createSecretFile(value: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "gateway-provider-secret-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "provider-key");
  writeFileSync(filename, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(filename, 0o600);
  return filename;
}
