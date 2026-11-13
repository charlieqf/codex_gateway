import { createHash, createHmac } from "node:crypto";

export interface CosVisionConfig {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
}

export function parseCosVisionConfig(text: string): CosVisionConfig {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    throw invalidConfig();
  }
  return validateConfig(value);
}

function invalidConfig(): Error {
  return new Error("MEDCODE_VISION_COS_CREDENTIALS_FILE is invalid.");
}

function validateConfig(value: unknown): CosVisionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidConfig();
  const config = value as Record<string, unknown>;
  if (
    Object.keys(config).length !== 4 ||
    typeof config.bucket !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,48}-[0-9]{5,20}$/u.test(config.bucket) ||
    typeof config.region !== "string" ||
    !/^ap-[a-z]+(?:-[0-9]+)?$/u.test(config.region) ||
    typeof config.secretId !== "string" ||
    !/^[A-Za-z0-9]{10,128}$/u.test(config.secretId) ||
    typeof config.secretKey !== "string" ||
    !/^[A-Za-z0-9]{10,128}$/u.test(config.secretKey)
  )
    throw invalidConfig();
  return {
    bucket: config.bucket,
    region: config.region,
    secretId: config.secretId,
    secretKey: config.secretKey,
  };
}

/** COS XML signing is distinct from R2's AWS SigV4. Never log signed requests. */
export class CosVisionStorage {
  readonly endpoint: string;
  private readonly config: Readonly<CosVisionConfig>;
  constructor(config: CosVisionConfig) {
    this.config = validateConfig(config);
    this.endpoint = `https://${this.config.bucket}.cos.${this.config.region}.myqcloud.com`;
  }

  objectUrl(key: string): URL {
    return new URL("/" + key.split("/").map(encode).join("/"), this.endpoint);
  }

  uploadHeaders(contentType: string, sha256: string): Record<string, string> {
    return {
      "Content-Type": contentType,
      "x-cos-forbid-overwrite": "true",
      "x-cos-server-side-encryption": "AES256",
      "x-cos-meta-sha256": sha256,
    };
  }

  signedUrl(
    method: "GET" | "PUT",
    key: string,
    ttl: number,
    now: Date,
    headers: Readonly<Record<string, string>>,
  ): string {
    const url = this.objectUrl(key);
    return `${url}?${this.authorization(method, url, headers, now, ttl)}`;
  }

  requestHeaders(
    method: string,
    key: string,
    now: Date,
    payload: Uint8Array,
    headers: Readonly<Record<string, string>> = {},
  ): Headers {
    const outgoing = new Headers(headers);
    if (method === "PUT") {
      outgoing.delete("if-none-match");
      outgoing.set("x-cos-forbid-overwrite", "true");
      outgoing.set("x-cos-server-side-encryption", "AES256");
      outgoing.set(
        "content-md5",
        createHash("md5").update(payload).digest("base64"),
      );
      outgoing.set(
        "x-cos-meta-sha256",
        createHash("sha256").update(payload).digest("hex"),
      );
    }
    outgoing.set(
      "authorization",
      this.authorization(
        method,
        this.objectUrl(key),
        Object.fromEntries(outgoing),
        now,
        300,
      ),
    );
    return outgoing;
  }

  private authorization(
    method: string,
    url: URL,
    headers: Readonly<Record<string, string>>,
    now: Date,
    ttl: number,
  ): string {
    const at = Math.floor(now.getTime() / 1000);
    if (
      !Number.isSafeInteger(at) ||
      !Number.isSafeInteger(ttl) ||
      ttl <= 0 ||
      ttl > 3600
    ) {
      throw new Error("Invalid COS signature lifetime.");
    }
    const time = `${at - 30};${at + ttl}`;
    const values = new Headers(headers);
    values.set("host", url.host);
    const entries = [...values].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const canonical = entries
      .map(([key, value]) => `${encode(key)}=${encode(value)}`)
      .join("&");
    // COS signs the decoded object path, unlike AWS SigV4's encoded canonical URI.
    const http = `${method.toLowerCase()}\n${decodeURIComponent(url.pathname)}\n\n${canonical}\n`;
    const signKey = createHmac("sha1", this.config.secretKey)
      .update(time)
      .digest("hex");
    const toSign = `sha1\n${time}\n${createHash("sha1").update(http).digest("hex")}\n`;
    const signature = createHmac("sha1", signKey).update(toSign).digest("hex");
    return (
      `q-sign-algorithm=sha1&q-ak=${this.config.secretId}&q-sign-time=${time}&q-key-time=${time}` +
      `&q-header-list=${entries.map(([key]) => key).join(";")}&q-url-param-list=&q-signature=${signature}`
    );
  }
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
