import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync
} from "node:fs";
import path from "node:path";

export interface ResolvedProviderSecret {
  apiKey: string | null;
  sourceEnvName: string;
}

export function resolveProviderApiKey(
  env: NodeJS.ProcessEnv,
  apiKeyEnvName: string
): ResolvedProviderSecret {
  const fileEnvName = `${apiKeyEnvName}_FILE`;
  const directValue = env[apiKeyEnvName]?.trim() || null;
  const filename = env[fileEnvName]?.trim() || null;
  if (directValue && filename) {
    throw new Error(
      `${apiKeyEnvName} and ${fileEnvName} must not both be configured.`
    );
  }
  if (directValue) {
    return { apiKey: directValue, sourceEnvName: apiKeyEnvName };
  }
  if (!filename) {
    return { apiKey: null, sourceEnvName: apiKeyEnvName };
  }

  return {
    apiKey: readProviderSecretFile(filename, fileEnvName),
    sourceEnvName: fileEnvName
  };
}

function readProviderSecretFile(filename: string, sourceEnvName: string): string {
  const resolved = path.resolve(filename);
  const canonical = realpathSync(resolved);
  if (canonical !== resolved && process.platform !== "win32") {
    throw new Error(`${sourceEnvName} must reference a canonical secret file.`);
  }
  const flags =
    constants.O_RDONLY |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const descriptor = openSync(resolved, flags);
  try {
    const fileStat = fstatSync(descriptor);
    if (!fileStat.isFile() || fileStat.size > 16_384) {
      throw new Error(`${sourceEnvName} secret file is invalid.`);
    }
    if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
      throw new Error(`${sourceEnvName} secret file permissions are too broad.`);
    }
    if (
      process.platform === "linux" &&
      realpathSync(`/proc/self/fd/${descriptor}`) !== resolved
    ) {
      throw new Error(`${sourceEnvName} secret file handle is not canonical.`);
    }
    const value = readFileSync(descriptor, "utf8").trim();
    if (
      value.length < 8 ||
      value.length > 8_192 ||
      /[\r\n\u0000]/u.test(value)
    ) {
      throw new Error(`${sourceEnvName} secret file is empty or invalid.`);
    }
    return value;
  } finally {
    closeSync(descriptor);
  }
}
