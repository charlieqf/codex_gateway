import { readFileSync, statSync } from "node:fs";
import { isIPv4 } from "node:net";

export function resolveDocumentWorker(env: NodeJS.ProcessEnv, logger: { warn(message: string): void }) {
  if (!env.CODEX_DOCUMENT_EVIDENCE_URL) return null;
  try {
    const url = new URL(env.CODEX_DOCUMENT_EVIDENCE_URL);
    const [a, b] = url.hostname.split(".").map(Number);
    const privateHost = isIPv4(url.hostname) && (a === 127 || a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168));
    if (!privateHost || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new Error("invalid configuration");
    const file = env.CODEX_DOCUMENT_EVIDENCE_TOKEN_FILE;
    if (file) {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > 4096 || (process.platform !== "win32" && (stat.mode & 0o007) !== 0)) throw new Error("invalid token file");
    }
    const token = (file ? readFileSync(file, "utf8") : env.CODEX_DOCUMENT_EVIDENCE_TOKEN)?.trim();
    if (!token || !/^[\x21-\x7e]{32,4096}$/.test(token)) throw new Error("invalid token");
    const timeoutMs = Number(env.CODEX_DOCUMENT_EVIDENCE_TIMEOUT_MS ?? 85000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 85000) throw new Error("invalid timeout");
    // Configuring a private worker enables all current and future authenticated subjects.
    return { base: url.origin, token, timeoutMs };
  } catch {
    logger.warn("Document worker unavailable; check private URL and protected token configuration.");
    return null;
  }
}
