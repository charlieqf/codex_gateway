import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export function assertPathInsideRoot(
  root: string,
  candidate: string,
  errorMessage: string
): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error(errorMessage);
}

export async function assertRealPathInsideRoot(
  root: string,
  candidate: string,
  errorMessage: string,
  options: { allowMissingLeaf?: boolean } = {}
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  assertPathInsideRoot(resolvedRoot, resolvedCandidate, errorMessage);

  const rootStat = await lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(errorMessage);
  }
  const realRoot = await realpath(resolvedRoot);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  let current = resolvedRoot;
  const segments = relative === "" ? [] : relative.split(path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    try {
      const currentStat = await lstat(current);
      if (currentStat.isSymbolicLink()) {
        throw new Error(errorMessage);
      }
    } catch (error) {
      if (
        options.allowMissingLeaf === true &&
        index === segments.length - 1 &&
        errorCode(error) === "ENOENT"
      ) {
        assertPathInsideRoot(realRoot, path.dirname(current), errorMessage);
        return;
      }
      throw error;
    }
  }
  const realCandidate = await realpath(resolvedCandidate);
  assertPathInsideRoot(realRoot, realCandidate, errorMessage);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}
