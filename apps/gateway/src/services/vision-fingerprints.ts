import { createHash, createHmac, randomBytes } from "node:crypto";
import type { VisionObservationSnapshot } from "@codex-gateway/core";
import type { VisionObservation } from "./vision-observation.js";
import { readR2CredentialsFile } from "./vision-asset-service.js";

type Fingerprints = NonNullable<VisionObservationSnapshot["fingerprints"]>;
const domain = "codex-gateway/vision-observation/v1";
const maximumEntries = 32;
const maximumCharacters = 32 * 1024 * 1024;

/** No network fetches, image contents, object paths or signed URLs enter telemetry. */
export class VisionFingerprinter {
  private readonly key: Buffer;
  private readonly keyId: string;
  constructor(secret: string | Buffer, private readonly keySource: Fingerprints["keySource"],
    private readonly assetBase?: string) {
    // Separate this purpose from asset-token signing and provider credentials.
    this.key = createHmac("sha256", secret).update(domain).digest();
    this.keyId = createHash("sha256").update(this.key).digest("hex").slice(0, 16);
  }

  snapshot(observation: VisionObservation, context: {
    subjectId: string; sessionId?: string | null; requestId: string;
  }): Fingerprints {
    const scope = context.sessionId ? "session" : "request";
    const scopeId = createHmac("sha256", this.key)
      .update(JSON.stringify([scope, context.subjectId, context.sessionId || context.requestId])).digest("hex");
    const entries: Fingerprints["entries"] = [];
    let remaining = maximumCharacters;
    for (const entry of observation.entries.slice(0, maximumEntries)) {
      if (entry.url.length > remaining) continue;
      remaining -= entry.url.length;
      let source: Fingerprints["entries"][number]["source"] = "exact-url";
      let identity: string | Buffer = entry.url;
      const prefix = /^data:image\/(?:png|jpeg);base64,/u.exec(entry.url);
      if (prefix) {
        source = "content";
        identity = Buffer.from(entry.url.slice(prefix[0].length), "base64");
      } else if (this.assetBase && entry.url.startsWith(this.assetBase)) {
        try {
          const url = new URL(entry.url);
          const base = new URL(this.assetBase);
          const objectPath = url.pathname.slice(base.pathname.length);
          if (url.origin === base.origin && /^vision-temp\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{32}\.(?:png|jpg)$/u.test(objectPath)) {
            // Only the controlled immutable asset namespace has renewable signatures.
            // Other query values can select different content and must be retained.
            for (const name of [...url.searchParams.keys()]) {
              if (/^X-Amz-(?:Algorithm|Credential|Date|Expires|SignedHeaders|Signature|Security-Token)$/iu.test(name)) url.searchParams.delete(name);
            }
            source = "asset-url";
            identity = url.toString();
          }
        } catch { /* Malformed/unsupported URLs retain exact identity. */ }
      }
      const id = createHmac("sha256", this.key).update(scopeId).update("\0" + source + "\0").update(identity).digest("hex");
      entries.push({ id, source, container: entry.container,
        inLastUserMessage: observation.lastUserContainer === entry.container, detail: entry.detail ?? null });
    }
    return { version: 1, keyId: this.keyId, keySource: this.keySource, scope, scopeId,
      omittedEntries: observation.entries.length - entries.length, entries };
  }
}

export function resolveVisionFingerprinter(env: NodeJS.ProcessEnv): VisionFingerprinter {
  let secret: string | Buffer = randomBytes(32);
  let source: Fingerprints["keySource"] = "process";
  let assetBase: string | undefined;
  if (env.MEDCODE_VISION_R2_ENABLED === "1" && env.MEDCODE_VISION_R2_CREDENTIALS_FILE) {
    secret = readR2CredentialsFile(env.MEDCODE_VISION_R2_CREDENTIALS_FILE).secretAccessKey;
    source = "r2-derived";
    if (env.MEDCODE_VISION_R2_ENDPOINT && env.MEDCODE_VISION_R2_BUCKET) {
      assetBase = new URL("/" + encodeURIComponent(env.MEDCODE_VISION_R2_BUCKET) + "/", env.MEDCODE_VISION_R2_ENDPOINT).toString();
    }
  }
  if (env.GATEWAY_VISION_OBSERVATION_HMAC_SECRET) {
    if (env.GATEWAY_VISION_OBSERVATION_HMAC_SECRET.length < 32) throw new Error("Vision observation secret must contain at least 32 characters.");
    secret = env.GATEWAY_VISION_OBSERVATION_HMAC_SECRET;
    source = "configured";
  }
  return new VisionFingerprinter(secret, source, assetBase);
}
