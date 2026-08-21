import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  assertPhoneAuthVersionGateCompatibility,
  compareStrictSemVer,
  desktopVersionGateError,
  isPhoneSessionRoute,
  resolveDesktopVersionGate,
  shouldGateDesktopRoute,
  type DesktopVersionGate
} from "./desktop-version-gate.js";

const gate: DesktopVersionGate = {
  mode: "all",
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
    expect(
      desktopVersionGateError(
        requestWithVersion(),
        { ...gate, mode: "auth_only" },
        "service"
      )?.code
    ).toBe("client_upgrade_required");
  });

  it("uses one route policy source for disabled, auth_only and all", () => {
    const phoneRoutes: Array<[string, string]> = [
      ["POST", "/gateway/auth/v1/login/start"],
      ["POST", "/gateway/auth/v1/token/refresh"],
      ["POST", "/gateway/auth/v1/logout"],
      ["POST", "/gateway/auth/v1/session/bootstrap"],
      ["GET", "/gateway/account/v1/current"]
    ];
    const covered: Array<[string, string]> = [
      ...phoneRoutes,
      ["POST", "/gateway/unified-keys/resolve"],
      ["GET", "/gateway/credentials/current"],
      ["POST", "/v1/chat/completions"],
      ["POST", "/gateway/research/v1/doctor-runs"],
      ["POST", "/gateway/images/generations"],
      ["POST", "/gateway/vision/assets"],
      ["POST", "/gateway/vision/assets/asset-1/complete"],
      ["POST", "/gateway/vision/assets/asset-1/read-url"],
      ["DELETE", "/gateway/vision/assets/asset-1"]
    ];
    for (const [method, path] of covered) {
      expect(
        shouldGateDesktopRoute("disabled", method, path),
        `disabled ${method} ${path}`
      ).toBe(false);
      expect(
        shouldGateDesktopRoute("all", method, path),
        `all ${method} ${path}`
      ).toBe(true);
    }
    for (const [method, path] of phoneRoutes) {
      expect(isPhoneSessionRoute(method, path), `${method} ${path}`).toBe(true);
      expect(
        shouldGateDesktopRoute("auth_only", method, path),
        `auth_only ${method} ${path}`
      ).toBe(true);
    }
    for (const [method, path] of covered.slice(phoneRoutes.length)) {
      expect(
        shouldGateDesktopRoute("auth_only", method, path),
        `auth_only ${method} ${path}`
      ).toBe(false);
    }
    expect(
      shouldGateDesktopRoute(
        "all",
        "PUT",
        "https://r2.example/private-upload"
      )
    ).toBe(false);
    expect(
      shouldGateDesktopRoute("all", "GET", "/gateway/auth/v1/login/start")
    ).toBe(false);
    expect(
      shouldGateDesktopRoute("all", "POST", "/gateway/credentials/current")
    ).toBe(false);
  });

  it("accepts only disabled, auth_only and all configuration", () => {
    expect(resolveDesktopVersionGate({})).toEqual({
      mode: "disabled",
      minimumVersion: null,
      downloadUrl: null
    });
    for (const mode of ["auth_only", "all"]) {
      expect(
        resolveDesktopVersionGate({
          GATEWAY_DESKTOP_VERSION_GATE: mode,
          GATEWAY_MINIMUM_DESKTOP_VERSION: "2.0.0-beta.40",
          GATEWAY_DESKTOP_DOWNLOAD_URL: "https://updates.example/app.exe"
        }).mode
      ).toBe(mode);
    }
    expect(() =>
      resolveDesktopVersionGate({
        GATEWAY_DESKTOP_VERSION_GATE: "enabled",
        GATEWAY_MINIMUM_DESKTOP_VERSION: "2.0.0-beta.40",
        GATEWAY_DESKTOP_DOWNLOAD_URL: "https://updates.example/app.exe"
      })
    ).toThrow("legacy enabled value is invalid");
    expect(() =>
      resolveDesktopVersionGate({ GATEWAY_DESKTOP_VERSION_GATE: "unknown" })
    ).toThrow("disabled, auth_only or all");
    expect(() =>
      resolveDesktopVersionGate({
        GATEWAY_DESKTOP_VERSION_GATE: "auth_only",
        GATEWAY_MINIMUM_DESKTOP_VERSION: "1.0",
        GATEWAY_DESKTOP_DOWNLOAD_URL: "https://updates.example/app.exe"
      })
    ).toThrow("strict SemVer");
    expect(() =>
      resolveDesktopVersionGate({
        GATEWAY_DESKTOP_VERSION_GATE: "all",
        GATEWAY_MINIMUM_DESKTOP_VERSION: "1.0.0",
        GATEWAY_DESKTOP_DOWNLOAD_URL: "http://updates.example/app.exe"
      })
    ).toThrow("absolute HTTPS URL");
  });

  it("accepts transition only with auth_only before startup", () => {
    expect(() =>
      assertPhoneAuthVersionGateCompatibility("transition", "auth_only")
    ).not.toThrow();
    for (const mode of ["disabled", "all"] as const) {
      expect(() =>
        assertPhoneAuthVersionGateCompatibility("transition", mode)
      ).toThrow("GATEWAY_DESKTOP_VERSION_GATE=auth_only");
    }
    for (const mode of ["disabled", "auth_only", "all"] as const) {
      expect(() =>
        assertPhoneAuthVersionGateCompatibility("disabled", mode)
      ).not.toThrow();
    }
  });
});

function requestWithVersion(
  version?: string,
  method = "POST",
  url = "/gateway/auth/v1/login/start"
): FastifyRequest {
  return {
    method,
    url,
    headers: version
      ? { "x-medevidence-client-version": version }
      : {}
  } as FastifyRequest;
}
