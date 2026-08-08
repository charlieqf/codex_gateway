import {
  createHash,
  createHmac,
  randomUUID as nodeRandomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import { GatewayError } from "@codex-gateway/core";

export const visionAssetMaximumBytes = 20 * 1_024 * 1_024;
export const visionAssetMaximumImagesPerRequest = 8;
export const visionAssetMaximumIdCharacters = 2_048;

export type VisionAssetContentType = "image/png" | "image/jpeg";

export interface VisionAssetCreateInput {
  contentType: VisionAssetContentType;
  sizeBytes: number;
  sha256: string;
}

export interface VisionAssetUploadGrant {
  assetId: string;
  contentType: VisionAssetContentType;
  sizeBytes: number;
  sha256: string;
  uploadUrl: string;
  uploadHeaders: Readonly<Record<string, string>>;
  uploadExpiresAt: Date;
  assetExpiresAt: Date;
}

export interface VisionAssetReadGrant {
  assetId: string;
  contentType: VisionAssetContentType;
  sizeBytes: number;
  sha256: string;
  imageUrl: string;
  readUrlExpiresAt: Date;
  assetExpiresAt: Date;
}

export interface VisionAssetService {
  createAsset(ownerId: string, input: VisionAssetCreateInput): VisionAssetUploadGrant;
  completeAsset(ownerId: string, assetId: string): Promise<VisionAssetReadGrant>;
  createReadUrl(ownerId: string, assetId: string): Promise<VisionAssetReadGrant>;
  deleteAsset(ownerId: string, assetId: string): Promise<void>;
}

export interface R2VisionAssetServiceOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  uploadUrlTtlSeconds?: number;
  readUrlTtlSeconds?: number;
  assetTtlSeconds?: number;
  requestTimeoutMs?: number;
  now?: () => Date;
  randomUUID?: () => string;
  fetchImpl?: VisionAssetFetch;
}

type VisionAssetFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

interface VisionAssetTokenPayload {
  v: 1;
  k: string;
  m: VisionAssetContentType;
  s: number;
  h: string;
  o: string;
  e: number;
}

interface R2ObjectMetadata {
  contentType: string;
  sizeBytes: number;
}

interface AuthenticatedRequestInput {
  method: "DELETE" | "GET" | "HEAD" | "PUT";
  objectKey: string;
  payload?: Uint8Array;
  signedHeaders?: Readonly<Record<string, string>>;
  extraHeaders?: Readonly<Record<string, string>>;
}

const r2Region = "auto";
const r2Service = "s3";
const unsignedPayload = "UNSIGNED-PAYLOAD";
const emptyPayloadSha256 = createHash("sha256").update("").digest("hex");
const defaultUploadUrlTtlSeconds = 10 * 60;
const defaultReadUrlTtlSeconds = 30 * 60;
const defaultAssetTtlSeconds = 24 * 60 * 60;
const defaultRequestTimeoutMs = 30_000;
const readyMarkerContentType = "application/json";
const assetTokenPrefix = "va1";

export class R2VisionAssetService implements VisionAssetService {
  private readonly endpoint: URL;
  private readonly fetchImpl: VisionAssetFetch;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly uploadUrlTtlSeconds: number;
  private readonly readUrlTtlSeconds: number;
  private readonly assetTtlSeconds: number;
  private readonly requestTimeoutMs: number;
  private readonly assetSigningKey: Buffer;

  constructor(private readonly options: R2VisionAssetServiceOptions) {
    this.endpoint = parseR2Endpoint(options.endpoint);
    validateR2Bucket(options.bucket);
    validateCredentialValue(options.accessKeyId, "R2 access key ID");
    validateCredentialValue(options.secretAccessKey, "R2 secret access key");
    this.uploadUrlTtlSeconds = boundedInteger(
      options.uploadUrlTtlSeconds ?? defaultUploadUrlTtlSeconds,
      60,
      3_600,
      "R2 vision upload URL TTL"
    );
    this.readUrlTtlSeconds = boundedInteger(
      options.readUrlTtlSeconds ?? defaultReadUrlTtlSeconds,
      60,
      3_600,
      "R2 vision read URL TTL"
    );
    this.assetTtlSeconds = boundedInteger(
      options.assetTtlSeconds ?? defaultAssetTtlSeconds,
      3_600,
      7 * 24 * 60 * 60,
      "R2 vision asset TTL"
    );
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? defaultRequestTimeoutMs,
      1_000,
      120_000,
      "R2 vision request timeout"
    );
    // R2 is deliberately direct even when the Gateway's model traffic uses an
    // environment proxy. This also keeps signed storage operations on the same
    // network view as client-side presigned uploads.
    this.fetchImpl = options.fetchImpl ?? directHttpsFetch;
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.assetSigningKey = createHmac("sha256", options.secretAccessKey)
      .update("medcode-vision-asset-token-v1", "utf8")
      .digest();
  }

  createAsset(ownerId: string, input: VisionAssetCreateInput): VisionAssetUploadGrant {
    validateOwnerId(ownerId);
    validateCreateInput(input);
    const now = this.now();
    const assetExpiresAt = new Date(now.getTime() + this.assetTtlSeconds * 1_000);
    const uploadTtlSeconds = Math.min(
      this.uploadUrlTtlSeconds,
      this.assetTtlSeconds
    );
    const uploadExpiresAt = new Date(now.getTime() + uploadTtlSeconds * 1_000);
    const objectKey = createObjectKey(now, this.randomUUID(), input.contentType);
    const payload: VisionAssetTokenPayload = {
      v: 1,
      k: objectKey,
      m: input.contentType,
      s: input.sizeBytes,
      h: input.sha256,
      o: this.ownerTag(ownerId),
      e: Math.floor(assetExpiresAt.getTime() / 1_000)
    };
    const assetId = this.encodeAssetToken(payload);
    const uploadHeaders = {
      "Content-Type": input.contentType,
      "If-None-Match": "*"
    } as const;
    return {
      assetId,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      uploadUrl: this.presignedUrl(
        "PUT",
        objectKey,
        uploadTtlSeconds,
        now,
        uploadHeaders
      ),
      uploadHeaders,
      uploadExpiresAt,
      assetExpiresAt
    };
  }

  async completeAsset(ownerId: string, assetId: string): Promise<VisionAssetReadGrant> {
    const asset = this.decodeAssetToken(ownerId, assetId);
    if (await this.readyMarkerExists(asset)) {
      await this.verifyObjectMetadata(asset);
      return this.readGrant(assetId, asset);
    }

    try {
      await this.verifyUploadedObject(asset);
      await this.writeReadyMarker(asset);
    } catch (error) {
      if (error instanceof GatewayError && error.code === "vision_asset_invalid") {
        await this.deleteObjectBestEffort(readyMarkerKey(asset.k));
        await this.deleteObjectBestEffort(asset.k);
      }
      throw error;
    }
    return this.readGrant(assetId, asset);
  }

  async createReadUrl(ownerId: string, assetId: string): Promise<VisionAssetReadGrant> {
    const asset = this.decodeAssetToken(ownerId, assetId);
    if (!(await this.readyMarkerExists(asset))) {
      throw visionAssetNotFound();
    }
    await this.verifyObjectMetadata(asset);
    return this.readGrant(assetId, asset);
  }

  async deleteAsset(ownerId: string, assetId: string): Promise<void> {
    const asset = this.decodeAssetToken(ownerId, assetId, true);
    await this.deleteObject(readyMarkerKey(asset.k));
    await this.deleteObject(asset.k);
  }

  private readGrant(
    assetId: string,
    asset: VisionAssetTokenPayload
  ): VisionAssetReadGrant {
    const now = this.now();
    const remainingSeconds = asset.e - Math.floor(now.getTime() / 1_000);
    if (remainingSeconds <= 0) {
      throw visionAssetExpired();
    }
    const readTtlSeconds = Math.min(this.readUrlTtlSeconds, remainingSeconds);
    return {
      assetId,
      contentType: asset.m,
      sizeBytes: asset.s,
      sha256: asset.h,
      imageUrl: this.presignedUrl(
        "GET",
        asset.k,
        readTtlSeconds,
        now
      ),
      readUrlExpiresAt: new Date(now.getTime() + readTtlSeconds * 1_000),
      assetExpiresAt: new Date(asset.e * 1_000)
    };
  }

  private async verifyUploadedObject(asset: VisionAssetTokenPayload): Promise<void> {
    await this.verifyObjectMetadata(asset);
    const response = await this.authenticatedRequest({
      method: "GET",
      objectKey: asset.k
    });
    if (response.status === 404) {
      await cancelResponse(response);
      throw visionAssetNotFound();
    }
    if (!response.ok) {
      await cancelResponse(response);
      throw visionAssetStorageUnavailable(response.status);
    }
    if (!response.body) {
      throw visionAssetStorageUnavailable();
    }

    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let prefix = Buffer.alloc(0);
    let totalBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        totalBytes += chunk.value.byteLength;
        if (totalBytes > asset.s || totalBytes > visionAssetMaximumBytes) {
          throw invalidUploadedAsset("Uploaded image size does not match the declared size.");
        }
        hash.update(chunk.value);
        if (prefix.length < 16) {
          const needed = 16 - prefix.length;
          prefix = Buffer.concat([
            prefix,
            Buffer.from(chunk.value.subarray(0, needed))
          ]);
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error instanceof GatewayError ? error : visionAssetStorageUnavailable();
    } finally {
      reader.releaseLock();
    }

    if (totalBytes !== asset.s) {
      throw invalidUploadedAsset("Uploaded image size does not match the declared size.");
    }
    if (!matchesImageSignature(prefix, asset.m)) {
      throw invalidUploadedAsset("Uploaded content is not a supported PNG or JPEG image.");
    }
    const digest = hash.digest("hex");
    if (!safeStringEqual(digest, asset.h)) {
      throw invalidUploadedAsset("Uploaded image SHA-256 does not match the declared digest.");
    }
  }

  private async verifyObjectMetadata(asset: VisionAssetTokenPayload): Promise<void> {
    const metadata = await this.headObject(asset.k);
    if (!metadata) {
      throw visionAssetNotFound();
    }
    if (
      metadata.sizeBytes !== asset.s ||
      normalizeContentType(metadata.contentType) !== asset.m
    ) {
      throw invalidUploadedAsset("Uploaded image metadata does not match the upload grant.");
    }
  }

  private async readyMarkerExists(asset: VisionAssetTokenPayload): Promise<boolean> {
    const response = await this.authenticatedRequest({
      method: "HEAD",
      objectKey: readyMarkerKey(asset.k)
    });
    if (response.status === 404) {
      await cancelResponse(response);
      return false;
    }
    if (!response.ok) {
      await cancelResponse(response);
      throw visionAssetStorageUnavailable(response.status);
    }
    await cancelResponse(response);
    return true;
  }

  private async headObject(objectKey: string): Promise<R2ObjectMetadata | null> {
    const response = await this.authenticatedRequest({ method: "HEAD", objectKey });
    if (response.status === 404) {
      await cancelResponse(response);
      return null;
    }
    if (!response.ok) {
      await cancelResponse(response);
      throw visionAssetStorageUnavailable(response.status);
    }
    const rawLength = response.headers.get("content-length");
    const sizeBytes = rawLength === null ? NaN : Number(rawLength);
    const contentType = response.headers.get("content-type") ?? "";
    await cancelResponse(response);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw visionAssetStorageUnavailable();
    }
    return { contentType, sizeBytes };
  }

  private async writeReadyMarker(asset: VisionAssetTokenPayload): Promise<void> {
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        content_type: asset.m,
        size_bytes: asset.s,
        sha256: asset.h
      }),
      "utf8"
    );
    const response = await this.authenticatedRequest({
      method: "PUT",
      objectKey: readyMarkerKey(asset.k),
      payload,
      signedHeaders: {
        "content-type": readyMarkerContentType,
        "if-none-match": "*"
      }
    });
    if (response.ok) {
      await cancelResponse(response);
      return;
    }
    if (response.status === 412) {
      await cancelResponse(response);
      if (await this.readyMarkerExists(asset)) {
        return;
      }
    } else {
      await cancelResponse(response);
    }
    throw visionAssetStorageUnavailable(response.status);
  }

  private async deleteObject(objectKey: string): Promise<void> {
    const response = await this.authenticatedRequest({ method: "DELETE", objectKey });
    if (!response.ok && response.status !== 404) {
      await cancelResponse(response);
      throw visionAssetStorageUnavailable(response.status);
    }
    await cancelResponse(response);
  }

  private async deleteObjectBestEffort(objectKey: string): Promise<void> {
    await this.deleteObject(objectKey).catch(() => undefined);
  }

  private async authenticatedRequest(
    input: AuthenticatedRequestInput
  ): Promise<Response> {
    const now = this.now();
    const amzDate = awsTimestamp(now);
    const dateStamp = amzDate.slice(0, 8);
    const payload = input.payload ?? new Uint8Array();
    const payloadHash =
      payload.byteLength === 0
        ? emptyPayloadSha256
        : createHash("sha256").update(payload).digest("hex");
    const objectUrl = this.objectUrl(input.objectKey);
    const signedHeaderValues: Record<string, string> = {
      host: objectUrl.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...lowercaseHeaders(input.signedHeaders)
    };
    const { canonicalHeaders, signedHeaders } = canonicalizeHeaders(
      signedHeaderValues
    );
    const canonicalRequest = [
      input.method,
      objectUrl.pathname,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");
    const scope = `${dateStamp}/${r2Region}/${r2Service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(canonicalRequest)
    ].join("\n");
    const signature = createHmac(
      "sha256",
      awsSigningKey(this.options.secretAccessKey, dateStamp)
    )
      .update(stringToSign, "utf8")
      .digest("hex");
    const headers = new Headers({
      ...signedHeaderValues,
      ...lowercaseHeaders(input.extraHeaders),
      authorization:
        `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope},` +
        `SignedHeaders=${signedHeaders},Signature=${signature}`
    });
    headers.delete("host");

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("r2_request_timeout")),
      this.requestTimeoutMs
    );
    try {
      return await this.fetchImpl(objectUrl, {
        method: input.method,
        headers,
        ...(input.method === "PUT"
          ? { body: Buffer.from(payload) as unknown as BodyInit }
          : {}),
        signal: controller.signal
      });
    } catch {
      throw visionAssetStorageUnavailable();
    } finally {
      clearTimeout(timeout);
    }
  }

  private presignedUrl(
    method: "GET" | "PUT",
    objectKey: string,
    expiresSeconds: number,
    now: Date,
    additionalHeaders: Readonly<Record<string, string>> = {}
  ): string {
    const objectUrl = this.objectUrl(objectKey);
    const amzDate = awsTimestamp(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${r2Region}/${r2Service}/aws4_request`;
    const signedHeaderValues = {
      host: objectUrl.host,
      ...lowercaseHeaders(additionalHeaders)
    };
    const { canonicalHeaders, signedHeaders } = canonicalizeHeaders(
      signedHeaderValues
    );
    const parameters: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Content-Sha256": unsignedPayload,
      "X-Amz-Credential": `${this.options.accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresSeconds),
      "X-Amz-SignedHeaders": signedHeaders
    };
    const canonicalQuery = canonicalizeQuery(parameters);
    const canonicalRequest = [
      method,
      objectUrl.pathname,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      unsignedPayload
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(canonicalRequest)
    ].join("\n");
    const signature = createHmac(
      "sha256",
      awsSigningKey(this.options.secretAccessKey, dateStamp)
    )
      .update(stringToSign, "utf8")
      .digest("hex");
    return `${objectUrl.toString()}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  private objectUrl(objectKey: string): URL {
    const canonicalPath = canonicalObjectPath(this.options.bucket, objectKey);
    return new URL(canonicalPath, this.endpoint);
  }

  private ownerTag(ownerId: string): string {
    return createHmac("sha256", this.assetSigningKey)
      .update(`owner\u0000${ownerId}`, "utf8")
      .digest("base64url");
  }

  private encodeAssetToken(payload: VisionAssetTokenPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url"
    );
    const signature = createHmac("sha256", this.assetSigningKey)
      .update(`${assetTokenPrefix}.${encoded}`, "utf8")
      .digest("base64url");
    return `${assetTokenPrefix}.${encoded}.${signature}`;
  }

  private decodeAssetToken(
    ownerId: string,
    assetId: string,
    allowExpired = false
  ): VisionAssetTokenPayload {
    validateOwnerId(ownerId);
    if (
      assetId.length < 64 ||
      assetId.length > visionAssetMaximumIdCharacters ||
      !/^[A-Za-z0-9._-]+$/u.test(assetId)
    ) {
      throw visionAssetNotFound();
    }
    const parts = assetId.split(".");
    if (parts.length !== 3 || parts[0] !== assetTokenPrefix) {
      throw visionAssetNotFound();
    }
    const expectedSignature = createHmac("sha256", this.assetSigningKey)
      .update(`${assetTokenPrefix}.${parts[1]}`, "utf8")
      .digest();
    let receivedSignature: Buffer;
    try {
      receivedSignature = Buffer.from(parts[2]!, "base64url");
    } catch {
      throw visionAssetNotFound();
    }
    if (
      receivedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(receivedSignature, expectedSignature)
    ) {
      throw visionAssetNotFound();
    }

    let payload: unknown;
    try {
      payload = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString("utf8")
      ) as unknown;
    } catch {
      throw visionAssetNotFound();
    }
    if (!isVisionAssetTokenPayload(payload)) {
      throw visionAssetNotFound();
    }
    if (!safeStringEqual(payload.o, this.ownerTag(ownerId))) {
      throw visionAssetNotFound();
    }
    if (!allowExpired && payload.e <= Math.floor(this.now().getTime() / 1_000)) {
      throw visionAssetExpired();
    }
    return payload;
  }
}

export function resolveVisionAssetService(
  env: NodeJS.ProcessEnv,
  options: {
    now?: () => Date;
    fetchImpl?: VisionAssetFetch;
  } = {}
): VisionAssetService | null {
  const enabled = env.MEDCODE_VISION_R2_ENABLED?.trim();
  if (!enabled || enabled === "0") {
    return null;
  }
  if (enabled !== "1") {
    throw new Error("MEDCODE_VISION_R2_ENABLED must be 0 or 1.");
  }
  const endpoint = requiredEnvironmentValue(env, "MEDCODE_VISION_R2_ENDPOINT");
  const bucket = requiredEnvironmentValue(env, "MEDCODE_VISION_R2_BUCKET");
  const credentialsFile = requiredEnvironmentValue(
    env,
    "MEDCODE_VISION_R2_CREDENTIALS_FILE"
  );
  const credentials = readR2CredentialsFile(credentialsFile);
  return new R2VisionAssetService({
    endpoint,
    bucket,
    ...credentials,
    uploadUrlTtlSeconds: optionalEnvironmentInteger(
      env.MEDCODE_VISION_R2_UPLOAD_URL_TTL_SECONDS,
      defaultUploadUrlTtlSeconds,
      "MEDCODE_VISION_R2_UPLOAD_URL_TTL_SECONDS"
    ),
    readUrlTtlSeconds: optionalEnvironmentInteger(
      env.MEDCODE_VISION_R2_READ_URL_TTL_SECONDS,
      defaultReadUrlTtlSeconds,
      "MEDCODE_VISION_R2_READ_URL_TTL_SECONDS"
    ),
    assetTtlSeconds: optionalEnvironmentInteger(
      env.MEDCODE_VISION_R2_ASSET_TTL_SECONDS,
      defaultAssetTtlSeconds,
      "MEDCODE_VISION_R2_ASSET_TTL_SECONDS"
    ),
    requestTimeoutMs: optionalEnvironmentInteger(
      env.MEDCODE_VISION_R2_REQUEST_TIMEOUT_MS,
      defaultRequestTimeoutMs,
      "MEDCODE_VISION_R2_REQUEST_TIMEOUT_MS"
    ),
    ...options
  });
}

export function readR2CredentialsFile(filename: string): {
  accessKeyId: string;
  secretAccessKey: string;
} {
  const sourceEnvName = "MEDCODE_VISION_R2_CREDENTIALS_FILE";
  const resolved = path.resolve(filename);
  const canonical = realpathSync(resolved);
  if (canonical !== resolved && process.platform !== "win32") {
    throw new Error(`${sourceEnvName} must reference a canonical secret file.`);
  }
  const flags =
    constants.O_RDONLY |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const descriptor = openSync(resolved, flags);
  try {
    const fileStat = fstatSync(descriptor);
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > 4_096) {
      throw new Error(`${sourceEnvName} secret file is invalid.`);
    }
    if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
      throw new Error(`${sourceEnvName} secret file permissions are too broad.`);
    }
    if (
      process.platform === "linux" &&
      realpathSync(`/proc/self/fd/${descriptor}`) !== resolved
    ) {
      throw new Error(`${sourceEnvName} secret file handle is not canonical.`);
    }
    const values = parseR2CredentialText(readFileSync(descriptor, "utf8"));
    return {
      accessKeyId: values.R2_ACCESS_KEY_ID,
      secretAccessKey: values.R2_SECRET_ACCESS_KEY
    };
  } finally {
    closeSync(descriptor);
  }
}

function parseR2CredentialText(text: string): {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
} {
  const allowed = new Set(["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]);
  const values = new Map<string, string>();
  for (const rawLine of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error("MEDCODE_VISION_R2_CREDENTIALS_FILE is invalid.");
    }
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!allowed.has(name) || values.has(name)) {
      throw new Error("MEDCODE_VISION_R2_CREDENTIALS_FILE is invalid.");
    }
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === '"' || value[0] === "'")
    ) {
      value = value.slice(1, -1);
    }
    validateCredentialValue(value, `MEDCODE_VISION_R2_CREDENTIALS_FILE ${name}`);
    values.set(name, value);
  }
  const accessKeyId = values.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = values.get("R2_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey || values.size !== 2) {
    throw new Error("MEDCODE_VISION_R2_CREDENTIALS_FILE is invalid.");
  }
  return {
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey
  };
}

function validateCreateInput(input: VisionAssetCreateInput): void {
  if (input.contentType !== "image/png" && input.contentType !== "image/jpeg") {
    throw new GatewayError({
      code: "unsupported_format",
      message: "Vision assets must be PNG or JPEG images.",
      httpStatus: 400
    });
  }
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > visionAssetMaximumBytes
  ) {
    throw new GatewayError({
      code: "unsupported_size",
      message: `Vision assets must be between 1 and ${visionAssetMaximumBytes} bytes.`,
      httpStatus: 400
    });
  }
  if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
    throw new GatewayError({
      code: "invalid_request",
      message: "sha256 must be a lowercase 64-character hexadecimal digest.",
      httpStatus: 400
    });
  }
}

function createObjectKey(
  now: Date,
  randomUUID: string,
  contentType: VisionAssetContentType
): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "/");
  const identifier = randomUUID.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/u.test(identifier)) {
    throw new Error("Vision asset random UUID source returned an invalid value.");
  }
  const extension = contentType === "image/png" ? "png" : "jpg";
  return `vision-temp/${date}/${identifier}.${extension}`;
}

function readyMarkerKey(objectKey: string): string {
  return objectKey.replace(/\.(?:png|jpg)$/u, ".ready");
}

function isVisionAssetTokenPayload(value: unknown): value is VisionAssetTokenPayload {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.v !== 1 ||
    (value.m !== "image/png" && value.m !== "image/jpeg") ||
    !Number.isSafeInteger(value.s) ||
    (value.s as number) < 1 ||
    (value.s as number) > visionAssetMaximumBytes ||
    typeof value.h !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.h) ||
    typeof value.o !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.o) ||
    !Number.isSafeInteger(value.e) ||
    (value.e as number) <= 0 ||
    typeof value.k !== "string"
  ) {
    return false;
  }
  const extension = value.m === "image/png" ? "png" : "jpg";
  return new RegExp(
    `^vision-temp/\\d{4}/\\d{2}/\\d{2}/[a-f0-9]{32}\\.${extension}$`,
    "u"
  ).test(value.k);
}

function matchesImageSignature(
  prefix: Uint8Array,
  contentType: VisionAssetContentType
): boolean {
  if (contentType === "image/png") {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return prefix.length >= signature.length && Buffer.from(prefix).subarray(0, 8).equals(signature);
  }
  return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
}

function parseR2Endpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("MEDCODE_VISION_R2_ENDPOINT must be a valid HTTPS URL.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "")
  ) {
    throw new Error("MEDCODE_VISION_R2_ENDPOINT must be an HTTPS origin without credentials, path or query.");
  }
  endpoint.pathname = "/";
  return endpoint;
}

function validateR2Bucket(value: string): void {
  if (
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value) ||
    value.includes("..")
  ) {
    throw new Error("MEDCODE_VISION_R2_BUCKET is invalid.");
  }
}

function validateCredentialValue(value: string, label: string): void {
  if (
    value.length < 8 ||
    value.length > 512 ||
    /[\s\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
}

function validateOwnerId(ownerId: string): void {
  if (!ownerId || ownerId.length > 512 || /[\r\n\u0000]/u.test(ownerId)) {
    throw new Error("Vision asset owner ID is invalid.");
  }
}

function requiredEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when MEDCODE_VISION_R2_ENABLED=1.`);
  }
  return value;
}

function optionalEnvironmentInteger(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  return value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function awsTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Vision asset clock returned an invalid date.");
  }
  return value.toISOString().replace(/[:-]|\.\d{3}/gu, "");
}

function awsSigningKey(secret: string, dateStamp: string): Buffer {
  const dateKey = createHmac("sha256", `AWS4${secret}`)
    .update(dateStamp, "utf8")
    .digest();
  const regionKey = createHmac("sha256", dateKey)
    .update(r2Region, "utf8")
    .digest();
  const serviceKey = createHmac("sha256", regionKey)
    .update(r2Service, "utf8")
    .digest();
  return createHmac("sha256", serviceKey)
    .update("aws4_request", "utf8")
    .digest();
}

function canonicalObjectPath(bucket: string, objectKey: string): string {
  return `/${rfc3986Encode(bucket)}/${objectKey
    .split("/")
    .map(rfc3986Encode)
    .join("/")}`;
}

function canonicalizeHeaders(values: Readonly<Record<string, string>>): {
  canonicalHeaders: string;
  signedHeaders: string;
} {
  const entries = Object.entries(values)
    .map(([name, value]) => [name.toLowerCase(), normalizeHeaderValue(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    canonicalHeaders: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders: entries.map(([name]) => name).join(";")
  };
}

function canonicalizeQuery(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([name, value]) => [rfc3986Encode(name), rfc3986Encode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? leftValue.localeCompare(rightValue)
        : leftName.localeCompare(rightName)
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function lowercaseHeaders(
  headers: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  if (!headers) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function normalizeContentType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function visionAssetNotFound(): GatewayError {
  return new GatewayError({
    code: "vision_asset_not_found",
    message: "Vision asset was not found or has not completed upload validation.",
    httpStatus: 404
  });
}

function visionAssetExpired(): GatewayError {
  return new GatewayError({
    code: "vision_asset_expired",
    message: "Vision asset has expired. Upload the image again to continue.",
    httpStatus: 410
  });
}

function invalidUploadedAsset(message: string): GatewayError {
  return new GatewayError({
    code: "vision_asset_invalid",
    message,
    httpStatus: 422
  });
}

function visionAssetStorageUnavailable(upstreamStatus?: number): GatewayError {
  return new GatewayError({
    code: "service_unavailable",
    message: "Vision asset storage is temporarily unavailable.",
    httpStatus: 503,
    ...(upstreamStatus === undefined ? {} : { upstreamStatus })
  });
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function directHttpsFetch(
  input: string | URL | Request,
  init: RequestInit = {}
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.protocol !== "https:") {
    return Promise.reject(new Error("Vision asset transport requires HTTPS."));
  }
  const method = (
    init.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  const body = init.body;
  if (
    body !== undefined &&
    body !== null &&
    typeof body !== "string" &&
    !(body instanceof Uint8Array)
  ) {
    return Promise.reject(
      new Error("Vision asset transport received an unsupported body.")
    );
  }
  if (body instanceof Uint8Array && !headers.has("content-length")) {
    headers.set("content-length", String(body.byteLength));
  }
  const outgoingHeaders = Object.fromEntries(headers.entries());

  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method,
        headers: outgoingHeaders,
        signal: init.signal ?? undefined,
        agent: false
      },
      (incoming) => {
        const status = incoming.statusCode;
        if (status === undefined) {
          incoming.destroy();
          reject(new Error("Vision asset transport received no status."));
          return;
        }
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(
            incoming.rawHeaders[index]!,
            incoming.rawHeaders[index + 1]!
          );
        }
        const hasBody =
          method !== "HEAD" && status !== 204 && status !== 205 && status !== 304;
        if (!hasBody) {
          incoming.resume();
        }
        try {
          resolve(
            new Response(
              hasBody
                ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>)
                : null,
              {
                status,
                statusText: incoming.statusMessage,
                headers: responseHeaders
              }
            )
          );
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      }
    );
    request.once("error", reject);
    request.end(body === null || body === undefined ? undefined : body);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
