#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [mode, handoffPath] = process.argv.slice(2);
if (!new Set(["legacy", "research", "phone"]).has(mode) || !handoffPath) {
  console.error(
    "usage: node scripts/r760-dual-track-phone-auth-canary.mjs <legacy|research|phone> <protected-handoff.json>"
  );
  process.exit(2);
}

const handoff = JSON.parse(await readFile(handoffPath, "utf8"));
const opaqueKey = requiredString(handoff.key, "handoff key");
const expectedSubjectId = requiredString(handoff.subject_id, "handoff subject_id");
const baseUrl = requiredString(handoff.base_url, "handoff base_url").replace(/\/$/u, "");
if (!opaqueKey.startsWith("cgu_live_") || !baseUrl.startsWith("https://")) {
  throw new Error("protected handoff has an unexpected shape");
}

const evidence = [];
let gatewayKey = null;
let researchRunId = null;
let visionAssetId = null;
let phoneIdentityDisabled = false;

try {
  const resolved = await requestJson({
    name: "resolver",
    method: "POST",
    url: `${baseUrl}/gateway/unified-keys/resolve`,
    bearer: opaqueKey,
    body: {}
  });
  assertStatus(resolved, 200);
  if (resolved.json?.valid !== true || resolved.json?.subject?.id !== expectedSubjectId) {
    throw new Error("resolver returned an inconsistent subject");
  }
  gatewayKey = requiredString(resolved.json?.codex_gateway?.api_key, "resolved gateway key");
  evidence.push(record("resolver", resolved));

  const current = await requestJson({
    name: "credentials_current",
    method: "GET",
    url: `${baseUrl}/gateway/credentials/current`,
    bearer: gatewayKey
  });
  assertStatus(current, 200);
  if (current.json?.valid !== true || current.json?.subject?.id !== expectedSubjectId) {
    throw new Error("credentials/current returned an inconsistent subject");
  }
  evidence.push(record("credentials_current", current));

  if (mode === "phone") {
    const phone = requiredSyntheticPhone(process.env.PHONE_AUTH_CANARY_PHONE);
    const billingToken = requiredString(
      process.env.GATEWAY_BILLING_ADMIN_TOKEN,
      "GATEWAY_BILLING_ADMIN_TOKEN"
    );
    const versionHeader = { "X-MedEvidence-Client-Version": "2.0.0-beta.40" };
    const loginBody = {
      phone,
      client: "medevidence-desktop",
      device_id: "r760-phone-auth-canary-device-01",
      contract_version: 1
    };

    for (const test of [
      { name: "upgrade_missing", headers: {} },
      { name: "upgrade_invalid", headers: { "X-MedEvidence-Client-Version": "not-semver" } },
      { name: "upgrade_low", headers: { "X-MedEvidence-Client-Version": "2.0.0-beta.39" } }
    ]) {
      const result = await requestJson({
        name: test.name,
        method: "POST",
        url: `${baseUrl}/gateway/auth/v1/login/start`,
        headers: test.headers,
        body: loginBody
      });
      assertError(result, 426, "client_upgrade_required");
      if (
        result.json?.error?.minimum_version !== "2.0.0-beta.40" ||
        result.json?.error?.download_url !==
          "https://updates.instmarket.com.au/desktop-updates/beta/medevidence-desktop-win-x64.exe"
      ) {
        throw new Error(`${test.name} returned an inconsistent upgrade contract`);
      }
      evidence.push({ ...record(test.name, result), error_code: "client_upgrade_required" });
    }

    const login = await requestJson({
      name: "phone_login",
      method: "POST",
      url: `${baseUrl}/gateway/auth/v1/login/start`,
      headers: versionHeader,
      body: loginBody
    });
    assertStatus(login, 200);
    assertAuthenticated(login, expectedSubjectId);
    const firstAccess = requiredString(login.json?.access_token, "login access_token");
    const firstRefresh = requiredString(login.json?.refresh_token, "login refresh_token");
    evidence.push(record("phone_login", login));

    const bootstrap = await requestJson({
      name: "bootstrap",
      method: "POST",
      url: `${baseUrl}/gateway/auth/v1/session/bootstrap`,
      bearer: firstAccess,
      headers: versionHeader,
      body: {}
    });
    assertStatus(bootstrap, 200);
    if (
      bootstrap.json?.subject?.id !== expectedSubjectId ||
      bootstrap.json?.unified_key?.key !== opaqueKey
    ) {
      throw new Error("bootstrap did not preserve the Subject and unified key");
    }
    evidence.push(record("bootstrap", bootstrap));

    const account = await requestJson({
      name: "account_current",
      method: "GET",
      url: `${baseUrl}/gateway/account/v1/current`,
      bearer: firstAccess,
      headers: versionHeader
    });
    assertStatus(account, 200);
    if (
      account.json?.subject?.id !== expectedSubjectId ||
      account.json?.identity?.plan_id !== handoff.plan_id ||
      JSON.stringify(account.json?.capabilities) !== JSON.stringify(handoff.capabilities)
    ) {
      throw new Error("account/current changed Subject, Plan, or capabilities");
    }
    evidence.push(record("account_current", account));

    const refreshed = await requestJson({
      name: "refresh",
      method: "POST",
      url: `${baseUrl}/gateway/auth/v1/token/refresh`,
      headers: versionHeader,
      body: {
        refresh_token: firstRefresh,
        client: "medevidence-desktop",
        device_id: loginBody.device_id,
        contract_version: 1
      }
    });
    assertStatus(refreshed, 200);
    assertAuthenticated(refreshed, expectedSubjectId);
    const secondAccess = requiredString(refreshed.json?.access_token, "refresh access_token");
    const secondRefresh = requiredString(refreshed.json?.refresh_token, "rotated refresh_token");
    if (secondRefresh === firstRefresh) throw new Error("refresh token did not rotate");
    evidence.push({ ...record("refresh", refreshed), rotated: true });

    const replay = await requestJson({
      name: "refresh_replay",
      method: "POST",
      url: `${baseUrl}/gateway/auth/v1/token/refresh`,
      headers: versionHeader,
      body: {
        refresh_token: firstRefresh,
        client: "medevidence-desktop",
        device_id: loginBody.device_id,
        contract_version: 1
      }
    });
    assertError(replay, 401, "refresh_token_invalid");
    evidence.push({ ...record("refresh_replay", replay), error_code: "refresh_token_invalid" });

    const logout = await requestJson({
      name: "logout",
      method: "POST",
      url: `${baseUrl}/gateway/auth/v1/logout`,
      bearer: secondAccess,
      headers: versionHeader,
      body: {}
    });
    assertStatus(logout, 204);
    evidence.push(record("logout", logout));

    const postLogoutRefresh = await requestJson({
      name: "post_logout_refresh",
      method: "POST",
      url: `${baseUrl}/gateway/auth/v1/token/refresh`,
      headers: versionHeader,
      body: {
        refresh_token: secondRefresh,
        client: "medevidence-desktop",
        device_id: loginBody.device_id,
        contract_version: 1
      }
    });
    assertError(postLogoutRefresh, 401, "refresh_token_invalid");
    evidence.push({
      ...record("post_logout_refresh", postLogoutRefresh),
      error_code: "refresh_token_invalid"
    });

    const legacyAfterLogout = await resolveLegacy("legacy_after_logout", opaqueKey);
    evidence.push(record("legacy_after_logout", legacyAfterLogout));

    const secondLogin = await requestJson({
      name: "second_phone_login",
      method: "POST",
      url: `${baseUrl}/gateway/auth/v1/login/start`,
      headers: versionHeader,
      body: { ...loginBody, device_id: "r760-phone-auth-canary-device-02" }
    });
    assertStatus(secondLogin, 200);
    assertAuthenticated(secondLogin, expectedSubjectId);
    const disableProbeRefresh = requiredString(
      secondLogin.json?.refresh_token,
      "second login refresh_token"
    );
    evidence.push(record("second_phone_login", secondLogin));

    const disabled = await setPhoneIdentity("disabled", billingToken);
    assertStatus(disabled, 200);
    phoneIdentityDisabled = true;
    evidence.push(record("identity_disable", disabled));

    const disabledLogin = await requestJson({
      name: "disabled_phone_login",
      method: "POST",
      url: `${baseUrl}/gateway/auth/v1/login/start`,
      headers: versionHeader,
      body: { ...loginBody, device_id: "r760-phone-auth-canary-device-03" }
    });
    assertError(disabledLogin, 403, "phone_login_disabled");
    evidence.push({
      ...record("disabled_phone_login", disabledLogin),
      error_code: "phone_login_disabled"
    });

    const disabledRefresh = await requestJson({
      name: "disabled_identity_refresh",
      method: "POST",
      url: `${baseUrl}/gateway/auth/v1/token/refresh`,
      headers: versionHeader,
      body: {
        refresh_token: disableProbeRefresh,
        client: "medevidence-desktop",
        device_id: "r760-phone-auth-canary-device-02",
        contract_version: 1
      }
    });
    assertError(disabledRefresh, 401, "refresh_token_invalid");
    evidence.push({
      ...record("disabled_identity_refresh", disabledRefresh),
      error_code: "refresh_token_invalid"
    });

    const legacyAfterDisable = await resolveLegacy("legacy_after_identity_disable", opaqueKey);
    const currentAfterDisable = await requestJson({
      name: "credentials_after_identity_disable",
      method: "GET",
      url: `${baseUrl}/gateway/credentials/current`,
      bearer: gatewayKey
    });
    assertStatus(currentAfterDisable, 200);
    if (currentAfterDisable.json?.subject?.id !== expectedSubjectId) {
      throw new Error("identity disable changed the legacy credential Subject");
    }
    evidence.push(record("legacy_after_identity_disable", legacyAfterDisable));
    evidence.push(record("credentials_after_identity_disable", currentAfterDisable));

    process.stdout.write(
      `${JSON.stringify({
        mode,
        evidence,
        invariants: {
          subject_match: true,
          bootstrap_reused_same_unified_key: true,
          refresh_rotated: true,
          replay_rejected: true,
          logout_revoked_phone_session_only: true,
          identity_disable_revoked_phone_session_only: true,
          legacy_key_survived_logout_replay_and_identity_disable: true,
          plan_id: handoff.plan_id,
          capabilities: handoff.capabilities
        },
        sensitive_values_emitted: false
      })}\n`
    );
    process.exit(0);
  }

  if (mode === "research") {
    const created = await requestJson({
      name: "research_create",
      method: "POST",
      url: `${baseUrl}/gateway/research/v1/doctor-runs`,
      bearer: gatewayKey,
      headers: { "Idempotency-Key": `research:phone-auth-canary:${Date.now()}` },
      body: {
        name: "Gateway Canary Doctor",
        hospital: "Gateway Canary Hospital",
        department: "Compatibility",
        mode: "brief",
        language: "en",
        client_reference: "r760-phone-auth-canary"
      },
      timeoutMs: 60_000
    });
    assertStatus(created, 202);
    researchRunId = requiredString(created.json?.run_id, "research run_id");
    evidence.push(record("research_create", created));

    const status = await requestJson({
      name: "research_status",
      method: "GET",
      url: `${baseUrl}/gateway/research/v1/doctor-runs/${encodeURIComponent(researchRunId)}`,
      bearer: gatewayKey
    });
    assertStatus(status, 200);
    evidence.push(record("research_status", status));
    await cancelResearch();
    process.stdout.write(`${JSON.stringify({ mode, evidence, cleanup: "ok" })}\n`);
    process.exit(0);
  }

  const models = await requestJson({
    name: "models",
    method: "GET",
    url: `${baseUrl}/v1/models`,
    bearer: gatewayKey
  });
  assertStatus(models, 200);
  evidence.push(record("models", models));

  const chat = await requestJson({
    name: "chat",
    method: "POST",
    url: `${baseUrl}/v1/chat/completions`,
    bearer: gatewayKey,
    body: {
      model: "goldencode",
      messages: [{ role: "user", content: "Reply exactly: gateway-phone-auth-canary-ok" }]
    },
    timeoutMs: 180_000
  });
  assertStatus(chat, 200);
  if (!chat.json?.choices?.[0]?.message) {
    throw new Error("chat response is missing a choice");
  }
  evidence.push(record("chat", chat));

  const tools = await requestJson({
    name: "tools",
    method: "POST",
    url: `${baseUrl}/v1/chat/completions`,
    bearer: gatewayKey,
    body: {
      model: "goldencode",
      messages: [
        {
          role: "user",
          content: "Call the compatibility_probe tool once before answering."
        }
      ],
      tool_choice: "required",
      tools: [
        {
          type: "function",
          function: {
            name: "compatibility_probe",
            description: "Return the compatibility status.",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false
            }
          }
        }
      ]
    },
    timeoutMs: 180_000
  });
  assertStatus(tools, 200);
  if (tools.json?.choices?.[0]?.finish_reason !== "tool_calls") {
    throw new Error("tools response did not request a tool call");
  }
  evidence.push(record("tools", tools));

  const image = await requestJson({
    name: "image_generation",
    method: "POST",
    url: `${baseUrl}/gateway/images/generations`,
    bearer: gatewayKey,
    body: {
      model: "medcode-image-default",
      prompt: "A plain blue circle on a white background, flat medical app test icon.",
      size: "1024x1024",
      quality: "low",
      output_format: "jpeg",
      metadata: { client: "r760-phone-auth-canary" }
    },
    timeoutMs: 240_000
  });
  if (
    image.status === 429 &&
    image.json?.error?.code === "rate_limited" &&
    image.json?.error?.rate_limit_origin === "upstream"
  ) {
    evidence.push({
      ...record("image_generation", image),
      result: "upstream_rate_limited"
    });
  } else {
    assertStatus(image, 200);
    if (!String(image.json?.id ?? "").startsWith("imgreq_") ||
        String(image.json?.data?.[0]?.b64_json ?? "").length < 100) {
      throw new Error("image response did not contain an image");
    }
    evidence.push({ ...record("image_generation", image), result: "ok" });
  }

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const visionCreate = await requestJson({
    name: "vision_create",
    method: "POST",
    url: `${baseUrl}/gateway/vision/assets`,
    bearer: gatewayKey,
    body: {
      content_type: "image/png",
      size_bytes: png.length,
      sha256: createHash("sha256").update(png).digest("hex")
    }
  });
  assertStatus(visionCreate, 201);
  visionAssetId = requiredString(visionCreate.json?.asset_id, "vision asset_id");
  const uploadUrl = requiredString(visionCreate.json?.upload?.url, "vision upload URL");
  evidence.push(record("vision_create", visionCreate));

  let upload;
  try {
    upload = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/png", "If-None-Match": "*" },
      body: png,
      signal: AbortSignal.timeout(60_000)
    });
  } catch {
    throw new Error("vision upload request failed");
  }
  if (upload.status !== 200) {
    throw new Error(`vision upload returned HTTP ${upload.status}`);
  }
  evidence.push({ name: "vision_upload", status: upload.status, request_id: "not_applicable" });

  const visionComplete = await requestJson({
    name: "vision_complete",
    method: "POST",
    url: `${baseUrl}/gateway/vision/assets/${encodeURIComponent(visionAssetId)}/complete`,
    bearer: gatewayKey,
    body: {}
  });
  assertStatus(visionComplete, 200);
  if (visionComplete.json?.state !== "ready") {
    throw new Error("vision complete did not return ready");
  }
  evidence.push(record("vision_complete", visionComplete));

  const visionRead = await requestJson({
    name: "vision_read_url",
    method: "POST",
    url: `${baseUrl}/gateway/vision/assets/${encodeURIComponent(visionAssetId)}/read-url`,
    bearer: gatewayKey,
    body: {}
  });
  assertStatus(visionRead, 200);
  if (!String(visionRead.json?.image_url ?? "").startsWith("https://")) {
    throw new Error("vision read-url did not return an HTTPS URL");
  }
  evidence.push(record("vision_read_url", visionRead));

  await deleteVision();
  process.stdout.write(`${JSON.stringify({ mode, evidence, cleanup: "ok" })}\n`);
} catch (error) {
  await Promise.allSettled([
    cancelResearch(),
    deleteVision(),
    mode === "phone" && !phoneIdentityDisabled && process.env.GATEWAY_BILLING_ADMIN_TOKEN
      ? setPhoneIdentity("disabled", process.env.GATEWAY_BILLING_ADMIN_TOKEN)
      : Promise.resolve()
  ]);
  console.error(`canary_error=${safeError(error)}`);
  process.exitCode = 1;
}

async function resolveLegacy(name, token) {
  const resolved = await requestJson({
    name,
    method: "POST",
    url: `${baseUrl}/gateway/unified-keys/resolve`,
    bearer: token,
    body: {}
  });
  assertStatus(resolved, 200);
  if (resolved.json?.valid !== true || resolved.json?.subject?.id !== expectedSubjectId) {
    throw new Error(`${name} returned an inconsistent Subject`);
  }
  return resolved;
}

async function setPhoneIdentity(state, billingToken) {
  return requestJson({
    name: `identity_${state}`,
    method: "PATCH",
    url: `${baseUrl}/gateway/admin/billing/v1/phone-auth-identities/${encodeURIComponent(expectedSubjectId)}`,
    bearer: billingToken,
    body: { state }
  });
}

async function cancelResearch() {
  if (!researchRunId || !gatewayKey) return;
  const runId = researchRunId;
  researchRunId = null;
  const cancelled = await requestJson({
    name: "research_cancel",
    method: "POST",
    url: `${baseUrl}/gateway/research/v1/doctor-runs/${encodeURIComponent(runId)}/cancel`,
    bearer: gatewayKey,
    headers: { "Idempotency-Key": `research:cancel:${runId}` },
    body: {}
  });
  if (![200, 202, 409].includes(cancelled.status)) {
    throw new Error(`research_cancel returned HTTP ${cancelled.status}`);
  }
  if (cancelled.status !== 426) evidence.push(record("research_cancel", cancelled));
}

async function deleteVision() {
  if (!visionAssetId || !gatewayKey) return;
  const assetId = visionAssetId;
  visionAssetId = null;
  const deleted = await requestJson({
    name: "vision_delete",
    method: "DELETE",
    url: `${baseUrl}/gateway/vision/assets/${encodeURIComponent(assetId)}`,
    bearer: gatewayKey
  });
  assertStatus(deleted, 204);
  evidence.push(record("vision_delete", deleted));
}

async function requestJson({ name, method, url, bearer, body, headers = {}, timeoutMs = 60_000 }) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new Error(`${name} request failed`);
  }
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${name} returned non-JSON HTTP ${response.status}`);
    }
  }
  return {
    name,
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    json
  };
}

function assertStatus(result, expected) {
  if (result.status !== expected) {
    const code = String(result.json?.error?.code ?? "unknown_error").replace(/[^a-z0-9_.-]/giu, "_");
    throw new Error(`${result.name} returned HTTP ${result.status} code=${code}`);
  }
}

function assertError(result, status, code) {
  if (result.status !== status || result.json?.error?.code !== code) {
    throw new Error(
      `${result.name} returned HTTP ${result.status} code=${String(result.json?.error?.code ?? "unknown")}`
    );
  }
}

function assertAuthenticated(result, subjectId) {
  if (
    result.json?.status !== "authenticated" ||
    result.json?.auth_method !== "transition_phone_only" ||
    result.json?.subject?.id !== subjectId
  ) {
    throw new Error(`${result.name} returned an inconsistent authenticated response`);
  }
}

function record(name, result) {
  return {
    name,
    status: result.status,
    request_id: result.requestId ? "present" : "missing"
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function requiredSyntheticPhone(value) {
  if (value !== "13800138000" && value !== "13900139000") {
    throw new Error("PHONE_AUTH_CANARY_PHONE must be an approved synthetic fixture phone");
  }
  return value;
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/cgu_live_[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/cgw\.[A-Za-z0-9._-]+/gu, "[REDACTED]")
    .replace(/rft_[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED]")
    .replace(/\b1[3-9]\d{9}\b/gu, "[PHONE_REDACTED]")
    .replace(/https:\/\/[^\s]+[?&][^\s]+/gu, "[SIGNED_URL_REDACTED]")
    .slice(0, 300);
}
