// Pure helpers: no environment mutation, credentials printed, or Gateway startup.
export function isolatedProviderEnv(source) {
  const env = Object.fromEntries(Object.entries(source).filter(([name]) =>
    /^(PATH|HOME|NODE_EXTRA_CA_CERTS|HTTPS_PROXY|HTTP_PROXY|NO_PROXY|MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE)$/.test(name) ||
    /^MEDCODE_(VISION_XAI_|TENCENT_|TIANKUAN_)/.test(name)));
  let index = 0;
  for (const [name, value] of Object.entries(env)) {
    if (!name.endsWith("_API_KEY_ENV") || !value?.trim()) continue;
    const reference = value.trim(), isolated = `PREFLIGHT_PROVIDER_SECRET_${index++}`;
    env[name] = isolated;
    for (const suffix of ["", "_FILE"]) {
      if (source[reference + suffix] !== undefined) env[isolated + suffix] = source[reference + suffix];
    }
  }
  return env;
}

export function smokePayload({ model, api, vision, stream, effort }, image) {
  const prompt = vision ? "Read the four-digit number shown in this image. Answer with only those four digits."
    : "Reply with only TEXT_OK.";
  return api === "responses"
    ? { model, stream, reasoning: { effort }, max_output_tokens: 1024, input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: prompt }, ...(vision ? [{ type: "input_image", image_url: image }] : [])] }] }
    : { model, stream, reasoning_effort: effort, max_tokens: 1024, messages: [{ role: "user", content: vision
        ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image } }] : prompt }] };
}

export function smokeText(api, stream, frames) {
  if (api === "responses") {
    const response = stream ? frames.find(frame => frame.type === "response.completed")?.response : frames[0];
    return response?.output?.flatMap(item => item.content ?? []).map(item => item.text ?? "").join("") ?? "";
  }
  return stream ? frames.map(frame => frame.choices?.[0]?.delta?.content ?? "").join("")
    : frames[0].choices?.[0]?.message?.content ?? "";
}
