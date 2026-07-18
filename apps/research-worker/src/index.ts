import { pathToFileURL } from "node:url";
import { loadResearchWorkerConfig } from "./config.js";
import { runResearchWorker, type ResearchWorkerLogger } from "./runtime.js";

export * from "./config.js";
export * from "./runtime.js";

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
    const config = loadResearchWorkerConfig(process.env);
    if (!config) {
      logger.info("research_worker_disabled");
      return;
    }
    const controller = new AbortController();
    const stop = () => controller.abort(new Error("Worker draining."));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await runResearchWorker({
      config,
      signal: controller.signal,
      logger
    });
  } catch (error) {
    logger.error("research_worker_startup_failed", {
      error_type: error instanceof Error ? error.name : "unknown",
      message:
        error instanceof Error
          ? sanitizeStartupError(error.message)
          : "Research Worker failed."
    });
    process.exitCode = 1;
  }
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
