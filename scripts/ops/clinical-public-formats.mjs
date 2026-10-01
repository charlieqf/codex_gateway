// Public PanEcho format acceptance. Existing pilot Keys stay in memory only.
// Samples are a public video and synthetic DICOM made from its identical pixels.
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { decryptSecret } from "/app/packages/core/dist/index.js";
import { resolveProviderApiKey } from "/app/apps/gateway/dist/services/provider-secret.js";

const directory = "/var/lib/codex-gateway/clinical/format-smoke";
const statePath = `${directory}/state.json`, reportPath = `${directory}/report.json`;
const origin = "https://goldencode.instmarket.com.au:1443/gateway/panecho/v1";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const phase = process.argv[2] ?? "run";
const report = { at: new Date().toISOString(), phase, checks: [], formats: [], cleanup: [] };
const db = new DatabaseSync(process.env.GATEWAY_SQLITE_PATH, { readOnly: true }); db.exec("PRAGMA query_only=ON");
const secret = resolveProviderApiKey(process.env, "GATEWAY_UNIFIED_KEY_RECOVERY_KEY").apiKey;
assert.ok(secret);
const subjects = process.env.GATEWAY_PANECHO_SUBJECT_IDS.split(","); assert.ok(subjects.length >= 2);
const tokens = subjects.slice(0, 2).map(subject => {
  const row = db.prepare("SELECT token_ciphertext FROM unified_client_keys WHERE subject_id=? AND is_current=1 AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1").get(subject, new Date().toISOString());
  assert.ok(row?.token_ciphertext); return decryptSecret(row.token_ciphertext, secret);
}); db.close();
let state;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
async function call(path, { method = "GET", body, key, account = 0, expected = 200, headers = {}, raw = false } = {}) {
  const response = await fetch(origin + path, { method, headers: {
    authorization: `Bearer ${tokens[account]}`, "x-medevidence-client-version": "2.0.0-beta.88",
    ...(body === undefined ? {} : { "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json" }),
    ...(key ? { "idempotency-key": key } : {}), ...headers
  }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const check = { path, method, status: response.status, request_id: response.headers.get("x-request-id") };
  report.checks.push(check); save(); assert.equal(response.status, expected, `${method} ${path}`);
  if (raw) return { bytes: Buffer.from(await response.arrayBuffer()), headers: response.headers };
  const value = await response.json(); if (value.error) check.error_code = value.error.code; return value;
}
async function erase(id) {
  await call(`/jobs/${id}`, { method: "DELETE", expected: 202 });
  await call(`/jobs/${id}`, { expected: 404 });
  await call(`/jobs/${id}/artifacts/result.json`, { expected: 404 });
  report.cleanup.push({ job_id: id, access_revoked: true }); save();
}
try {
  if (phase === "cleanup") {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } else {
    assert.equal(phase, "run"); assert.equal(existsSync(statePath), false, "Previous format smoke requires cleanup first");
    state = { run: randomUUID(), resources: [] }; writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    const fixtures = [
      ["video", "video", "public-echo.avi", "ecb2a3c462193e0098550973767c8be45810e0ac5a1cb4063b8f4b72505130a5", "completed"],
      ["video_zip", "video_zip", "video_zip.zip", "09b55f2a2832dcb1cd88a6ad76d869c793b060fa1d6fd146d0f1141f6108d7c6", "completed"],
      ["dicom_zip", "dicom_zip", "dicom_zip.zip", "e329671570baf3511b14d7adb53f9d9ee82abc208f883ef1ff7bf6489eb927f3", "completed"],
      ["mixed_study", "dicom_zip", "mixed_study.zip", "9402f1baeae2d0aeea12b85dd1d5d91d476b6b4864454c43e34080e03757f9f7", "failed"],
      ["static_dicom", "dicom_zip", "static_dicom.zip", "7383a6baaa67d631fccecb441ec5c0daa61a39d11ef7c4806b1a85c1d207885c", "failed"]
    ];
    const predictions = new Map();
    for (const [name, format, file, digest, expected] of fixtures) {
      const bytes = readFileSync(`${directory}/${file}`); assert.equal(hash(bytes), digest);
      const body = { session_id: "clinical-public-format-smoke", analysis_profile: "panecho-tte-research-v1", data_policy: "public_or_deidentified",
        input: { format, size: bytes.length, sha256: digest, acquisition: "2d_tte", roi: [0.24, 0.21, 0.78, 0.8] } };
      const key = `${state.run}:${name}`, created = await call("/jobs", { method: "POST", body, key, expected: 201 });
      const id = created.job_id; state.resources.push({ name, id }); writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
      assert.equal((await call("/jobs", { method: "POST", body, key })).job_id, id);
      await call(`/jobs/${id}/input`, { account: 1, expected: 404 });
      for (let index = 0, offset = 0; offset < bytes.length; index++, offset += created.chunk_bytes) {
        const chunk = bytes.subarray(offset, offset + created.chunk_bytes), chunkHash = hash(chunk);
        const options = { method: "PUT", body: chunk, headers: { "content-length": String(chunk.length), "x-chunk-sha256": chunkHash } };
        const part = await call(`/jobs/${id}/input/parts/${index}`, options);
        assert.equal(part.size, chunk.length); assert.equal(part.sha256, chunkHash);
        if (index === 0) await call(`/jobs/${id}/input/parts/${index}`, options);
      }
      const parts = await call(`/jobs/${id}/input`); assert.equal(parts.parts.length, Math.ceil(bytes.length / created.chunk_bytes));
      await call(`/jobs/${id}/input/complete`, { method: "POST", body: {}, expected: 202 });
      await call(`/jobs/${id}/input/complete`, { method: "POST", body: {}, expected: 202 });
      let job; const deadline = Date.now() + 240000;
      do { job = await call(`/jobs/${id}`); if (["completed", "failed", "cancelled", "expired"].includes(job.state)) break; await sleep(1000); } while (Date.now() < deadline);
      assert.equal(job.state, expected, `Terminal state for ${name}`);
      const evidence = { name, format, size: bytes.length, sha256: digest, job_id: id, state: job.state, parts: parts.parts.length, downloads: [] };
      if (expected === "completed") {
        const result = await call(`/jobs/${id}/result`); assert.equal(result.tasks.length, 40); predictions.set(name, result.tasks);
        evidence.tasks = result.tasks.length; evidence.videos = result.videos.length;
        for (const suffix of ["", "/result", "/artifacts/result.json"]) await call(`/jobs/${id}${suffix}`, { account: 1, expected: 404 });
        assert.deepEqual(job.artifacts.map(a => a.name).sort(), ["preview.png", "report.csv", "result.json"]);
        for (const item of job.artifacts) {
          const value = await call(`/jobs/${id}/artifacts/${item.name}`, { raw: true });
          assert.equal(Number(value.headers.get("content-length")), item.size); assert.equal(value.bytes.length, item.size);
          assert.equal(value.headers.get("x-content-sha256"), item.sha256); assert.equal(hash(value.bytes), item.sha256);
          evidence.downloads.push({ name: item.name, size: item.size, sha256: item.sha256 });
        }
      } else {
        assert.equal(job.error?.retryable, false); evidence.error_code = job.error.code;
        await call(`/jobs/${id}/result`, { expected: 409 }); await call(`/jobs/${id}/artifacts/result.json`, { expected: 409 });
        assert.equal((await call("/jobs", { method: "POST", body, key })).state, "failed");
      }
      report.formats.push(evidence); save(); await erase(id);
      console.log(JSON.stringify({ format: name, state: job.state, tasks: evidence.tasks, parts: evidence.parts }));
    }
    assert.deepEqual(predictions.get("video_zip"), predictions.get("video")); assert.deepEqual(predictions.get("dicom_zip"), predictions.get("video"));
    report.equivalent_pixel_predictions_identical = true;
  }
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = error.code ?? error.name; process.exitCode = 1;
} finally {
  const already = new Set(report.cleanup.map(value => value.job_id));
  let cleaned = true;
  for (const resource of state?.resources ?? []) if (!already.has(resource.id)) {
    try { await erase(resource.id); } catch { cleaned = false; }
  }
  report.cleanup_complete = cleaned;
  if (state && cleaned) unlinkSync(statePath);
  if (!cleaned) process.exitCode = 1;
  report.finished_at = new Date().toISOString(); save();
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, cleanup_complete: cleaned, report_path: reportPath, failure: report.failure }));
}
