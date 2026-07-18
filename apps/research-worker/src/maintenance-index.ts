import { pathToFileURL } from "node:url";
import { loadResearchWorkerConfig } from "./config.js";
import {
  runResearchMaintenance,
  type ResearchWorkerLogger
} from "./runtime.js";

if (isMainModule()) {
  void main();
}

async function main(): Promise<void> {
  const logger: ResearchWorkerLogger = {
    info(event, fields = {}) {
      process.stdout.write(
        `${JSON.stringify({ level: "info", event, ...fields })}\n`
      );
    },
    error(event, fields = {}) {
      process.stderr.write(
        `${JSON.stringify({ level: "error", event, ...fields })}\n`
      );
    }
  };
  try {
    if (!enabled(process.env.RESEARCH_MAINTENANCE_ENABLED)) {
      logger.info("research_maintenance_disabled");
      return;
    }
    const config = loadResearchWorkerConfig({
      ...process.env,
      RESEARCH_WORKER_ENABLED: "true"
    });
    if (!config) {
      throw new Error("Research maintenance configuration was not loaded.");
    }
    if (config.embeddedMaintenanceEnabled) {
      throw new Error(
        "Independent Research maintenance requires embedded maintenance to remain disabled."
      );
    }
    const controller = new AbortController();
    const stop = () =>
      controller.abort(new Error("Research maintenance draining."));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await runResearchMaintenance({
      config,
      signal: controller.signal,
      logger
    });
  } catch (error) {
    logger.error("research_maintenance_startup_failed", {
      error_type: error instanceof Error ? error.name : "unknown",
      message:
        error instanceof Error
          ? sanitizeStartupError(error.message)
          : "Research maintenance failed."
    });
    process.exitCode = 1;
  }
}

function enabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error(
    "RESEARCH_MAINTENANCE_ENABLED must be true/false or 1/0."
  );
}

function isMainModule(): boolean {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(process.argv[1]).href
    : false;
}

function sanitizeStartupError(value: string): string {
  return value
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|client[_-]?secret|authorization)\s*[=:]\s*)[^\s&]+/giu,
      "$1[redacted]"
    )
    .replace(/[A-Za-z]:\\[^\s]+/gu, "[local-path]")
    .replace(/\/(?:run|var|home|opt)\/[^\s]+/gu, "[runtime-path]")
    .slice(0, 500);
}
