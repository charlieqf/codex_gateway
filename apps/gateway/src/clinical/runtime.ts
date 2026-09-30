import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { HttpsStarClient } from "../imaging/client.js";
import { requireClinical, type Mode } from "./contract.js";
import { ClinicalService } from "./service.js";
import { ClinicalStore } from "./store.js";

export function resolveClinicalService(mode: Mode, env: NodeJS.ProcessEnv, logger: { warn(message: string): void }): ClinicalService | null {
  const key = `GATEWAY_${mode.toUpperCase()}_`, value = (name: string) => env[key + name];
  if (!value("MODE") || value("MODE") === "off") return null;
  let store: ClinicalStore | undefined, star: HttpsStarClient | undefined;
  try {
    requireClinical(value("MODE") === "pilot", 503, "unavailable");
    const path = value("SQLITE_PATH"); requireClinical(path && path !== ":memory:", 503, "unavailable");
    const canonical = (p: string) => existsSync(p) ? realpathSync(p) : resolve(p);
    for (const other of [env.GATEWAY_SQLITE_PATH, env.GATEWAY_CLIENT_EVENTS_SQLITE_PATH, env.GATEWAY_IMAGING_SQLITE_PATH, env[`GATEWAY_${mode === "aipal" ? "PANECHO" : "AIPAL"}_SQLITE_PATH`]].filter((p): p is string => Boolean(p))) {
      requireClinical(canonical(other) !== canonical(path), 503, "unavailable");
      if (existsSync(other) && existsSync(path)) { const a = statSync(other), b = statSync(path); requireClinical(a.dev !== b.dev || a.ino !== b.ino, 503, "unavailable"); }
    }
    const subjects = new Set((value("SUBJECT_IDS") ?? "").split(",").map(s => s.trim()).filter(Boolean));
    requireClinical([...subjects].every(s => /^[A-Za-z0-9_-]{1,128}$/.test(s) && s !== "*"), 503, "unavailable");
    const positive = (name: string, fallback: number, max: number) => { const n = value(name) === undefined ? fallback : Number(value(name)); requireClinical(Number.isSafeInteger(n) && n > 0 && n <= max, 503, "unavailable"); return n; };
    requireClinical(value("STAR_URL") && value("STAR_CA_FILE") && value("STAR_TOKEN_FILE"), 503, "unavailable");
    const limits = { dailyJobs: positive("DAILY_JOBS", 10, 100), activeJobs: positive("ACTIVE_JOBS", 1, 4) };
    star = new HttpsStarClient({ clinical: mode, baseUrl: value("STAR_URL")!, token: readFileSync(value("STAR_TOKEN_FILE")!, "utf8").trim(), ca: readFileSync(value("STAR_CA_FILE")!),
      controlTimeoutMs: positive("CONTROL_TIMEOUT_MS", 15000, 60000), transferTimeoutMs: positive("TRANSFER_TIMEOUT_MS", 300000, 300000) });
    store = new ClinicalStore(path);
    return new ClinicalService(mode, store, star, { subjects, limits, onRecoveryError: () => logger.warn("Clinical recovery unavailable; durable records retained.") });
  } catch { star?.close(); store?.close(); logger.warn(`Clinical ${mode} pilot unavailable; check private configuration and independent database.`); return null; }
}
