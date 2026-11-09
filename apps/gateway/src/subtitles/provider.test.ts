import { expect, it } from "vitest";
import { boundedJson, createSubtitleProvider } from "./provider.js";

it("bounds streamed provider output and rejects HTTP errors", async () => {
  await expect(boundedJson(new Response('{"ok":true}'))).resolves.toEqual({ ok: true });
  await expect(boundedJson(new Response("x".repeat(50)), 20)).rejects.toThrow("subtitle_response_limit");
  await expect(boundedJson(new Response("private upstream error", { status: 500 }))).rejects.toThrow("subtitle_upstream_failed");
});

it("uses fixed Tencent and cleanup endpoints with bounded JSON rather than a client-selected prompt", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const provider = createSubtitleProvider({
    CODEX_SUBTITLE_TENCENT_SECRET_ID: "test-id",
    CODEX_SUBTITLE_TENCENT_SECRET_KEY: "test-key",
    CODEX_SUBTITLE_CLEAN_BASE_URL: "http://127.0.0.1:1234/v1",
    CODEX_SUBTITLE_CLEAN_MODEL: "test-model",
  }, async (input, init) => {
    calls.push({ url: String(input), init });
    return String(input).includes("tencent")
      ? Response.json({ Response: { Data: { TaskId: 123 } } })
      : Response.json({ choices: [{ message: { content: '{"cues":[]}' }, finish_reason: "stop" }] });
  })!;
  expect(await provider.tencent("CreateRecTask", { Data: "audio" })).toEqual({ TaskId: 123 });
  expect(calls[0].url).toBe("https://asr.tencentcloudapi.com/");
  expect(new Headers(calls[0].init?.headers).get("authorization")).toMatch(/^TC3-HMAC-SHA256 Credential=test-id\//);
  expect(await provider.clean("fixed rules", { core: [] })).toEqual({ cues: [] });
  expect(calls[1].url).toBe("http://127.0.0.1:1234/v1/chat/completions");
  const body = JSON.parse(String(calls[1].init?.body));
  expect(body.messages).toEqual([{ role: "system", content: "fixed rules" }, { role: "user", content: '{"core":[]}' }]);
  expect(body.model).toBe("test-model");
  expect(createSubtitleProvider({})).toBeUndefined();
});
