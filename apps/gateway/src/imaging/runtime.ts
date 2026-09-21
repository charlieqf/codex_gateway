import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HttpsStarClient } from "./client.js";
import { requireImaging } from "./contract.js";
import { ImagingService } from "./service.js";
import { defaultImagingLimits, ImagingStore } from "./store.js";

export function resolveImagingService(env: NodeJS.ProcessEnv, logger: { warn: (message: string) => void }): ImagingService | null {
  if (!env.GATEWAY_IMAGING_MODE || env.GATEWAY_IMAGING_MODE === "off") return null;
  let store: ImagingStore | undefined;
  let star: HttpsStarClient | undefined;
  try {
    requireImaging(env.GATEWAY_IMAGING_MODE === "pilot", 503, "unavailable");
    const path = env.GATEWAY_IMAGING_SQLITE_PATH;
    requireImaging(path && path !== ":memory:" && ![env.GATEWAY_SQLITE_PATH, env.GATEWAY_CLIENT_EVENTS_SQLITE_PATH].filter(Boolean).some(p => resolve(p!) === resolve(path)), 503, "unavailable");
    requireImaging(env.GATEWAY_IMAGING_STAR_URL && env.GATEWAY_IMAGING_STAR_CA_FILE && env.GATEWAY_IMAGING_STAR_TOKEN_FILE, 503, "unavailable");
    const subjects = new Set((env.GATEWAY_IMAGING_SUBJECT_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean));
    requireImaging([...subjects].every(s => /^[A-Za-z0-9_-]{1,128}$/.test(s) && s !== "*"), 503, "unavailable");
    const positive = (name: string, fallback: number, maximum: number) => {
      const value = env[name] === undefined ? fallback : Number(env[name]);
      requireImaging(Number.isSafeInteger(value) && value > 0 && value <= maximum, 503, "unavailable");
      return value;
    };
    const limits = {
      dailyJobs: positive("GATEWAY_IMAGING_DAILY_JOBS", defaultImagingLimits.dailyJobs, 100),
      activeJobs: positive("GATEWAY_IMAGING_ACTIVE_JOBS", defaultImagingLimits.activeJobs, 4),
      dailyStudies: positive("GATEWAY_IMAGING_DAILY_STUDIES", defaultImagingLimits.dailyStudies, 100),
      activeStudies: positive("GATEWAY_IMAGING_ACTIVE_STUDIES", defaultImagingLimits.activeStudies, 8)
    };
    star = new HttpsStarClient({ baseUrl: env.GATEWAY_IMAGING_STAR_URL,
      token: readFileSync(env.GATEWAY_IMAGING_STAR_TOKEN_FILE, "utf8").trim(), ca: readFileSync(env.GATEWAY_IMAGING_STAR_CA_FILE),
      controlTimeoutMs: positive("GATEWAY_IMAGING_CONTROL_TIMEOUT_MS", 15000, 60000),
      transferTimeoutMs: positive("GATEWAY_IMAGING_TRANSFER_TIMEOUT_MS", 300000, 300000) });
    store = new ImagingStore(path);
    return new ImagingService(store, star, { subjects, limits,
      onRecoveryError: () => logger.warn("Imaging recovery is unavailable; durable records are retained.") });
  } catch {
    star?.close(); store?.close();
    logger.warn("Imaging pilot is unavailable: check its private configuration and independent database.");
    return null;
  }
}
