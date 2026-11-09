import { createHash, createHmac } from "node:crypto";
import { resolveProviderApiKey } from "../services/provider-secret.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function tencentHeaders(secretId: string, secretKey: string, action: string, body: string, timestamp: number) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/asr/tc3_request`;
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:asr.tencentcloudapi.com\n\ncontent-type;host\n${hash(body)}`;
  const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
  const key = hmac(hmac(hmac("TC3" + secretKey, date), "asr"), "tc3_request");
  const signature = hmac(key, `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).toString("hex");
  return {
    "content-type": "application/json; charset=utf-8",
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
    "x-tc-action": action, "x-tc-version": "2019-06-14", "x-tc-timestamp": String(timestamp),
  };
}

export async function boundedJson(response: Response, maximum = 4_000_000): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("subtitle_empty_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > maximum) { await reader.cancel(); throw new Error("subtitle_response_limit"); }
    chunks.push(item.value);
  }
  if (!response.ok) throw new Error("subtitle_upstream_failed");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createSubtitleProvider(env: NodeJS.ProcessEnv, request = fetch) {
  const id = resolveProviderApiKey(env, "CODEX_SUBTITLE_TENCENT_SECRET_ID").apiKey;
  const key = resolveProviderApiKey(env, "CODEX_SUBTITLE_TENCENT_SECRET_KEY").apiKey;
  const base = env.CODEX_SUBTITLE_CLEAN_BASE_URL;
  const model = env.CODEX_SUBTITLE_CLEAN_MODEL;
  if (!id || !key || !base || !model) return;
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid subtitle model endpoint");
  const modelKey = resolveProviderApiKey(env, "CODEX_SUBTITLE_CLEAN_API_KEY").apiKey;
  return {
    async tencent(action: "CreateRecTask" | "DescribeTaskStatus", payload: Record<string, unknown>) {
      const body = JSON.stringify(payload);
      const response = await boundedJson(await request("https://asr.tencentcloudapi.com/", {
        method: "POST", redirect: "error", headers: tencentHeaders(id, key, action, body, Math.floor(Date.now() / 1000)),
        body, signal: AbortSignal.timeout(120_000),
      })) as { Response?: { Error?: unknown; Data?: Record<string, unknown> } };
      if (!response.Response?.Data || response.Response.Error) throw new Error("subtitle_asr_failed");
      return response.Response.Data;
    },
    async clean(rules: string, input: unknown) {
      const result = await boundedJson(await request(base.replace(/\/$/, "") + "/chat/completions", {
        method: "POST", redirect: "error", headers: { "content-type": "application/json", ...(modelKey ? { authorization: "Bearer " + modelKey } : {}) },
        body: JSON.stringify({ model, stream: false, temperature: 0, max_tokens: 6000, response_format: { type: "json_object" }, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "system", content: rules }, { role: "user", content: JSON.stringify(input) }] }),
        signal: AbortSignal.timeout(150_000),
      }), 1_000_000) as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] };
      const choice = result.choices?.[0];
      if (typeof choice?.message?.content !== "string" || choice.finish_reason === "length") throw new Error("subtitle_clean_incomplete");
      return JSON.parse(choice.message.content);
    },
  };
}
