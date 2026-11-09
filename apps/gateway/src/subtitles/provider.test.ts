import { expect, it } from "vitest";
import { boundedJson, createSubtitleProvider } from "./provider.js";

it("bounds streamed provider output and rejects HTTP errors", async () => {
  await expect(boundedJson(new Response('{"ok":true}'))).resolves.toEqual({ ok: true });
  await expect(boundedJson(new Response("x".repeat(50)), 20)).rejects.toThrow("subtitle_response_limit");
  await expect(boundedJson(new Response("private upstream error", { status: 500 }))).rejects.toThrow("subtitle_upstream_failed");
});

it("keeps the ASR endpoint and signing server-owned", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const provider = createSubtitleProvider({
    CODEX_SUBTITLE_TENCENT_SECRET_ID: "test-id",
    CODEX_SUBTITLE_TENCENT_SECRET_KEY: "test-key",
  }, async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ Response: { Data: { TaskId: 123 } } });
  })!;
  expect(await provider.tencent("CreateRecTask", { Data: "audio" })).toEqual({ TaskId: 123 });
  expect(calls[0].url).toBe("https://asr.tencentcloudapi.com/");
  expect(new Headers(calls[0].init?.headers).get("authorization")).toMatch(/^TC3-HMAC-SHA256 Credential=test-id\//);
  expect(calls).toHaveLength(1);
  expect(createSubtitleProvider({})).toBeUndefined();
});
