import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  loadQuickGateTaskSet,
  validateQuickGateTaskSet
} from "./lib/glm53-quick-gate-tasks.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(
  repoRoot,
  "tests/fixtures/provider-eval/tiankuan-glm53-quick-gate-v1"
);
const taskSet = await loadQuickGateTaskSet(
  resolve(fixtureRoot, "manifest.json"),
  resolve(fixtureRoot, "tasks.jsonl")
);
const result = validateQuickGateTaskSet(taskSet);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
if (!result.ok) {
  for (const error of result.errors) {
    process.stderr.write(`ERROR ${error}\n`);
  }
  process.exitCode = 1;
}
