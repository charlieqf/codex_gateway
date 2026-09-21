import { createHash } from "node:crypto";
import { Agent, request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ImagingError, object, requireImaging, safeToken, type Artifact, type Json } from "./contract.js";

export interface StarRequest {
  body?: Json; key?: string; stream?: Readable; length?: number; digest?: string; signal?: AbortSignal;
}
export interface StarClient {
  json(owner: string, method: string, suffix: string, options?: StarRequest): Promise<{ status: number; data: unknown }>;
  artifact(owner: string, suffix: string, artifact: Artifact, signal?: AbortSignal): Promise<Readable>;
  close(): void;
}

/** Backpressure, exact length and digest validation without retaining the body. */
export class VerifiedStream extends Transform {
  private count = 0;
  private readonly hash = createHash("sha256");
  constructor(private readonly size: number, private readonly digest: string, private readonly checkAccess?: () => void) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.checkAccess?.();
      this.count += chunk.length;
      requireImaging(this.count <= this.size, 413, "size_limit");
      this.hash.update(chunk);
      callback(null, chunk);
    } catch (error) { callback(error as Error); }
  }
  override _flush(callback: TransformCallback): void {
    try {
      this.checkAccess?.();
      requireImaging(this.count === this.size, 400, "invalid_chunk");
      requireImaging(this.hash.digest("hex") === this.digest, 409, "hash_mismatch");
      callback();
    } catch (error) { callback(error as Error); }
  }
}

export class HttpsStarClient implements StarClient {
  private readonly base: URL;
  private readonly agent: Agent;
  constructor(private readonly options: { baseUrl: string; token: string; ca: string | Buffer; controlTimeoutMs?: number; transferTimeoutMs?: number; maxSockets?: number }) {
    this.base = new URL(options.baseUrl);
    requireImaging(this.base.protocol === "https:" && !this.base.username && !this.base.password && !this.base.search && !this.base.hash &&
      this.base.pathname.replace(/\/$/, "") === "/internal/imaging/v1" && /^[\x21-\x7e]{24,512}$/.test(options.token) && options.ca.length > 0, 503, "unavailable");
    this.agent = new Agent({ ca: options.ca, rejectUnauthorized: true, keepAlive: true, maxSockets: options.maxSockets ?? 8, maxFreeSockets: 2 });
  }
  close(): void { this.agent.destroy(); }
  private open(owner: string, method: string, suffix: string, options: StarRequest, transfer: boolean) {
    requireImaging(/^[a-f0-9]{64}$/.test(owner) && suffix.startsWith("/") && !suffix.startsWith("//"), 503, "unavailable");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(abort, transfer ? this.options.transferTimeoutMs ?? 300_000 : this.options.controlTimeoutMs ?? 15_000);
    timer.unref();
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    const payload = options.body ? Buffer.from(JSON.stringify(options.body)) : undefined;
    // Construct every private header here. Never copy client authorization, owner, cookies or forwarding headers.
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.token}`, "x-imaging-owner": owner, accept: "application/json" };
    if (options.key) headers["idempotency-key"] = options.key;
    if (payload || options.stream) {
      headers["content-type"] = options.stream ? "application/octet-stream" : "application/json";
      headers["content-length"] = String(options.stream ? options.length : payload!.length);
    }
    if (options.digest) headers["x-content-sha256"] = options.digest;
    const url = new URL(this.base);
    const [pathname, query] = suffix.split("?", 2);
    url.pathname = `${this.base.pathname.replace(/\/$/, "")}${pathname}`;
    url.search = query ?? "";
    const request = httpsRequest(url, { method, headers, agent: this.agent, signal: controller.signal, rejectUnauthorized: true });
    request.on("error", cleanup);
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      request.once("response", incoming => {
        incoming.once("close", cleanup);
        resolve(incoming);
      });
      request.once("error", () => reject(new ImagingError(503, "unavailable")));
    });
    return { request, response, payload, cleanup };
  }
  async json(owner: string, method: string, suffix: string, options: StarRequest = {}): Promise<{ status: number; data: unknown }> {
    const operation = this.open(owner, method, suffix, options, Boolean(options.stream));
    let uploading: Promise<void> | undefined;
    if (options.stream) {
      uploading = pipeline(options.stream, new VerifiedStream(options.length!, options.digest!), operation.request);
    } else { operation.request.end(operation.payload); }
    try {
      const reading = operation.response.then(async response => {
        const data = await readJson(response);
        return { status: response.statusCode ?? 503, data };
      });
      const [result] = await Promise.all([reading, uploading]);
      checkStatus(result.status, result.data);
      return result;
    } catch (error) {
      operation.request.destroy();
      throw error instanceof ImagingError ? error : new ImagingError(503, "unavailable");
    } finally { operation.cleanup(); }
  }
  async artifact(owner: string, suffix: string, artifact: Artifact, signal?: AbortSignal): Promise<Readable> {
    const operation = this.open(owner, "GET", suffix, { signal }, true);
    operation.request.end();
    try {
      const response = await operation.response;
      if (response.statusCode !== 200) {
        const body = await readJson(response);
        checkStatus(response.statusCode ?? 503, body);
        throw new ImagingError(503, "upstream_protocol_error");
      }
      if (response.headers["content-length"] !== String(artifact.size) || response.headers["x-content-sha256"] !== artifact.sha256 || response.headers["content-encoding"]) {
        response.destroy();
        throw new ImagingError(503, "upstream_protocol_error");
      }
      const checked = new VerifiedStream(artifact.size, artifact.sha256);
      // Catch the pipeline promise: Fastify consumes the stream error. No raw TLS/host errors reach request logs.
      void pipeline(response, checked).catch(() => checked.destroy(new ImagingError(503, "unavailable")));
      checked.once("close", () => { response.destroy(); operation.cleanup(); });
      return checked;
    } catch (error) {
      operation.request.destroy();
      operation.cleanup();
      throw error instanceof ImagingError ? error : new ImagingError(503, "unavailable");
    }
  }
}

async function readJson(response: IncomingMessage): Promise<unknown> {
  const maximum = 1024 * 1024;
  const buffers: Buffer[] = [];
  let length = 0;
  if (Number(response.headers["content-length"] ?? 0) > maximum) { response.destroy(); throw new ImagingError(503, "upstream_protocol_error"); }
  try {
    for await (const chunk of response) {
      length += chunk.length;
      if (length > maximum) { response.destroy(); throw new ImagingError(503, "upstream_protocol_error"); }
      buffers.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(buffers).toString("utf8")) as unknown;
  } catch (error) { throw error instanceof ImagingError ? error : new ImagingError(503, "upstream_protocol_error"); }
}
function checkStatus(status: number, data: unknown): void {
  if ([200, 201, 202].includes(status)) return;
  if (![400, 404, 409, 413, 422, 429].includes(status)) throw new ImagingError(503, "unavailable");
  let error: Json;
  try { error = object(object(data).error); }
  catch { throw new ImagingError(503, "upstream_protocol_error"); }
  requireImaging(safeToken(error.code, 80), 503, "upstream_protocol_error");
  // Public messages come from our fixed dictionary, never from a remote path, stack or credential.
  throw new ImagingError(status, error.code, status === 429);
}
