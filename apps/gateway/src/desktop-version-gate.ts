import type { FastifyReply, FastifyRequest } from "fastify";
import type { CredentialClass, PhoneAuthMode } from "@codex-gateway/core";
import { markGatewayError } from "./http/observation.js";
import { GatewayError } from "@codex-gateway/core";

export const desktopVersionHeader = "x-medevidence-client-version";

export type DesktopVersionGateMode = "disabled" | "auth_only" | "all";

export interface DesktopVersionGate {
  mode: DesktopVersionGateMode;
  minimumVersion: string | null;
  downloadUrl: string | null;
}

interface ParsedSemVer {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string[];
}

const semVerPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const phoneSessionRouteKeys = new Set([
  "POST /gateway/auth/v1/login/start",
  "POST /gateway/auth/v1/token/refresh",
  "POST /gateway/auth/v1/logout",
  "POST /gateway/auth/v1/session/bootstrap",
  "GET /gateway/account/v1/current"
]);

export function resolveDesktopVersionGate(
  env: NodeJS.ProcessEnv
): DesktopVersionGate {
  const mode = env.GATEWAY_DESKTOP_VERSION_GATE?.trim() || "disabled";
  if (mode !== "disabled" && mode !== "auth_only" && mode !== "all") {
    throw new Error(
      "GATEWAY_DESKTOP_VERSION_GATE must be disabled, auth_only or all; the legacy enabled value is invalid."
    );
  }
  if (mode === "disabled") {
    return { mode, minimumVersion: null, downloadUrl: null };
  }

  const minimumVersion = env.GATEWAY_MINIMUM_DESKTOP_VERSION?.trim() ?? "";
  if (!parseStrictSemVer(minimumVersion)) {
    throw new Error(
      "GATEWAY_MINIMUM_DESKTOP_VERSION must be a strict SemVer when the Desktop version gate is auth_only or all."
    );
  }
  const downloadUrl = env.GATEWAY_DESKTOP_DOWNLOAD_URL?.trim() ?? "";
  if (!isAbsoluteHttpsUrl(downloadUrl)) {
    throw new Error(
      "GATEWAY_DESKTOP_DOWNLOAD_URL must be an absolute HTTPS URL when the Desktop version gate is auth_only or all."
    );
  }
  return { mode, minimumVersion, downloadUrl };
}

export function assertPhoneAuthVersionGateCompatibility(
  phoneAuthMode: PhoneAuthMode,
  versionGateMode: DesktopVersionGateMode
): void {
  if (phoneAuthMode === "transition" && versionGateMode !== "auth_only") {
    throw new Error(
      "Phone auth transition mode requires GATEWAY_DESKTOP_VERSION_GATE=auth_only."
    );
  }
}

export function desktopVersionGateError(
  request: FastifyRequest,
  gate: DesktopVersionGate,
  credentialClass?: CredentialClass
): GatewayError | null {
  if (
    !shouldGateDesktopRoute(gate.mode, request.method, request.url) ||
    (gate.mode === "all" && isVersionGateExempt(credentialClass))
  ) {
    return null;
  }
  const received = request.headers[desktopVersionHeader];
  const version = typeof received === "string" ? received : null;
  if (
    !version ||
    !gate.minimumVersion ||
    compareStrictSemVer(version, gate.minimumVersion) < 0
  ) {
    return new GatewayError({
      code: "client_upgrade_required",
      message: "A newer MedEvidence Desktop version is required.",
      httpStatus: 426
    });
  }
  return null;
}

export function sendDesktopVersionGateError(
  request: FastifyRequest,
  reply: FastifyReply,
  gate: DesktopVersionGate,
  error: GatewayError
): FastifyReply {
  markGatewayError(request, error);
  applyPrivateResponseHeaders(reply);
  return reply.code(426).send({
    error: {
      code: error.code,
      message: error.message,
      request_id: request.id,
      minimum_version: gate.minimumVersion,
      download_url: gate.downloadUrl
    }
  });
}

export function shouldGateDesktopRoute(
  mode: DesktopVersionGateMode,
  method: string,
  url: string
): boolean {
  if (mode === "disabled") {
    return false;
  }
  if (isPhoneSessionRoute(method, url)) {
    return true;
  }
  if (mode === "auth_only") {
    return false;
  }
  return isAllDesktopVersionGateRoute(method, url);
}

export function isPhoneSessionRoute(method: string, url: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const path = url.split("?", 1)[0] ?? url;
  return phoneSessionRouteKeys.has(`${normalizedMethod} ${path}`);
}

function isAllDesktopVersionGateRoute(method: string, url: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const path = url.split("?", 1)[0] ?? url;
  if (
    (normalizedMethod === "POST" &&
      path === "/gateway/unified-keys/resolve") ||
    (normalizedMethod === "GET" &&
      path === "/gateway/credentials/current") ||
    path.startsWith("/v1/") ||
    path.startsWith("/gateway/research/v1/")
  ) {
    return true;
  }
  if (
    normalizedMethod === "POST" &&
    path === "/gateway/images/generations"
  ) {
    return true;
  }
  return isVisionAssetOperation(normalizedMethod, path);
}

export function applyPrivateResponseHeaders(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store").header("pragma", "no-cache");
}

export function compareStrictSemVer(left: string, right: string): number {
  const a = parseStrictSemVer(left);
  const b = parseStrictSemVer(right);
  if (!a || !b) {
    return -1;
  }
  for (const field of ["major", "minor", "patch"] as const) {
    if (a[field] !== b[field]) {
      return a[field] < b[field] ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length
      ? 0
      : a.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined || bPart === undefined) {
      return aPart === bPart ? 0 : aPart === undefined ? -1 : 1;
    }
    if (aPart === bPart) {
      continue;
    }
    const aNumeric = /^[0-9]+$/u.test(aPart);
    const bNumeric = /^[0-9]+$/u.test(bPart);
    if (aNumeric && bNumeric) {
      return BigInt(aPart) < BigInt(bPart) ? -1 : 1;
    }
    if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    }
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

export function isStrictSemVer(value: string): boolean {
  return parseStrictSemVer(value) !== null;
}

function parseStrictSemVer(value: string): ParsedSemVer | null {
  const match = semVerPattern.exec(value);
  if (!match) {
    return null;
  }
  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease: match[4]?.split(".") ?? []
  };
}

function isVersionGateExempt(value: CredentialClass | undefined): boolean {
  return value === "service" || value === "operator";
}

function isVisionAssetOperation(method: string, path: string): boolean {
  if (method === "POST" && path === "/gateway/vision/assets") {
    return true;
  }
  if (method === "DELETE" && /^\/gateway\/vision\/assets\/[^/]+$/u.test(path)) {
    return true;
  }
  return (
    method === "POST" &&
    /^\/gateway\/vision\/assets\/[^/]+\/(?:complete|read-url)$/u.test(path)
  );
}

function isAbsoluteHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}
