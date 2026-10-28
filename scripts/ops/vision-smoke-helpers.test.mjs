import { test } from "node:test";
import assert from "node:assert/strict";
import { isolatedProviderEnv, smokePayload, smokeText } from "./vision-smoke-helpers.mjs";

test("isolates production paths while retaining indirect provider keys and key files", () => {
  const source = { PATH: "bin", GATEWAY_SQLITE_PATH: "/production/db", GATEWAY_IMAGING_ENABLED: "1",
    MEDCODE_VISION_XAI_API_KEY_ENV: " XAI_KEY ", XAI_KEY: "fixture-secret", XAI_KEY_FILE: "/protected/xai",
    MEDCODE_TENCENT_API_KEY_ENV: "GATEWAY_SQLITE_PATH" };
  const env = isolatedProviderEnv(source);
  assert.equal(env[env.MEDCODE_VISION_XAI_API_KEY_ENV], "fixture-secret");
  assert.equal(env[env.MEDCODE_VISION_XAI_API_KEY_ENV + "_FILE"], "/protected/xai");
  assert.equal(env.GATEWAY_SQLITE_PATH, undefined);
  assert.equal(env.GATEWAY_IMAGING_ENABLED, undefined);
  assert.equal(source.XAI_KEY, "fixture-secret");
});
test("Responses text probe omits images and extracts nonstream and stream output", () => {
  const payload = smokePayload({ model: "goldencode-d", api: "responses", vision: false, stream: false, effort: "max" }, "image");
  assert.deepEqual(payload.input[0].content.map(item => item.type), ["input_text"]);
  const response = { output: [{ content: [{ type: "output_text", text: "TEXT_OK" }] }] };
  assert.equal(smokeText("responses", false, [response]), "TEXT_OK");
  assert.equal(smokeText("responses", true, [{ type: "response.completed", response }]), "TEXT_OK");
  assert.equal(smokeText("chat/completions", true, [{ choices: [{ delta: { content: "TEXT_OK" } }] }]), "TEXT_OK");
});
