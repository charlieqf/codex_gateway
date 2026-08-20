import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  compareStrictSemVer,
  desktopVersionGateError,
  isDesktopVersionGatePath,
  resolveDesktopVersionGate,
  type DesktopVersionGate
} from "./desktop-version-gate.js";

const gate: DesktopVersionGate = {
  enabled: true,
  minimumVersion: "9.9.9-fixture.1",
  downloadUrl: "https://updates.example/medevidence.exe"
};

describe("Desktop version gate", () => {
  it("uses strict SemVer including prerelease precedence", () => {
    expect(compareStrictSemVer("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareStrictSemVer("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
    expect(compareStrictSemVer("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareStrictSemVer("1.0.0+build.2", "1.0.0+build.1")).toBe(0);
    expect(compareStrictSemVer("01.0.0", "1.0.0")).toBe(-1);
  });

  it("fails missing, malformed and old versions closed", () => {
    expect(desktopVersionGateError(requestWithVersion(), gate)?.code).toBe(
      "client_upgrade_required"
    );
    expect(
      desktopVersionGateError(requestWithVersion("not-semver"), gate)?.code
    ).toBe("client_upgrade_required");
    expect(
      desktopVersionGateError(requestWithVersion("9.9.9-fixture.0"), gate)?.code
    ).toBe("client_upgrade_required");
    expect(
      desktopVersionGateError(requestWithVersion("9.9.9-fixture.1"), gate)
    ).toBeNull();
    expect(desktopVersionGateError(requestWithVersion("9.9.9"), gate)).toBeNull();
  });

  it("exempts only explicit service and operator credentials", () => {
    expect(
      desktopVersionGateError(requestWithVersion(), gate, "service")
    ).toBeNull();
    expect(
      desktopVersionGateError(requestWithVersion(), gate, "operator")
    ).toBeNull();
    expect(
      desktopVersionGateError(requestWithVersion(), gate, "unknown")?.code
    ).toBe("client_upgrade_required");
    expect(
      desktopVersionGateError(requestWithVersion(), gate, "desktop")?.code
    ).toBe("client_upgrade_required");
  });

  it("covers every contracted Desktop route including Vision Assets", () => {
    const covered: Array<[string, string]> = [
      ["POST", "/gateway/auth/v1/login/start"],
      ["POST", "/gateway/auth/v1/token/refresh"],
      ["POST", "/gateway/auth/v1/logout"],
      ["POST", "/gateway/auth/v1/session/bootstrap"],
      ["POST", "/gateway/unified-keys/resolve"],
      ["GET", "/gateway/credentials/current"],
      ["GET", "/gateway/account/v1/current"],
      ["POST", "/v1/chat/completions"],
      ["POST", "/gateway/research/v1/doctor-runs"],
      ["POST", "/gateway/images/generations"],
      ["POST", "/gateway/vision/assets"],
      ["POST", "/gateway/vision/assets/asset-1/complete"],
      ["POST", "/gateway/vision/assets/asset-1/read-url"],
      ["DELETE", "/gateway/vision/assets/asset-1"]
    ];
    for (const [method, path] of covered) {
      expect(isDesktopVersionGatePath(method, path), `${method} ${path}`).toBe(
        true
      );
    }
    expect(
      isDesktopVersionGatePath("PUT", "https://r2.example/private-upload")
    ).toBe(false);
    expect(
      isDesktopVersionGatePath("GET", "/gateway/auth/v1/login/start")
    ).toBe(false);
    expect(
      isDesktopVersionGatePath("POST", "/gateway/credentials/current")
    ).toBe(false);
  });

  it("rejects invalid enable configuration", () => {
    expect(() =>
      resolveDesktopVersionGate({
        GATEWAY_DESKTOP_VERSION_GATE: "enabled",
        GATEWAY_MINIMUM_DESKTOP_VERSION: "1.0",
        GATEWAY_DESKTOP_DOWNLOAD_URL: "https://updates.example/app.exe"
      })
    ).toThrow("strict SemVer");
    expect(() =>
      resolveDesktopVersionGate({
        GATEWAY_DESKTOP_VERSION_GATE: "enabled",
        GATEWAY_MINIMUM_DESKTOP_VERSION: "1.0.0",
        GATEWAY_DESKTOP_DOWNLOAD_URL: "http://updates.example/app.exe"
      })
    ).toThrow("absolute HTTPS URL");
  });
});

function requestWithVersion(version?: string): FastifyRequest {
  return {
    headers: version
      ? { "x-medevidence-client-version": version }
      : {}
  } as FastifyRequest;
}
