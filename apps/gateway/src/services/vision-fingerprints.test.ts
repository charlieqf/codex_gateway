import { describe, expect, it } from "vitest";
import { VisionFingerprinter, resolveVisionFingerprinter } from "./vision-fingerprints.js";
import type { VisionObservation } from "./vision-observation.js";

const base = "https://assets.example/bucket/";
const path = base + "vision-temp/2026/11/05/" + "a".repeat(32) + ".png";
const inline = "data:image/png;base64,aGVsbG8=";
const fp = () => new VisionFingerprinter("secret".repeat(8), "configured", base);
function observation(urls: string[]): VisionObservation {
  return { scanning: true, scanned: true, lastUserContainer: 1,
    entries: urls.map((url, container) => ({ url, container, detail: "high" })) };
}
const context = { subjectId: "private-user", sessionId: "private-session", requestId: "request" };
describe("private vision fingerprints", () => {
  it("is stable across requests/restarts and isolates users, sessions and key rotation", () => {
    const original = fp().snapshot(observation([inline]), context);
    expect(fp().snapshot(observation([inline]), { ...context, requestId: "next" })).toEqual(original);
    for (const changed of [{ subjectId: "other" }, { sessionId: "other" }]) {
      expect(fp().snapshot(observation([inline]), { ...context, ...changed }).entries[0]!.id).not.toBe(original.entries[0]!.id);
    }
    expect(new VisionFingerprinter("another", "configured").snapshot(observation([inline]), context).keyId).not.toBe(original.keyId);
    const serialized = JSON.stringify(original);
    for (const secret of [inline, "aGVsbG8", "hello", context.subjectId, context.sessionId, "secretsecret"]) expect(serialized).not.toContain(secret);
  });
  it("normalizes only renewable signatures of controlled immutable assets", () => {
    const results = fp().snapshot(observation([
      path + "?X-Amz-Signature=old&X-Amz-Date=old", path + "?X-Amz-Signature=new",
      path + "?versionId=other&X-Amz-Signature=new",
      "https://other.example/image?version=1", "https://other.example/image?version=2"
    ]), context).entries;
    expect(results[0]!.id).toBe(results[1]!.id);
    expect(results[0]!.source).toBe("asset-url");
    expect(results[2]!.id).not.toBe(results[0]!.id);
    expect(results[3]!.id).not.toBe(results[4]!.id);
    expect(results[3]!.source).toBe("exact-url");
    expect(JSON.stringify(results)).not.toContain("Signature");
  });
  it("identifies identical inline bytes independently of detail and reports positions", () => {
    const obs = observation([inline, inline]); obs.entries[1]!.detail = "low";
    const result = fp().snapshot(obs, context);
    expect(result.entries[0]!.id).toBe(result.entries[1]!.id);
    expect(result.entries.map(e => e.inLastUserMessage)).toEqual([false, true]);
    expect(result.entries.map(e => e.detail)).toEqual(["high", "low"]);
  });
  it("normalizes COS signatures alongside R2 without erasing content-selecting parameters", () => {
    const cosBase = "https://synthetic-1234567890.cos.ap-shanghai.myqcloud.com/";
    const cosPath = cosBase + "vision-temp/2026/11/12/" + "b".repeat(32) + ".png";
    const printer = new VisionFingerprinter("secret".repeat(8), "configured", [base, cosBase]);
    const result = printer.snapshot(observation([
      cosPath + "?q-sign-algorithm=sha1&q-ak=old&q-sign-time=1;2&q-key-time=1;2&q-header-list=host&q-url-param-list=&q-signature=old",
      cosPath + "?q-ak=new&q-signature=new&x-cos-security-token=temporary",
      cosPath + "?q-signature=new&versionId=other",
      "https://external.example/image?q-signature=one", "https://external.example/image?q-signature=two",
      path + "?X-Amz-Signature=one", path + "?X-Amz-Signature=two"
    ]), context).entries;
    expect(result[0]!.id).toBe(result[1]!.id);
    expect(result[0]!.source).toBe("asset-url");
    expect(result[0]!.id).not.toBe(result[2]!.id);
    expect(result[3]!.id).not.toBe(result[4]!.id);
    expect(result[5]!.id).toBe(result[6]!.id);
    expect(JSON.stringify(result)).not.toContain("q-signature");
  });
  it("falls back to request scope without fabricating cross-request correlation", () => {
    const a = fp().snapshot(observation([inline]), { ...context, sessionId: null });
    const b = fp().snapshot(observation([inline]), { ...context, sessionId: null, requestId: "other" });
    expect(a.scope).toBe("request"); expect(a.entries[0]!.id).not.toBe(b.entries[0]!.id);
  });
  it("bounds rejected payload telemetry and marks omissions", () => {
    expect(fp().snapshot(observation(Array(40).fill(inline)), context)).toMatchObject({ omittedEntries: 8, entries: { length: 32 } });
    expect(fp().snapshot(observation(["x".repeat(33 * 1024 * 1024), inline]), context)).toMatchObject({ omittedEntries: 1, entries: { length: 1 } });
  });
  it("labels ephemeral fallback and supports a dedicated stable key", () => {
    const a = resolveVisionFingerprinter({}).snapshot(observation([inline]), context);
    const b = resolveVisionFingerprinter({}).snapshot(observation([inline]), context);
    expect(a.keySource).toBe("process"); expect(a.keyId).not.toBe(b.keyId);
    expect(resolveVisionFingerprinter({ GATEWAY_VISION_OBSERVATION_HMAC_SECRET: "x".repeat(32) }).snapshot(observation([inline]), context).keySource).toBe("configured");
  });
});
