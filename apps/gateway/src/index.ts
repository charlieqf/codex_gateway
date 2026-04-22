import { pathToFileURL } from "node:url";
import Fastify from "fastify";

export function buildGateway() {
  const app = Fastify({ logger: true });

  app.get("/gateway/health", async () => ({
    state: "starting",
    service: "codex-gateway",
    phase: "mvp-scaffold"
  }));

  app.get("/gateway/status", async () => ({
    state: "not_configured",
    message: "Provider and credential stores are not wired yet."
  }));

  return app;
}

async function main() {
  const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.GATEWAY_PORT ?? "8787", 10);
  const app = buildGateway();
  await app.listen({ host, port });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

