import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

export interface BoundedJsonResponse<T> {
  value: T;
  bytes: Buffer;
  contentSha256: string;
  retryAfterSeconds: number | null;
}

export interface BoundedTextResponse {
  value: string;
  bytes: Buffer;
  contentSha256: string;
  retryAfterSeconds: number | null;
}

export interface ApprovedWebDocument {
  url: string;
  title: string;
  text: string;
  contentSha256: string;
  sizeBytes: number;
}

export interface ApprovedWebAddress {
  address: string;
  family: number;
}

export interface ApprovedWebPinnedResponse {
  statusCode: number;
  headers: import("node:http").IncomingHttpHeaders;
  bytes: Buffer;
}

export type ApprovedWebLookup = (
  hostname: string
) => Promise<readonly ApprovedWebAddress[]>;

export type ApprovedWebPinnedRequest = (input: {
  url: URL;
  address: string;
  family: number;
  signal: AbortSignal;
  timeoutMs: number;
  maximumBytes: number;
  userAgent: string;
}) => Promise<ApprovedWebPinnedResponse>;

export async function fetchBoundedJson<T>(input: {
  url: URL;
  signal: AbortSignal;
  timeoutMs: number;
  maximumBytes: number;
  headers?: Readonly<Record<string, string>>;
  method?: "GET" | "POST";
  body?: string;
  fetchImpl?: typeof fetch;
}): Promise<BoundedJsonResponse<T>> {
  validateHttpLimit(input.timeoutMs, "timeoutMs");
  validateHttpLimit(input.maximumBytes, "maximumBytes");
  if (input.url.protocol !== "https:") {
    throw new Error("External JSON adapters require HTTPS.");
  }
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(input.timeoutMs)
  ]);
  const response = await (input.fetchImpl ?? fetch)(input.url, {
    method: input.method ?? "GET",
    headers: {
      accept: "application/json",
      "accept-encoding": "identity",
      ...input.headers
    },
    body: input.body,
    redirect: "error",
    signal
  });
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
  if (!response.ok) {
    throw new ResearchHttpError(response.status, retryAfterSeconds);
  }
  const bytes = await readBoundedResponseBody(response.body, input.maximumBytes);
  let value: T;
  try {
    value = JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new ResearchExternalServiceError("invalid_payload");
  }
  return {
    value,
    bytes,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    retryAfterSeconds
  };
}

export async function fetchBoundedText(input: {
  url: URL;
  signal: AbortSignal;
  timeoutMs: number;
  maximumBytes: number;
  headers?: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
}): Promise<BoundedTextResponse> {
  validateHttpLimit(input.timeoutMs, "timeoutMs");
  validateHttpLimit(input.maximumBytes, "maximumBytes");
  if (input.url.protocol !== "https:") {
    throw new Error("External text adapters require HTTPS.");
  }
  const response = await (input.fetchImpl ?? fetch)(input.url, {
    method: "GET",
    headers: {
      accept: "application/xml, text/xml, text/plain",
      "accept-encoding": "identity",
      ...input.headers
    },
    redirect: "error",
    signal: AbortSignal.any([
      input.signal,
      AbortSignal.timeout(input.timeoutMs)
    ])
  });
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
  if (!response.ok) {
    throw new ResearchHttpError(response.status, retryAfterSeconds);
  }
  const bytes = await readBoundedResponseBody(response.body, input.maximumBytes);
  return {
    value: bytes.toString("utf8"),
    bytes,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    retryAfterSeconds
  };
}

export async function fetchApprovedWebDocument(input: {
  url: URL;
  allowedDomains: readonly string[];
  signal: AbortSignal;
  timeoutMs: number;
  maximumBytes: number;
  maximumRedirects?: number;
  userAgent: string;
  lookupImpl?: ApprovedWebLookup;
  requestPinnedAddressImpl?: ApprovedWebPinnedRequest;
}): Promise<ApprovedWebDocument> {
  validateHttpLimit(input.timeoutMs, "timeoutMs");
  validateHttpLimit(input.maximumBytes, "maximumBytes");
  if (!input.userAgent.trim()) {
    throw new Error("A non-empty User-Agent is required.");
  }
  const allowedDomains = normalizeAllowedDomains(input.allowedDomains);
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(input.timeoutMs)
  ]);
  const lookupImpl: ApprovedWebLookup =
    input.lookupImpl ??
    (async (hostname) =>
      await lookup(hostname, {
        all: true,
        verbatim: true
      }));
  const requestAddress =
    input.requestPinnedAddressImpl ?? requestPinnedAddress;
  let current = new URL(input.url.toString());
  const maximumRedirects = input.maximumRedirects ?? 3;
  if (
    !Number.isSafeInteger(maximumRedirects) ||
    maximumRedirects < 0 ||
    maximumRedirects > 5
  ) {
    throw new Error("maximumRedirects must be an integer from 0 to 5.");
  }
  for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
    validateApprovedUrl(current, allowedDomains);
    const addresses = await lookupImpl(current.hostname);
    if (
      addresses.length === 0 ||
      addresses.some(
        (item) =>
          isIP(item.address) !== item.family ||
          !isPublicResearchAddress(item.address)
      )
    ) {
      throw new Error("Approved source resolved to a non-public address.");
    }
    const orderedAddresses = [...addresses].sort(
      (left, right) =>
        addressFamilyPriority(left.family) -
        addressFamilyPriority(right.family)
    );
    let response: ApprovedWebPinnedResponse | null = null;
    let lastConnectionError: unknown = null;
    for (const selected of orderedAddresses) {
      try {
        response = await requestAddress({
          url: current,
          address: selected.address,
          family: selected.family,
          signal,
          timeoutMs: input.timeoutMs,
          maximumBytes: input.maximumBytes,
          userAgent: input.userAgent
        });
        break;
      } catch (error) {
        if (
          signal.aborted ||
          !isRetryableAddressConnectionError(error)
        ) {
          throw error;
        }
        lastConnectionError = error;
      }
    }
    if (response === null) {
      throw (
        lastConnectionError ??
        new Error("Approved source did not expose a reachable address.")
      );
    }
    if (isRedirect(response.statusCode)) {
      if (redirect === maximumRedirects) {
        throw new Error("Approved source exceeded the redirect limit.");
      }
      const location = response.headers.location;
      if (!location) {
        throw new Error("Approved source returned an invalid redirect.");
      }
      current = new URL(location, current);
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ResearchHttpError(
        response.statusCode,
        parseRetryAfter(response.headers["retry-after"])
      );
    }
    const contentType = String(response.headers["content-type"] ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (
      contentType !== "text/html" &&
      contentType !== "application/xhtml+xml" &&
      contentType !== "text/plain"
    ) {
      throw new Error("Approved source returned an unsupported content type.");
    }
    const contentEncoding = String(
      response.headers["content-encoding"] ?? "identity"
    ).trim().toLowerCase();
    if (contentEncoding !== "" && contentEncoding !== "identity") {
      throw new Error("Approved source ignored identity content encoding.");
    }
    const html = response.bytes.toString("utf8");
    const title =
      contentType === "text/plain"
        ? current.hostname
        : extractHtmlTitle(html) || current.hostname;
    const text =
      contentType === "text/plain" ? normalizeText(html) : htmlToText(html);
    if (!text) {
      throw new Error("Approved source did not contain readable text.");
    }
    return {
      url: current.toString(),
      title,
      text,
      contentSha256: createHash("sha256").update(response.bytes).digest("hex"),
      sizeBytes: response.bytes.length
    };
  }
  throw new Error("Approved source fetch invariant violation.");
}

export class ResearchHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly retryAfterSeconds: number | null
  ) {
    super(`External service returned HTTP ${statusCode}.`);
    this.name = "ResearchHttpError";
  }
}

export type ResearchExternalServiceErrorKind =
  | "invalid_payload"
  | "transport";

export class ResearchExternalServiceError extends Error {
  constructor(readonly kind: ResearchExternalServiceErrorKind) {
    super(`External service ${kind.replaceAll("_", " ")}.`);
    this.name = "ResearchExternalServiceError";
  }
}

async function requestPinnedAddress(input: {
  url: URL;
  address: string;
  family: number;
  signal: AbortSignal;
  timeoutMs: number;
  maximumBytes: number;
  userAgent: string;
}): Promise<ApprovedWebPinnedResponse> {
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(input.timeoutMs)
  ]);
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: input.address,
        port: input.url.port || 443,
        path: `${input.url.pathname}${input.url.search}`,
        method: "GET",
        family: input.family === 6 ? 6 : 4,
        headers: {
          accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
          "accept-encoding": "identity",
          host: input.url.host,
          "user-agent": input.userAgent
        },
        servername: input.url.hostname,
        signal
      },
      (response) => {
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > input.maximumBytes) {
            response.destroy(
              new Error("Approved source exceeded maximum response bytes.")
            );
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            bytes: Buffer.concat(chunks, size)
          });
        });
        response.on("error", reject);
      }
    );
    req.setTimeout(input.timeoutMs, () => {
      req.destroy(new Error("Approved source request timed out."));
    });
    req.on("error", reject);
    req.end();
  });
}

function addressFamilyPriority(family: number): number {
  return family === 4 ? 0 : 1;
}

function isRetryableAddressConnectionError(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error)
  ) {
    return false;
  }
  return new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ETIMEDOUT"
  ]).has(String(error.code));
}

export async function readBoundedResponseBody(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number
): Promise<Buffer> {
  if (!stream) {
    return Buffer.alloc(0);
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) {
        return Buffer.concat(chunks, size);
      }
      const chunk = Buffer.from(item.value);
      size += chunk.length;
      if (size > maximumBytes) {
        await reader.cancel("response byte limit exceeded");
        throw new Error("External service response exceeded the byte limit.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

function normalizeAllowedDomains(values: readonly string[]): string[] {
  if (values.length === 0 || values.length > 100) {
    throw new Error("At least one approved official domain is required.");
  }
  const normalized = values.map((value) =>
    value.trim().toLowerCase().replace(/^\./u, "")
  );
  if (
    normalized.some(
      (value) =>
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
          value
        )
    ) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error("Approved official domains are invalid or duplicated.");
  }
  return normalized;
}

function validateApprovedUrl(url: URL, allowedDomains: readonly string[]): void {
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443")
  ) {
    throw new Error("Approved source URL is not allowed.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    isIP(hostname) !== 0 ||
    !allowedDomains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    )
  ) {
    throw new Error("Approved source host is not allowlisted.");
  }
}

const blockedAddresses = createBlockedAddressLists();

export function isPublicResearchAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  return family === 4
    ? !blockedAddresses.ipv4.check(address, "ipv4")
    : !blockedAddresses.ipv6.check(address, "ipv6");
}

function createBlockedAddressLists(): {
  ipv4: BlockList;
  ipv6: BlockList;
} {
  const ipv4 = new BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ] as const) {
    ipv4.addSubnet(address, prefix, "ipv4");
  }
  const ipv6 = new BlockList();
  for (const [address, prefix] of [
    ["::", 96],
    ["::1", 128],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["100:0:0:1::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["5f00::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8]
  ] as const) {
    ipv6.addSubnet(address, prefix, "ipv6");
  }
  return { ipv4, ipv6 };
}

function isRedirect(statusCode: number): boolean {
  return (
    statusCode === 301 ||
    statusCode === 302 ||
    statusCode === 303 ||
    statusCode === 307 ||
    statusCode === 308
  );
}

function parseRetryAfter(value: string | string[] | null | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return null;
  }
  if (/^[0-9]+$/u.test(raw)) {
    return Math.min(Number(raw), 300);
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    return null;
  }
  return Math.max(0, Math.min(300, Math.ceil((at - Date.now()) / 1_000)));
}

function extractHtmlTitle(html: string): string {
  const lower = html.toLowerCase();
  let openingAt = lower.indexOf("<title");
  while (openingAt >= 0) {
    const boundary = lower[openingAt + 6];
    if (!boundary || !/[a-z0-9_]/u.test(boundary)) {
      const openingEnd = lower.indexOf(">", openingAt + 6);
      if (openingEnd < 0) {
        return "";
      }
      const closingAt = lower.indexOf("</title>", openingEnd + 1);
      if (closingAt < 0) {
        return "";
      }
      return normalizeText(
        decodeHtmlEntities(html.slice(openingEnd + 1, closingAt))
      ).slice(0, 300);
    }
    openingAt = lower.indexOf("<title", openingAt + 6);
  }
  return "";
}

function htmlToText(html: string): string {
  return normalizeText(
    decodeHtmlEntities(stripHtmlMarkup(html))
  ).slice(0, 200_000);
}

function stripHtmlMarkup(html: string): string {
  const lower = html.toLowerCase();
  const unsafeTags = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas"
  ]);
  let cursor = 0;
  let output = "";
  for (;;) {
    const openingAt = html.indexOf("<", cursor);
    if (openingAt < 0) {
      return output + html.slice(cursor);
    }
    output += `${html.slice(cursor, openingAt)} `;
    if (lower.startsWith("<!--", openingAt)) {
      const closingAt = lower.indexOf("-->", openingAt + 4);
      if (closingAt < 0) {
        return output;
      }
      cursor = closingAt + 3;
      continue;
    }
    const openingEnd = html.indexOf(">", openingAt + 1);
    if (openingEnd < 0) {
      return output;
    }
    const tagText = lower
      .slice(openingAt + 1, Math.min(openingEnd, openingAt + 80))
      .trimStart();
    const tag = /^[a-z][a-z0-9]*/u.exec(tagText)?.[0];
    if (!tag || !unsafeTags.has(tag)) {
      cursor = openingEnd + 1;
      continue;
    }
    const closingNeedle = `</${tag}`;
    let closingAt = lower.indexOf(closingNeedle, openingEnd + 1);
    while (
      closingAt >= 0 &&
      !/[\s>]/u.test(lower[closingAt + closingNeedle.length] ?? "")
    ) {
      closingAt = lower.indexOf(
        closingNeedle,
        closingAt + closingNeedle.length
      );
    }
    if (closingAt < 0) {
      return output;
    }
    const closingEnd = html.indexOf(">", closingAt + closingNeedle.length);
    if (closingEnd < 0) {
      return output;
    }
    cursor = closingEnd + 1;
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#([0-9]+);/gu, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    );
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function validateHttpLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}
