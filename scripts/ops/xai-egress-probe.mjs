// Run as a separate Node process in the Gateway container. Emits only synthetic
// test outcomes and hashes; provider credentials and response bodies stay in memory.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const alias = process.env.XAI_PROBE_ALIAS ?? 'production';
const phase = process.env.XAI_PROBE_PHASE ?? 'baseline';
const count = Math.min(20, Math.max(0, Number(process.env.XAI_PROBE_COUNT ?? 6)));
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const emit = (x) => console.log(JSON.stringify({ alias, phase, utc: new Date().toISOString(), ...x }));
const cleanError = (e) => ({ error_name: e?.name ?? 'Error', transport_code: /^[A-Z0-9_]+$/.test(e?.cause?.code ?? e?.code ?? '') ? (e?.cause?.code ?? e?.code) : null });
const keyName = process.env.MEDCODE_VISION_XAI_API_KEY_ENV?.trim() || 'MEDCODE_VISION_XAI_API_KEY';
let apiKey = process.env[keyName]?.trim();
if (!apiKey && process.env[`${keyName}_FILE`]) apiKey = readFileSync(process.env[`${keyName}_FILE`], 'utf8').trim();
if (!apiKey && process.env.MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE) {
  for (const raw of readFileSync(process.env.MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('xai:')) { apiKey = line.slice(4).trim(); break; }
  }
}
if (!apiKey && count > 0) throw new Error('Missing provider credential');
const registry = JSON.parse(process.env.MEDCODE_PUBLIC_MODELS_JSON || '{}');
const model = registry.goldencode?.vision?.upstreamModel;
if (!model && count > 0) throw new Error('Missing configured vision model');
const endpoint = process.env.MEDCODE_VISION_XAI_BASE_URL?.trim() || 'https://api.x.ai/v1';
if (new URL(endpoint).hostname !== 'api.x.ai') throw new Error('Unexpected provider endpoint');

for (const method of ['HEAD', 'GET']) {
  const start = performance.now();
  try {
    const response = await fetch(`${endpoint}/models`, { method, signal: AbortSignal.timeout(10000) });
    await response.body?.cancel();
    emit({ kind: 'transport', method, status: response.status, duration_ms: Math.round(performance.now() - start) });
  } catch (e) { emit({ kind: 'transport', method, ...cleanError(e), duration_ms: Math.round(performance.now() - start) }); }
}
try {
  const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(10000) });
  const trace = Object.fromEntries((await response.text()).trim().split('\n').map((line) => line.split('=')));
  emit({ kind: 'exit_identity', scope: ['route', 'production'].includes(alias) ? 'non_xai_domain_route' : 'fixed_leaf_all_domains', status: response.status, exit_ip_hash: trace.ip ? hash(`xai-exit:${trace.ip}`) : null,
    country: /^[A-Z]{2}$/.test(trace.loc ?? '') ? trace.loc : null });
} catch (e) { emit({ kind: 'exit_identity', ...cleanError(e) }); }

// Geometry avoids dependence on fonts installed in the production container.
const chart = Buffer.from('<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="480" fill="white"/><rect x="170" y="90" width="300" height="300" fill="#ff0000"/></svg>');
const small = await sharp(chart).png().toBuffer();
const noise = Buffer.alloc(640 * 640 * 3);
let seed = 41;
for (let i = 0; i < noise.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; noise[i] = seed >>> 24; }
const large = await sharp(noise, { raw: { width: 640, height: 640, channels: 3 } }).composite([{ input: small, top: 80, left: 0 }]).png().toBuffer();

async function one(index) {
  const imageCount = index % 4 === 1 ? 8 : 1;
  const image = index % 4 === 2 ? large : small;
  const stream = index % 4 !== 3;
  const body = JSON.stringify({ model, store: false, stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    max_tokens: phase === 'reload-inflight' ? 512 : 160, reasoning_effort: 'medium',
    messages: [{ role: 'user', content: [{ type: 'text', text: phase === 'reload-inflight'
      ? 'Describe the colors and geometric layout of this synthetic image in 200 words.'
      : 'What color is the large square in the center of the image? Reply with the color name only.' },
      ...Array.from({ length: imageCount }, () => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } }))] }] });
  const start = performance.now();
  let stage = 'before_headers', firstByte = null, headersMs = null, status = null, bytes = 0, finishReason = null, done = false, content = '', usage = null;
  try {
    const response = await fetch(`${endpoint}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(90000) });
    status = response.status; headersMs = Math.round(performance.now() - start); stage = 'after_headers';
    if (!response.ok) { await response.body?.cancel(); }
    else if (!stream) {
      const value = await response.json();
      content = value.choices?.[0]?.message?.content ?? '';
      finishReason = value.choices?.[0]?.finish_reason ?? null; usage = value.usage ?? null; done = true;
    } else {
      stage = 'streaming'; const decoder = new TextDecoder(); let buffer = '';
      for await (const chunk of response.body) {
        if (firstByte === null) {
          firstByte = Math.round(performance.now() - start);
          if (phase === 'reload-inflight') emit({ kind: 'first_byte', index });
        }
        bytes += chunk.length; buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { done = true; continue; }
          if (!data) continue;
          const value = JSON.parse(data);
          content += value.choices?.[0]?.delta?.content ?? '';
          finishReason = value.choices?.[0]?.finish_reason ?? finishReason; usage = value.usage ?? usage;
        }
      }
    }
    emit({ kind: 'vision', index, model, stream, image_count: imageCount, request_bytes: Buffer.byteLength(body),
      status, headers_ms: headersMs, first_byte_ms: firstByte, duration_ms: Math.round(performance.now() - start),
      response_bytes: bytes, finish_reason: finishReason, complete: done && !!finishReason, answer_correct: phase === 'reload-inflight' ? /\bred\b/i.test(content) : /^\s*red[.。]?\s*$/i.test(content),
      fixture_sha256: hash(image), synthetic_answer: content.slice(0, 100),
      total_tokens: typeof usage?.total_tokens === 'number' ? usage.total_tokens : null });
  } catch (e) { emit({ kind: 'vision', index, model, stream, image_count: imageCount, request_bytes: Buffer.byteLength(body), status, stage,
    headers_ms: headersMs, first_byte_ms: firstByte, duration_ms: Math.round(performance.now() - start), ...cleanError(e) }); }
}
for (let i = 0; i < count; i++) await one(i);
