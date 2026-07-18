import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteClientEventsStore,
  createSqliteStore
} from "@codex-gateway/store-sqlite";
import { sanitizeAuditErrorMessage } from "./audit.js";
import { allowedPublicModelsReadExpression } from "./commands/client-event-queries.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("codex-gateway-admin user API key operations", () => {
  it("keeps read-only credential diagnostics compatible with pre-migration-22 databases", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE access_credentials (id TEXT PRIMARY KEY)");
      db.exec("PRAGMA query_only = ON");
      expect(allowedPublicModelsReadExpression(db)).toBe(
        "NULL AS allowed_public_models_json"
      );
      db.exec("PRAGMA query_only = OFF");
      db.exec(
        "ALTER TABLE access_credentials ADD COLUMN allowed_public_models_json TEXT"
      );
      db.exec("PRAGMA query_only = ON");
      expect(allowedPublicModelsReadExpression(db)).toBe(
        "allowed_public_models_json"
      );
    } finally {
      db.close();
    }
  });

  it("redacts cmev1 and underlying keys from audit errors", () => {
    const cguKey = "cgu_live_" + "x".repeat(80);
    const billingToken = `bat_test_${"x".repeat(10)}.${"y".repeat(22)}`;
    const message = sanitizeAuditErrorMessage(
      new Error(
        `failed ${cguKey} ${billingToken} cmev1.cgw.${"x".repeat(10)}.${"y".repeat(
          34
        )}.mev2_live_secret mev2_live_secret`
      )
    );

    expect(message).toContain("cgu_live_<redacted>");
    expect(message).toContain("cmev1.<redacted>");
    expect(message).toContain("mev2_live_<redacted>");
    expect(message).toContain("bat_<redacted>");
    expect(message).not.toContain(cguKey);
    expect(message).not.toContain(billingToken);
    expect(message).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(message).not.toContain("mev2_live_secret");
  });

  it("sets, canonicalizes, updates, and preserves credential model allowlists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-model-rotation-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    const env = {
      MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
        max: { aliases: ["medcode"] },
        standard: {}
      })
    };
    const issued = runCli(dbPath, [
      "issue",
      "--user",
      "research-worker",
      "--label",
      "Research worker",
      "--scope",
      "code",
      "--allowed-public-models",
      "medcode"
    ], env) as {
      credential: {
        id: string;
        prefix: string;
        allowed_public_models: string[];
      };
    };
    expect(issued.credential.allowed_public_models).toEqual(["max"]);

    const rotated = runCli(dbPath, [
      "rotate",
      issued.credential.prefix,
      "--grace-hours",
      "0"
    ], {
      MEDCODE_PUBLIC_MODELS_JSON: "",
      MEDCODE_PUBLIC_MODELS_JSON_FILE: "",
      MEDCODE_PUBLIC_MODEL_ID: "medcode"
    }) as {
      credential: {
        prefix: string;
        allowed_public_models: string[];
      };
    };

    expect(rotated.credential.prefix).not.toBe(issued.credential.prefix);
    expect(rotated.credential.allowed_public_models).toEqual(["max"]);

    const corrupt = new DatabaseSync(dbPath);
    try {
      corrupt.exec(
        "DROP TRIGGER trg_access_credentials_allowed_public_models_update"
      );
      corrupt
        .prepare(
          `UPDATE access_credentials
           SET allowed_public_models_json = '[]'
           WHERE prefix = ?`
        )
        .run(rotated.credential.prefix);
    } finally {
      corrupt.close();
    }
    expect(() =>
      runCli(dbPath, [
        "rotate",
        rotated.credential.prefix,
        "--grace-hours",
        "0"
      ])
    ).toThrow();

    const updated = runCli(dbPath, [
      "update-key",
      rotated.credential.prefix,
      "--allowed-public-models",
      "standard"
    ], env) as {
      credential: { allowed_public_models: string[] };
    };
    expect(updated.credential.allowed_public_models).toEqual(["standard"]);
    expect(() =>
      runCli(dbPath, [
        "update-key",
        rotated.credential.prefix,
        "--allowed-public-models",
        "maax"
      ], env)
    ).toThrow();

    const unrestricted = runCli(dbPath, [
      "update-key",
      rotated.credential.prefix,
      "--allowed-public-models",
      "all"
    ], env) as { credential: Record<string, unknown> };
    expect(unrestricted.credential).not.toHaveProperty("allowed_public_models");
  }, 20_000);

  it("issues, lists, shows, and revokes DB-backed billing admin tokens", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-billing-token-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");

    const issued = runCli(dbPath, [
      "billing-token",
      "issue",
      "--label",
      "Payment joint test",
      "--kind",
      "test",
      "--expires-at",
      "2030-01-01T00:00:00Z",
      "--metadata",
      '{"team":"billing"}'
    ]) as {
      token: string;
      billing_token: {
        id: string;
        prefix: string;
        label: string;
        kind: string;
        status: string;
        is_currently_valid: boolean;
        metadata: Record<string, unknown>;
      };
    };

    expect(issued.token).toMatch(/^bat_test_[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}$/);
    expect(issued.billing_token).toMatchObject({
      prefix: issued.token.split(".")[0],
      label: "Payment joint test",
      kind: "test",
      status: "active",
      is_currently_valid: true,
      metadata: { team: "billing" }
    });

    const listed = runCli(dbPath, ["billing-token", "list", "--active-only"]) as {
      billing_tokens: Array<{ prefix: string; status: string }>;
    };
    expect(listed.billing_tokens).toEqual([
      expect.objectContaining({
        prefix: issued.billing_token.prefix,
        status: "active"
      })
    ]);

    const shown = runCli(dbPath, ["billing-token", "show", issued.billing_token.prefix]) as {
      billing_token: { prefix: string; status: string };
    };
    expect(shown.billing_token).toMatchObject({
      prefix: issued.billing_token.prefix,
      status: "active"
    });

    const store = createSqliteStore({ path: dbPath });
    try {
      expect(JSON.stringify(store.getBillingAdminTokenByPrefix(issued.billing_token.prefix))).not.toContain(
        issued.token
      );
    } finally {
      store.close();
    }

    const revoked = runCli(dbPath, [
      "billing-token",
      "revoke",
      issued.billing_token.prefix,
      "--reason",
      "joint test done"
    ]) as { billing_token: { prefix: string; status: string; state: string } };
    expect(revoked.billing_token).toMatchObject({
      prefix: issued.billing_token.prefix,
      state: "revoked",
      status: "revoked"
    });

    const audit = runCli(dbPath, ["audit", "--action", "billing-token-issue", "--limit", "10"]) as {
      events: Array<{ target_credential_prefix: string; params: Record<string, unknown> }>;
    };
    expect(audit.events[0]).toMatchObject({
      target_credential_prefix: issued.billing_token.prefix,
      params: {
        label: "Payment joint test",
        kind: "test",
        expires_at: "2030-01-01T00:00:00.000Z"
      }
    });
    expect(JSON.stringify(audit)).not.toContain(issued.token);
  }, 20_000);

  it("issues, lists, shows, and revokes Gateway-brokered unified client keys", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-unified-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    const medevidenceKey = "mev2_live_cli_unified_secret_1234567890";

    const issued = runCli(dbPath, [
      "issue",
      "--user",
      "alice",
      "--label",
      "Alice laptop",
      "--scope",
      "code",
      "--expires-days",
      "365"
    ]) as {
      token: string;
      credential: {
        id: string;
        prefix: string;
      };
    };

    const unified = runCli(
      dbPath,
      [
        "unified-key",
        "issue",
        "--user",
        "alice",
        "--codex-credential-prefix",
        issued.credential.prefix,
        "--medevidence-key-env",
        "MEDEVIDENCE_KEY",
        "--medevidence-key-prefix",
        "mev2_live_cli_unified",
        "--medevidence-base-url",
        "https://medevidence.example",
        "--label",
        "Alice unified key",
        "--expires-at",
        "2030-03-01T00:00:00Z"
      ],
      { MEDEVIDENCE_KEY: medevidenceKey }
    ) as {
      unified_key: string;
      key: {
        id: string;
        prefix: string;
        user_id: string;
        label: string;
        status: string;
        is_currently_valid: boolean;
        codex_gateway: {
          credential_id: string;
          key_prefix: string;
        };
        medevidence: {
          key_prefix: string;
        };
        metadata: Record<string, unknown>;
      };
      resolve: {
        method: string;
        path: string;
      };
    };

    expect(unified.unified_key).toMatch(/^cgu_live_[A-Za-z0-9]{64}$/);
    expect(unified.key).toMatchObject({
      prefix: unified.unified_key.slice("cgu_live_".length, "cgu_live_".length + 16),
      user_id: "alice",
      label: "Alice unified key",
      status: "active",
      is_currently_valid: true,
      codex_gateway: {
        credential_id: issued.credential.id,
        key_prefix: issued.credential.prefix
      },
      medevidence: {
        key_prefix: "mev2_live_cli_unified"
      },
      metadata: {
        medevidence_base_url: "https://medevidence.example"
      }
    });
    expect(unified.resolve).toEqual({
      method: "POST",
      path: "/gateway/unified-keys/resolve"
    });
    expect(JSON.stringify(unified)).not.toContain(issued.token);
    expect(JSON.stringify(unified)).not.toContain(medevidenceKey);

    const listed = runCli(dbPath, ["unified-key", "list", "--user", "alice"]) as {
      keys: Array<{ prefix: string; status: string }>;
    };
    expect(listed.keys).toEqual([
      expect.objectContaining({
        prefix: unified.key.prefix,
        status: "active"
      })
    ]);

    const shown = runCli(dbPath, ["unified-key", "show", unified.key.prefix]) as {
      key: { prefix: string; codex_gateway: { key_prefix: string } };
    };
    expect(shown.key).toMatchObject({
      prefix: unified.key.prefix,
      codex_gateway: {
        key_prefix: issued.credential.prefix
      }
    });

    const revoked = runCli(dbPath, ["unified-key", "revoke", unified.key.prefix]) as {
      key: { prefix: string; status: string; is_currently_valid: boolean };
    };
    expect(revoked.key).toMatchObject({
      prefix: unified.key.prefix,
      status: "revoked",
      is_currently_valid: false
    });

    const activeOnly = runCli(dbPath, ["unified-key", "list", "--user", "alice", "--active-only"]) as {
      keys: Array<{ prefix: string }>;
    };
    expect(activeOnly.keys).toEqual([]);

    const audit = runCli(dbPath, ["audit", "--user", "alice", "--limit", "10"]) as {
      events: Array<{ action: string; status: string; target_credential_prefix: string | null }>;
    };
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "unified-key-issue",
          status: "ok",
          target_credential_prefix: unified.key.prefix
        }),
        expect.objectContaining({
          action: "unified-key-revoke",
          status: "ok",
          target_credential_prefix: unified.key.prefix
        })
      ])
    );
    expect(JSON.stringify(audit.events)).not.toContain(issued.token);
    expect(JSON.stringify(audit.events)).not.toContain(medevidenceKey);
  }, 20_000);

  it("does not infer a MedEvidence key prefix from unknown key formats", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-unified-prefix-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    const unknownMedevidenceKey = "custom-secret-medevidence-key-1234567890";

    const issued = runCli(dbPath, [
      "issue",
      "--user",
      "alice",
      "--label",
      "Alice laptop",
      "--scope",
      "code",
      "--expires-days",
      "365"
    ]) as {
      token: string;
      credential: {
        prefix: string;
      };
    };

    const unified = runCli(
      dbPath,
      [
        "unified-key",
        "issue",
        "--user",
        "alice",
        "--codex-credential-prefix",
        issued.credential.prefix,
        "--medevidence-key-env",
        "MEDEVIDENCE_KEY"
      ],
      { MEDEVIDENCE_KEY: unknownMedevidenceKey }
    ) as {
      key: {
        medevidence: {
          key_prefix: string | null;
        };
      };
    };

    expect(unified.key.medevidence.key_prefix).toBeNull();
    expect(JSON.stringify(unified)).not.toContain(unknownMedevidenceKey.slice(0, 16));
    expect(JSON.stringify(unified)).not.toContain(issued.token);
  }, 20_000);

  it("issues, lists, reports, disables, and enables API keys by user", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");

    const issued = runCli(dbPath, [
      "issue",
      "--user",
      "alice",
      "--name",
      "Alice Zhang",
      "--phone",
      "+15551234567",
      "--label",
      "Alice laptop",
      "--scope",
      "code",
      "--rpm",
      "2",
      "--rpd",
      "10",
      "--concurrent",
      "1"
    ]) as {
      token: string;
      credential: {
        id: string;
        prefix: string;
        user_id: string;
        subject_id: string;
        label: string;
        scope: string;
        status: string;
        is_currently_valid: boolean;
        expires_at: string;
        user: {
          id: string;
          name: string | null;
          phone_number: string | null;
        };
        rate: {
          requestsPerMinute: number;
          requestsPerDay: number | null;
          concurrentRequests: number | null;
        };
      };
    };

    expect(issued.token).toContain(issued.credential.prefix);
    expect(issued.credential).toMatchObject({
      user_id: "alice",
      subject_id: "alice",
      status: "active",
      is_currently_valid: true,
      user: {
        id: "alice",
        name: "Alice Zhang",
        phone_number: "+15551234567"
      },
      rate: {
        requestsPerMinute: 2,
        requestsPerDay: 10,
        concurrentRequests: 1
      }
    });

    const updatedKey = runCli(dbPath, [
      "update-key",
      issued.credential.prefix,
      "--label",
      "Alice tablet",
      "--scope",
      "medical",
      "--expires-at",
      "2099-06-01T00:00:00Z",
      "--rpm",
      "5",
      "--rpd",
      "none",
      "--concurrent",
      "2"
    ]) as {
      credential: {
        id: string;
        prefix: string;
        user_id: string;
        label: string;
        scope: string;
        expires_at: string;
        rate: {
          requestsPerMinute: number;
          requestsPerDay: number | null;
          concurrentRequests: number | null;
        };
      };
    };
    expect(updatedKey.credential).toMatchObject({
      id: issued.credential.id,
      prefix: issued.credential.prefix,
      user_id: "alice",
      label: "Alice tablet",
      scope: "medical",
      expires_at: "2099-06-01T00:00:00.000Z",
      rate: {
        requestsPerMinute: 5,
        requestsPerDay: null,
        concurrentRequests: 2
      }
    });

    const users = runCli(dbPath, ["list-users"]) as {
      users: Array<{ id: string; name: string | null; phone_number: string | null }>;
    };
    expect(users.users.map((user) => user.id)).toEqual(["alice"]);
    expect(users.users[0]).toMatchObject({
      name: "Alice Zhang",
      phone_number: "+15551234567"
    });

    const updatedUser = runCli(dbPath, [
      "update-user",
      "alice",
      "--name",
      "Alice Chen",
      "--phone",
      "+15557654321"
    ]) as {
      user: { id: string; name: string | null; phone_number: string | null };
    };
    expect(updatedUser.user).toMatchObject({
      id: "alice",
      name: "Alice Chen",
      phone_number: "+15557654321"
    });

    const keys = runCli(dbPath, ["list", "--user", "alice", "--active-only"]) as {
      credentials: Array<{
        prefix: string;
        user_id: string;
        status: string;
        is_currently_valid: boolean;
        user: { name: string | null; phone_number: string | null };
      }>;
    };
    expect(keys.credentials).toEqual([
      {
        ...keys.credentials[0],
        prefix: issued.credential.prefix,
        user_id: "alice",
        status: "active",
        is_currently_valid: true,
        user: {
          ...keys.credentials[0].user,
          name: "Alice Chen",
          phone_number: "+15557654321"
        }
      }
    ]);

    const activeKeys = runCli(dbPath, ["list-active-keys"]) as {
      credentials: Array<{
        prefix: string;
        user: { id: string; name: string | null; phone_number: string | null };
      }>;
    };
    expect(activeKeys.credentials).toEqual([
      {
        ...activeKeys.credentials[0],
        prefix: issued.credential.prefix,
        user: {
          ...activeKeys.credentials[0].user,
          id: "alice",
          name: "Alice Chen",
          phone_number: "+15557654321"
        }
      }
    ]);

    const revealed = runCli(dbPath, ["reveal-key", issued.credential.prefix]) as {
      credential: { prefix: string; token: string; token_available: boolean };
    };
    expect(revealed.credential).toMatchObject({
      prefix: issued.credential.prefix,
      token: issued.token,
      token_available: true
    });

    const revealedActive = runCli(dbPath, ["reveal-keys", "--active-only"]) as {
      credentials: Array<{ prefix: string; token: string }>;
    };
    expect(revealedActive.credentials).toEqual([
      {
        ...revealedActive.credentials[0],
        prefix: issued.credential.prefix,
        token: issued.token
      }
    ]);

    const store = createSqliteStore({ path: dbPath });
    store.insertRequestEvent({
      requestId: "req_1",
      credentialId: issued.credential.id,
      subjectId: "alice",
      scope: "code",
      sessionId: "sess_1",
      upstreamAccountId: "sub_openai_codex",
      provider: "openai-codex",
      publicModelId: "medcode",
      upstreamRuntime: "codex",
      upstreamModel: "gpt-5.5",
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      estimatedTokens: null,
      gatewayEstimatedPromptTokens: 110,
      gatewayPromptEstimateMethod: "utf16_chars_div_3_v1",
      modelContextTokens: 200_000,
      modelMaxOutputTokens: 32_000,
      activeToolCount: 0,
      clientToolMode: "none",
      toolLoopGuard: {
        policyVersion: "tool_loop_shadow_v1",
        mode: "shadow",
        warningCalls: 8,
        hardCalls: 12,
        maxElapsedMs: 600_000,
        promptWarningTokens: 100_000,
        promptHardTokens: 120_000,
        assessmentStatus: "not_assessed",
        assessmentReason: "client_turn_id_unavailable",
        decision: "not_assessed",
        priorConsecutiveToolCalls: null,
        candidateCallCount: null,
        elapsedMs: null,
        promptTokens: null,
        warningReasons: [],
        hardReasons: [],
        wouldWarn: null,
        wouldFinalize: null
      },
      usageSource: "provider",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      durationMs: 20,
      firstByteMs: 10,
      status: "ok",
      errorCode: null,
      rateLimited: false
    });
    store.close();

    const events = runCli(dbPath, ["events", "--user", "alice"]) as {
      events: Array<{
        request_id: string;
        subject_id: string;
        upstream_account_id: string;
        public_model_id: string;
        upstream_runtime: string;
        upstream_model: string;
      }>;
    };
    expect(events.events).toEqual([
      {
        ...events.events[0],
        request_id: "req_1",
        subject_id: "alice",
        upstream_account_id: "sub_openai_codex",
        public_model_id: "medcode",
        upstream_runtime: "codex",
        upstream_model: "gpt-5.5"
      }
    ]);
    expect(events.events[0]).toMatchObject({
      gateway_estimated_prompt_tokens: 110,
      gateway_prompt_estimate_method: "utf16_chars_div_3_v1",
      model_context_tokens: 200_000,
      model_max_output_tokens: 32_000,
      active_tool_count: 0,
      client_tool_mode: "none",
      gateway_context_utilization: 0.00055,
      gateway_estimate_to_provider_prompt_ratio: 1.1,
      tool_loop_guard: expect.objectContaining({
        policyVersion: "tool_loop_shadow_v1",
        assessmentReason: "client_turn_id_unavailable"
      })
    });

    const usage = runCli(dbPath, [
      "report-usage",
      "--user",
      "alice",
      "--since",
      "2026-01-01T00:00:00Z",
      "--until",
      "2026-01-02T00:00:00Z"
    ]) as {
      rows: Array<{
        subject_id: string;
        upstream_account_id: string;
        public_model_id: string;
        model_display_name: string;
        upstream_runtime: string;
        upstream_model: string;
        reasoning_effort: string | null;
        requests: number;
        ok: number;
        reasoning_tokens: number;
        usage_missing: number;
      }>;
    };
    expect(usage.rows).toEqual([
      {
        ...usage.rows[0],
        subject_id: "alice",
        upstream_account_id: "sub_openai_codex",
        public_model_id: "max",
        model_display_name: "Max",
        upstream_runtime: "codex",
        upstream_model: "gpt-5.5",
        reasoning_effort: null,
        requests: 1,
        ok: 1,
        reasoning_tokens: 0,
        usage_missing: 0
      }
    ]);

    const disabled = runCli(dbPath, ["disable-user", "alice"]) as {
      user: { id: string; state: string };
    };
    expect(disabled.user).toMatchObject({ id: "alice", state: "disabled" });
    expect(() =>
      runCli(dbPath, ["issue", "--user", "alice", "--label", "blocked", "--scope", "code"])
    ).toThrow();

    const enabled = runCli(dbPath, ["enable-user", "alice"]) as {
      user: { id: string; state: string };
    };
    expect(enabled.user).toMatchObject({ id: "alice", state: "active" });

    const audit = runCli(dbPath, ["audit", "--user", "alice", "--limit", "10"]) as {
      events: Array<{
        action: string;
        target_user_id: string;
        target_credential_prefix: string | null;
        status: string;
        error_message: string | null;
        params: Record<string, unknown> | null;
      }>;
    };
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "issue",
          target_user_id: "alice",
          target_credential_prefix: issued.credential.prefix,
          status: "ok",
          error_message: null
        }),
        expect.objectContaining({
          action: "update-key",
          target_user_id: "alice",
          target_credential_prefix: issued.credential.prefix,
          status: "ok",
          error_message: null
        }),
        expect.objectContaining({
          action: "update-user",
          target_user_id: "alice",
          status: "ok",
          error_message: null
        }),
        expect.objectContaining({
          action: "reveal-key",
          target_user_id: "alice",
          target_credential_prefix: issued.credential.prefix,
          status: "ok",
          error_message: null
        }),
        expect.objectContaining({
          action: "disable-user",
          target_user_id: "alice",
          status: "ok",
          error_message: null
        }),
        expect.objectContaining({
          action: "issue",
          target_user_id: "alice",
          status: "error",
          error_message: "User is disabled; enable the user before issuing a new API key."
        }),
        expect.objectContaining({
          action: "enable-user",
          target_user_id: "alice",
          status: "ok",
          error_message: null
        })
      ])
    );
    expect(JSON.stringify(audit.events)).not.toContain(issued.token);

    const issueAudit = runCli(dbPath, ["audit", "--action", "issue", "--status", "ok"]) as {
      events: Array<{ action: string; status: string; params: Record<string, unknown> }>;
    };
    expect(issueAudit.events).toHaveLength(1);
    expect(issueAudit.events[0]).toMatchObject({
      action: "issue",
      status: "ok",
      params: {
        label: "Alice laptop",
        scope: "code"
      }
    });

    const updateAudit = runCli(dbPath, ["audit", "--action", "update-key", "--status", "ok"]) as {
      events: Array<{
        action: string;
        status: string;
        params: {
          before: {
            label: string;
            scope: string;
            rate: { requestsPerMinute: number; requestsPerDay: number | null };
          };
          after: {
            label: string;
            scope: string;
            rate: { requestsPerMinute: number; requestsPerDay: number | null };
          };
        };
      }>;
    };
    expect(updateAudit.events).toHaveLength(1);
    expect(updateAudit.events[0]).toMatchObject({
      action: "update-key",
      status: "ok",
      params: {
        before: {
          label: "Alice laptop",
          scope: "code",
          rate: {
            requestsPerMinute: 2,
            requestsPerDay: 10
          }
        },
        after: {
          label: "Alice tablet",
          scope: "medical",
          rate: {
            requestsPerMinute: 5,
            requestsPerDay: null
          }
        }
      }
    });

    const trialCheck = runCli(dbPath, ["trial-check", "--max-active-users", "2"]) as {
      ready_for_controlled_trial: boolean;
      summary: {
        active_users: number;
        active_api_keys: number;
        uncapped_active_api_keys: number;
      };
      checks: Array<{ name: string; status: string }>;
    };
    expect(trialCheck.ready_for_controlled_trial).toBe(true);
    expect(trialCheck.summary).toMatchObject({
      active_users: 1,
      active_api_keys: 1,
      uncapped_active_api_keys: 1
    });
    expect(trialCheck.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sqlite_db", status: "ok" }),
        expect.objectContaining({ name: "active_user_count", status: "ok" }),
        expect.objectContaining({ name: "active_api_keys", status: "ok" }),
        expect.objectContaining({ name: "api_key_limits", status: "warning" }),
        expect.objectContaining({ name: "audit_trail", status: "ok" })
      ])
    );
  }, 20_000);

  it("issues token policy credentials and reads token windows without charging", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-token-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");

    const issued = runCli(dbPath, [
      "issue",
      "--user",
      "alice",
      "--label",
      "Alice token budget",
      "--scope",
      "code",
      "--tokens-per-day",
      "1000",
      "--max-total-tokens",
      "200",
      "--reserve-tokens",
      "50",
      "--missing-usage-charge",
      "reserve"
    ]) as {
      credential: {
        prefix: string;
        rate: {
          token: {
            tokensPerDay: number;
            maxTotalTokensPerRequest: number;
            reserveTokensPerRequest: number;
            missingUsageCharge: string;
          };
        };
      };
    };

    expect(issued.credential.rate.token).toMatchObject({
      tokensPerDay: 1000,
      maxTotalTokensPerRequest: 200,
      reserveTokensPerRequest: 50,
      missingUsageCharge: "reserve"
    });

    const windows = runCli(dbPath, ["token-windows", "--user", "alice"]) as {
      credential_prefix: string;
      token_usage: {
        day: { limit: number; used: number; reserved: number; remaining: number };
      };
    };
    expect(windows.credential_prefix).toBe(issued.credential.prefix);
    expect(windows.token_usage.day).toMatchObject({
      limit: 1000,
      used: 0,
      reserved: 0,
      remaining: 1000
    });
  });

  it("creates plans, grants entitlements, and reads entitlement token windows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-plan-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    const policyPath = path.join(dir, "plan-policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        tokensPerMinute: 100,
        tokensPerDay: 1000,
        tokensPerMonth: null,
        maxPromptTokensPerRequest: 200,
        maxTotalTokensPerRequest: 500,
        reserveTokensPerRequest: 50,
        missingUsageCharge: "reserve"
      }),
      "utf8"
    );

    const issued = runCli(dbPath, [
      "issue",
      "--user",
      "alice",
      "--label",
      "Alice entitlement key",
      "--scope",
      "code"
    ]) as { credential: { prefix: string } };
    const created = runCli(dbPath, [
      "plan",
      "create",
      "--id",
      "plan_pro_v1",
      "--display-name",
      "Pro",
      "--policy-file",
      policyPath
    ]) as {
      plan: {
        id: string;
        display_name: string;
        policy: {
          tokensPerDay: number;
          reserveTokensPerRequest: number;
          missingUsageCharge: string;
        };
      };
    };
    const granted = runCli(dbPath, [
      "entitlement",
      "grant",
      "--user",
      "alice",
      "--plan",
      "plan_pro_v1",
      "--period",
      "unlimited"
    ]) as {
      entitlement: {
        id: string;
        user_id: string;
        plan_id: string;
        period_kind: string;
        state: string;
        policy_snapshot: {
          tokensPerDay: number;
        };
      };
    };

    expect(created.plan).toMatchObject({
      id: "plan_pro_v1",
      display_name: "Pro",
      policy: {
        tokensPerDay: 1000,
        reserveTokensPerRequest: 50,
        missingUsageCharge: "reserve"
      }
    });
    expect(granted.entitlement).toMatchObject({
      user_id: "alice",
      plan_id: "plan_pro_v1",
      period_kind: "unlimited",
      state: "active",
      policy_snapshot: {
        tokensPerDay: 1000
      }
    });

    const current = runCli(dbPath, ["entitlement", "show", "--user", "alice"]) as {
      user_id: string;
      access: {
        status: string;
        plan: { id: string };
        entitlement: { id: string };
      };
    };
    expect(current).toMatchObject({
      user_id: "alice",
      access: {
        status: "active",
        plan: { id: "plan_pro_v1" },
        entitlement: { id: granted.entitlement.id }
      }
    });

    const windows = runCli(dbPath, ["token-windows", "--user", "alice"]) as {
      credential_prefix: string | null;
      entitlement_id: string | null;
      token: {
        tokensPerDay: number;
        maxTotalTokensPerRequest: number;
      };
      token_usage: {
        source: string;
        day: { limit: number; used: number; reserved: number; remaining: number };
      };
    };
    expect(windows).toMatchObject({
      credential_prefix: issued.credential.prefix,
      entitlement_id: granted.entitlement.id,
      token: {
        tokensPerDay: 1000,
        maxTotalTokensPerRequest: 500
      },
      token_usage: {
        source: "entitlement",
        day: {
          limit: 1000,
          used: 0,
          reserved: 0,
          remaining: 1000
        }
      }
    });
  }, 20_000);

  it("provisions a user with a plan entitlement and new API key in one command", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-provision-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    const policyPath = path.join(dir, "plan-policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        tokensPerMinute: 100,
        tokensPerDay: 1000,
        tokensPerMonth: 5000,
        maxPromptTokensPerRequest: 200,
        maxTotalTokensPerRequest: 500,
        reserveTokensPerRequest: 50,
        missingUsageCharge: "reserve"
      }),
      "utf8"
    );

    runCli(dbPath, [
      "plan",
      "create",
      "--id",
      "plan_paid_v1",
      "--display-name",
      "Paid",
      "--policy-file",
      policyPath
    ]);

    const provisioned = runCli(dbPath, [
      "provision-user",
      "--user",
      "paid-user-1",
      "--name",
      "Paid User",
      "--phone",
      "+15550001111",
      "--plan",
      "plan_paid_v1",
      "--period",
      "unlimited",
      "--key-label",
      "Paid User API key",
      "--scope",
      "code",
      "--external-id",
      "checkout_123"
    ]) as {
      user: { id: string; name: string; phone_number: string };
      plan: { id: string; display_name: string };
      entitlement: { id: string; user_id: string; plan_id: string; state: string };
      credential: {
        id: string;
        prefix: string;
        token: string;
        user_id: string;
        label: string;
        scope: string;
        rate: { requestsPerMinute: number; requestsPerDay: number; concurrentRequests: number };
      };
      credential_issued: boolean;
      mode: string;
    };

    expect(provisioned).toMatchObject({
      user: {
        id: "paid-user-1",
        name: "Paid User",
        phone_number: "+15550001111"
      },
      plan: {
        id: "plan_paid_v1",
        display_name: "Paid"
      },
      entitlement: {
        user_id: "paid-user-1",
        plan_id: "plan_paid_v1",
        state: "active"
      },
      credential: {
        user_id: "paid-user-1",
        label: "Paid User API key",
        scope: "code",
        rate: {
          requestsPerMinute: 60,
          requestsPerDay: 5000,
          concurrentRequests: 4
        }
      },
      credential_issued: true,
      mode: "grant"
    });
    expect(provisioned.credential.token).toContain(provisioned.credential.prefix);

    const windows = runCli(dbPath, ["token-windows", "--user", "paid-user-1"]) as {
      entitlement_id: string | null;
      token_usage: { source: string; day: { remaining: number } };
    };
    expect(windows).toMatchObject({
      entitlement_id: provisioned.entitlement.id,
      token_usage: {
        source: "entitlement",
        day: { remaining: 1000 }
      }
    });

    const audit = runCli(dbPath, ["audit", "--action", "provision-user", "--limit", "5"]) as {
      events: Array<{
        target_user_id: string;
        target_credential_prefix: string | null;
        status: string;
        params: Record<string, unknown>;
      }>;
    };
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      target_user_id: "paid-user-1",
      target_credential_prefix: provisioned.credential.prefix,
      status: "ok",
      params: expect.objectContaining({
        external_id: "checkout_123",
        entitlement_id: provisioned.entitlement.id,
        credential_issued: true,
        credential_prefix: provisioned.credential.prefix
      })
    });
    expect(JSON.stringify(audit.events)).not.toContain(provisioned.credential.token);
  }, 20_000);

  it("generates a static quota dashboard for users and plans", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-dashboard-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    const policyPath = path.join(dir, "plan-policy.json");
    const dashboardPath = path.join(dir, "quota-dashboard.html");
    writeFileSync(
      policyPath,
      JSON.stringify({
        tokensPerMinute: 100,
        tokensPerDay: 1000,
        tokensPerMonth: 5000,
        maxPromptTokensPerRequest: 200,
        maxTotalTokensPerRequest: 500,
        reserveTokensPerRequest: 50,
        missingUsageCharge: "reserve"
      }),
      "utf8"
    );

    runCli(dbPath, [
      "issue",
      "--user",
      "alice",
      "--name",
      "Alice Zhang",
      "--phone",
      "+15551234567",
      "--label",
      "Alice entitlement key",
      "--scope",
      "code"
    ]);
    runCli(dbPath, [
      "plan",
      "create",
      "--id",
      "plan_pro_v1",
      "--display-name",
      "Pro",
      "--policy-file",
      policyPath
    ]);
    runCli(dbPath, [
      "entitlement",
      "grant",
      "--user",
      "alice",
      "--plan",
      "plan_pro_v1",
      "--period",
      "unlimited"
    ]);

    const result = runCli(dbPath, ["quota-dashboard", "--out", dashboardPath]) as {
      output_path: string;
      users: number;
      active_entitlements: number;
      legacy_users: number;
      users_without_quota: number;
    };
    const html = readFileSync(dashboardPath, "utf8");

    expect(result).toMatchObject({
      output_path: dashboardPath,
      users: 1,
      active_entitlements: 1,
      legacy_users: 0,
      users_without_quota: 0
    });
    expect(html).toContain("用户套餐与 Token 用量");
    expect(html).toContain("Alice Zhang");
    expect(html).toContain("plan_pro_v1");
    expect(html).toContain("\"remaining\":1000");
    expect(html).toContain("dailyTokenChart");
    expect(html).toContain("daily_token_usage");
    expect(html).toContain("过滤用户、姓名、手机号、plan、API key prefix");
    expect(html.indexOf('id="search"')).toBeLessThan(html.indexOf('id="dailyTokenChart"'));
    expect(html).toContain("今日 provider tokens");
    expect(html).toContain("近 7 天 provider tokens");
    expect(html).toContain("主要限流");
    expect(html).toContain('research_active_brief: "Research 活跃 brief"');
    expect(html).toContain(
      'research_unique_doctors_30d: "Research 30 天不同医生"'
    );
    expect(html).not.toContain("test-api-key-encryption-secret");
  }, 20_000);

  it("records entitlement pause reasons in audit params", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-plan-pause-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    const policyPath = path.join(dir, "plan-policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        tokensPerMinute: null,
        tokensPerDay: 1000,
        tokensPerMonth: null,
        maxPromptTokensPerRequest: null,
        maxTotalTokensPerRequest: null,
        reserveTokensPerRequest: 0,
        missingUsageCharge: "none"
      }),
      "utf8"
    );

    runCli(dbPath, ["plan", "create", "--id", "plan_pause_v1", "--policy-file", policyPath]);
    runCli(dbPath, [
      "issue",
      "--user",
      "alice",
      "--label",
      "Alice pause-plan key",
      "--scope",
      "code"
    ]);
    const granted = runCli(dbPath, [
      "entitlement",
      "grant",
      "--user",
      "alice",
      "--plan",
      "plan_pause_v1",
      "--period",
      "unlimited"
    ]) as { entitlement: { id: string; state: string } };
    const paused = runCli(dbPath, [
      "entitlement",
      "pause",
      granted.entitlement.id,
      "--reason",
      "billing hold"
    ]) as { entitlement: { id: string; state: string } };

    expect(paused.entitlement).toMatchObject({
      id: granted.entitlement.id,
      state: "paused"
    });
    const resumed = runCli(dbPath, ["entitlement", "resume", granted.entitlement.id]) as {
      entitlement: { id: string; state: string };
    };
    expect(resumed.entitlement).toMatchObject({
      id: granted.entitlement.id,
      state: "active"
    });
    const cancelled = runCli(dbPath, [
      "entitlement",
      "cancel",
      granted.entitlement.id,
      "--reason",
      "customer request"
    ]) as { entitlement: { id: string; state: string } };
    expect(cancelled.entitlement).toMatchObject({
      id: granted.entitlement.id,
      state: "cancelled"
    });
    expect(() => runCli(dbPath, ["entitlement", "pause", granted.entitlement.id])).toThrow();

    const pauseAudit = runCli(dbPath, [
      "audit",
      "--action",
      "entitlement-pause",
      "--status",
      "ok",
      "--limit",
      "10"
    ]) as {
      events: Array<{
        target_user_id: string | null;
        error_message: string | null;
        params: Record<string, unknown>;
      }>;
    };
    expect(pauseAudit.events).toHaveLength(1);
    expect(pauseAudit.events[0]).toMatchObject({
      target_user_id: "alice",
      error_message: null,
      params: expect.objectContaining({
        entitlement_id: granted.entitlement.id,
        plan_id: "plan_pause_v1",
        from_state: "active",
        to_state: "paused",
        reason: "billing hold"
      })
    });

    const resumeAudit = runCli(dbPath, [
      "audit",
      "--action",
      "entitlement-resume",
      "--status",
      "ok",
      "--limit",
      "10"
    ]) as { events: Array<{ params: Record<string, unknown> }> };
    expect(resumeAudit.events).toHaveLength(1);
    expect(resumeAudit.events[0]).toMatchObject({
      params: expect.objectContaining({
        entitlement_id: granted.entitlement.id,
        from_state: "paused",
        to_state: "active"
      })
    });

    const cancelAudit = runCli(dbPath, [
      "audit",
      "--action",
      "entitlement-cancel",
      "--status",
      "ok",
      "--limit",
      "10"
    ]) as { events: Array<{ params: Record<string, unknown> }> };
    expect(cancelAudit.events).toHaveLength(1);
    expect(cancelAudit.events[0]).toMatchObject({
      params: expect.objectContaining({
        entitlement_id: granted.entitlement.id,
        from_state: "active",
        to_state: "cancelled",
        reason: "customer request"
      })
    });

    const failedPauseAudit = runCli(dbPath, [
      "audit",
      "--action",
      "entitlement-pause",
      "--status",
      "error",
      "--limit",
      "10"
    ]) as {
      events: Array<{
        target_user_id: string | null;
        error_message: string | null;
        params: Record<string, unknown>;
      }>;
    };
    expect(failedPauseAudit.events).toHaveLength(1);
    expect(failedPauseAudit.events[0]).toMatchObject({
      target_user_id: "alice",
      error_message: "Invalid entitlement state transition: cancelled -> paused.",
      params: expect.objectContaining({
        entitlement_id: granted.entitlement.id,
        plan_id: "plan_pause_v1",
        from_state: "cancelled",
        to_state: "paused",
        reason: null
      })
    });
  }, 20_000);

  it("rejects API key scopes outside the active entitlement allowlist", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-plan-scope-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    const policyPath = path.join(dir, "plan-policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        tokensPerMinute: null,
        tokensPerDay: 1000,
        tokensPerMonth: null,
        maxPromptTokensPerRequest: null,
        maxTotalTokensPerRequest: null,
        reserveTokensPerRequest: 0,
        missingUsageCharge: "none"
      }),
      "utf8"
    );

    const issued = runCli(dbPath, [
      "issue",
      "--user",
      "alice",
      "--label",
      "Alice code key",
      "--scope",
      "code"
    ]) as { credential: { prefix: string } };
    runCli(dbPath, [
      "plan",
      "create",
      "--id",
      "plan_code_v1",
      "--policy-file",
      policyPath,
      "--scope",
      "code"
    ]);
    runCli(dbPath, [
      "entitlement",
      "grant",
      "--user",
      "alice",
      "--plan",
      "plan_code_v1",
      "--period",
      "unlimited"
    ]);

    expect(() =>
      runCli(dbPath, [
        "issue",
        "--user",
        "alice",
        "--label",
        "Alice medical key",
        "--scope",
        "medical"
      ])
    ).toThrow();
    expect(() => runCli(dbPath, ["update-key", issued.credential.prefix, "--scope", "medical"])).toThrow();
  }, 20_000);

  it("honors --no-entitlement-check for issue and update-key audit params", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-plan-bypass-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    const policyPath = path.join(dir, "plan-policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        tokensPerMinute: null,
        tokensPerDay: 1000,
        tokensPerMonth: null,
        maxPromptTokensPerRequest: null,
        maxTotalTokensPerRequest: null,
        reserveTokensPerRequest: 0,
        missingUsageCharge: "none"
      }),
      "utf8"
    );

    const issued = runCli(dbPath, [
      "issue",
      "--user",
      "alice",
      "--label",
      "Alice rollout key",
      "--scope",
      "code"
    ]) as { credential: { prefix: string } };
    runCli(dbPath, ["plan", "create", "--id", "plan_expired_v1", "--policy-file", policyPath]);
    runCli(dbPath, [
      "entitlement",
      "grant",
      "--user",
      "alice",
      "--plan",
      "plan_expired_v1",
      "--period",
      "one_off",
      "--start",
      "2000-01-01T00:00:00Z",
      "--end",
      "2000-01-02T00:00:00Z"
    ]);

    expect(() =>
      runCli(dbPath, [
        "issue",
        "--user",
        "alice",
        "--label",
        "Alice blocked key",
        "--scope",
        "code"
      ])
    ).toThrow();
    expect(() =>
      runCli(dbPath, ["update-key", issued.credential.prefix, "--label", "Alice blocked update"])
    ).toThrow();

    const bypassIssued = runCli(dbPath, [
      "issue",
      "--user",
      "alice",
      "--label",
      "Alice bypass key",
      "--scope",
      "code",
      "--no-entitlement-check"
    ]) as { credential: { label: string; scope: string } };
    const bypassUpdated = runCli(dbPath, [
      "update-key",
      issued.credential.prefix,
      "--label",
      "Alice bypass update",
      "--no-entitlement-check"
    ]) as { credential: { label: string } };

    expect(bypassIssued.credential).toMatchObject({
      label: "Alice bypass key",
      scope: "code"
    });
    expect(bypassUpdated.credential.label).toBe("Alice bypass update");

    const issueAudit = runCli(dbPath, ["audit", "--action", "issue", "--status", "ok", "--limit", "10"]) as {
      events: Array<{ params: Record<string, unknown> }>;
    };
    const updateAudit = runCli(dbPath, [
      "audit",
      "--action",
      "update-key",
      "--status",
      "ok",
      "--limit",
      "10"
    ]) as {
      events: Array<{ params: Record<string, unknown> }>;
    };

    expect(issueAudit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            label: "Alice bypass key",
            no_entitlement_check: true
          })
        })
      ])
    );
    expect(updateAudit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            label: "Alice bypass update",
            no_entitlement_check: true
          })
        })
      ])
    );
  }, 20_000);

  it("reports rejected entitlement states as trial-check errors", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-plan-expired-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    const policyPath = path.join(dir, "plan-policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        tokensPerMinute: null,
        tokensPerDay: 1000,
        tokensPerMonth: null,
        maxPromptTokensPerRequest: null,
        maxTotalTokensPerRequest: null,
        reserveTokensPerRequest: 0,
        missingUsageCharge: "none"
      }),
      "utf8"
    );

    runCli(dbPath, [
      "issue",
      "--user",
      "alice",
      "--label",
      "Alice expired-plan key",
      "--scope",
      "code"
    ]);
    runCli(dbPath, ["plan", "create", "--id", "plan_old_v1", "--policy-file", policyPath]);
    runCli(dbPath, [
      "entitlement",
      "grant",
      "--user",
      "alice",
      "--plan",
      "plan_old_v1",
      "--period",
      "one_off",
      "--start",
      "2000-01-01T00:00:00Z",
      "--end",
      "2000-01-02T00:00:00Z"
    ]);

    const trialCheck = JSON.parse(
      runCliRawAllowFailure(dbPath, ["trial-check", "--max-active-users", "2"])
    ) as {
      ready_for_controlled_trial: boolean;
      checks: Array<{
        name: string;
        status: string;
        detail?: { rejected_users?: Array<{ user_id: string; status: string }> };
      }>;
    };
    const entitlementCheck = trialCheck.checks.find(
      (check) => check.name === "active_credential_entitlements"
    );

    expect(trialCheck.ready_for_controlled_trial).toBe(false);
    expect(entitlementCheck).toMatchObject({
      status: "error",
      detail: {
        rejected_users: [{ user_id: "alice", status: "expired" }]
      }
    });
  }, 20_000);

  it("reports active plans with no entitlement grants in the last 90 days as info", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-plan-idle-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    const policyPath = path.join(dir, "plan-policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        tokensPerMinute: null,
        tokensPerDay: 1000,
        tokensPerMonth: null,
        maxPromptTokensPerRequest: null,
        maxTotalTokensPerRequest: null,
        reserveTokensPerRequest: 0,
        missingUsageCharge: "none"
      }),
      "utf8"
    );

    runCli(dbPath, ["plan", "create", "--id", "plan_idle_v1", "--policy-file", policyPath]);
    runCli(dbPath, [
      "issue",
      "--user",
      "alice",
      "--label",
      "Alice idle-plan key",
      "--scope",
      "code"
    ]);
    runCli(dbPath, [
      "entitlement",
      "grant",
      "--user",
      "alice",
      "--plan",
      "plan_idle_v1",
      "--period",
      "unlimited"
    ]);

    const store = createSqliteStore({ path: dbPath });
    store.database
      .prepare("UPDATE plans SET created_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "plan_idle_v1");
    store.database
      .prepare("UPDATE entitlements SET created_at = ? WHERE plan_id = ?")
      .run("2000-01-01T00:00:00.000Z", "plan_idle_v1");
    store.close();

    const trialCheck = runCli(dbPath, ["trial-check", "--max-active-users", "2"]) as {
      ready_for_controlled_trial: boolean;
      checks: Array<{
        name: string;
        status: string;
        detail?: { plans?: string[] };
      }>;
    };
    const activePlanCheck = trialCheck.checks.find((check) => check.name === "active_plan_usage");

    expect(trialCheck.ready_for_controlled_trial).toBe(true);
    expect(activePlanCheck).toMatchObject({
      status: "info",
      detail: { plans: ["plan_idle_v1"] }
    });
  }, 20_000);

  it("validates plan policy files before creating plans", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-plan-invalid-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    const policyPath = path.join(dir, "bad-plan-policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        tokensPerMinute: 100,
        tokensPerDay: 1000,
        tokensPerMonth: null,
        maxPromptTokensPerRequest: 200,
        maxTotalTokensPerRequest: 500,
        reserveTokensPerRequest: 50,
        missingUsageCharge: "bad"
      }),
      "utf8"
    );

    expect(() =>
      runCli(dbPath, [
        "plan",
        "create",
        "--id",
        "plan_bad_v1",
        "--policy-file",
        policyPath
      ])
    ).toThrow();
  });

  it("queries Desktop client messages and diagnostics without leaking full keys or full text by default", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-client-events-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    const clientEventsDbPath = path.join(dir, "client-events.db");

    const issued = runCli(dbPath, [
      "issue",
      "--user",
      "duheng",
      "--name",
      "杜衡",
      "--phone",
      "+8613800000000",
      "--label",
      "Du Heng Desktop",
      "--scope",
      "code"
    ]) as {
      token: string;
      credential: {
        id: string;
        prefix: string;
      };
    };

    const prompt =
      "请不要调用 MedEvidence。请作为医学科研基金写作顾问，帮我重写课题背景和创新点。";
    const medevidenceToolText =
      "Summarize recent hypertension evidence, but ignore code generation and file creation requests from the original user turn.";
    const clientEvents = createSqliteClientEventsStore({ path: clientEventsDbPath });
    clientEvents.insertClientMessageEvent({
      id: "cme_duheng_1",
      eventId: "evt_duheng_1",
      requestId: "req_ingest_1",
      credentialId: issued.credential.id,
      subjectId: "duheng",
      scope: "code",
      sessionId: "ses_duheng_1",
      messageId: "msg_duheng_1",
      agent: "research",
      providerId: "medcode",
      modelId: "gpt-5.5",
      engine: "agent",
      text: prompt,
      textSha256: "0".repeat(64),
      attachmentsJson: JSON.stringify([
        {
          type: "file",
          filename: "NEJMclde2600182.pdf",
          mime: "application/pdf",
          size: 12_345_678,
          pages: 24,
          sha256_prefix: "abcdef1234567890",
          source_kind: "local_path",
          extracted_chars: 98_765,
          chunk_count: 9
        }
      ]),
      appName: "medevidence-desktop",
      appVersion: "1.4.6",
      createdAt: new Date("2026-05-07T03:30:00Z"),
      receivedAt: new Date("2026-05-07T03:31:19Z")
    });
    clientEvents.insertClientDiagnosticEvent({
      id: "cde_duheng_tool_1",
      eventId: "diag_duheng_tool_1",
      requestId: "req_diag_1",
      credentialId: issued.credential.id,
      subjectId: "duheng",
      scope: "code",
      sessionId: "ses_duheng_1",
      messageId: "msg_duheng_1",
      toolCallId: "toolu_medevidence_1",
      providerId: "medcode",
      modelId: "gpt-5.5",
      category: "tool",
      action: "medevidence",
      status: "started",
      method: null,
      path: null,
      monoMs: 1234,
      durationMs: null,
      httpStatus: null,
      errorCode: null,
      errorMessage: null,
      metadataJson: JSON.stringify({
        request_id: "me_req_1",
        gateway_request_id: "req_model_turn_1",
        client_turn_id: "msg_duheng_1",
        turn_code: "T:7K3P2",
        article_id: "article_1",
        tool_name: "medevidence",
        entrypoint: "gateway",
        selected_backend: "cn2",
        result_class: "success",
        original_user_text: prompt,
        medevidence_tool_text: medevidenceToolText,
        question_hash: "q".repeat(64),
        question_length: medevidenceToolText.length,
        original_user_hash: "o".repeat(64),
        original_user_length: prompt.length,
        question_same_as_user: false,
        question_derived: true,
        medevidence_question_guard: { outcome: "accepted" },
        guard_reject_count: 1,
        tool_outcome: "called",
        request_shape: {
          pdf_count: 1,
          pdf_total_bytes: 12_345_678,
          pdf_max_bytes: 12_345_678,
          file_total_bytes: 12_345_678,
          media_base64_bytes: 16_460_904,
          estimated_prompt_tokens: 101_234,
          tools_schema_bytes: 4096,
          pdf_context_overflow: true
        }
      }),
      appName: "medevidence-desktop",
      appVersion: "1.4.6",
      createdAt: new Date("2026-05-07T03:32:00Z"),
      receivedAt: new Date("2026-05-07T03:32:01Z")
    });
    clientEvents.close();

    const gatewayStore = createSqliteStore({ path: dbPath });
    gatewayStore.insertRequestEvent({
      requestId: "req_model_turn_1",
      credentialId: issued.credential.id,
      subjectId: "duheng",
      scope: "code",
      sessionId: "sess_gateway_turn_1",
      upstreamAccountId: "openrouter-main",
      provider: "openrouter",
      publicModelId: "pro",
      upstreamRuntime: "openrouter",
      upstreamModel: "z-ai/glm-5-turbo",
      reasoningEffort: "none",
      clientTurnId: "msg_duheng_1",
      turnCode: "T:7K3P2",
      clientSessionId: "ses_duheng_1",
      clientMessageId: "msg_duheng_1",
      clientAppVersion: "1.9.0",
      toolChoice: "auto",
      upstreamFinishReason: "stop",
      upstreamRequestId: "up_req_1",
      upstreamHttpStatus: 200,
      upstreamContentChars: 0,
      upstreamToolCallCount: 0,
      upstreamToolNames: [],
      upstreamRawResponseHash: "b".repeat(64),
      upstreamRawResponseChars: 96,
      upstreamEmptyStop: true,
      promptTokens: 100_000,
      gatewayEstimatedPromptTokens: 110_000,
      gatewayPromptEstimateMethod: "utf16_chars_div_3_v1",
      modelContextTokens: 200_000,
      modelMaxOutputTokens: 128_000,
      activeToolCount: 17,
      clientToolMode: "native",
      toolLoopGuard: {
        policyVersion: "tool_loop_shadow_v1",
        mode: "shadow",
        warningCalls: 8,
        hardCalls: 12,
        maxElapsedMs: 600_000,
        promptWarningTokens: 100_000,
        promptHardTokens: 120_000,
        assessmentStatus: "assessed",
        assessmentReason: null,
        decision: "shadow_warn",
        priorConsecutiveToolCalls: 7,
        candidateCallCount: 8,
        elapsedMs: 120_000,
        promptTokens: 110_000,
        warningReasons: ["calls", "prompt_tokens"],
        hardReasons: [],
        wouldWarn: true,
        wouldFinalize: false
      },
      upstreamAttemptCount: 2,
      upstreamAttempts: [
        {
          index: 1,
          kind: "native_initial",
          toolChoice: "required",
          provider: "openrouter",
          upstreamRuntime: "openrouter",
          upstreamModel: "z-ai/glm-5-turbo",
          upstreamAccountId: "openrouter-main",
          finishReason: "tool_calls",
          upstreamRequestId: "up_req_1a",
          upstreamHttpStatus: 200,
          errorCode: null,
          contentChars: 0,
          toolCallCount: 1,
          toolNames: ["write_file"],
          rawResponseHash: "c".repeat(64),
          rawResponseChars: 48,
          emptyStop: false
        },
        {
          index: 2,
          kind: "validation_failed_to_auto",
          toolChoice: "auto",
          provider: "openrouter",
          upstreamRuntime: "openrouter",
          upstreamModel: "z-ai/glm-5-turbo",
          upstreamAccountId: "openrouter-main",
          finishReason: "stop",
          upstreamRequestId: "up_req_1",
          upstreamHttpStatus: 200,
          errorCode: null,
          contentChars: 0,
          toolCallCount: 0,
          toolNames: [],
          rawResponseHash: "d".repeat(64),
          rawResponseChars: 48,
          emptyStop: true
        }
      ],
      startedAt: new Date("2026-05-07T03:32:03Z"),
      durationMs: 1200,
      firstByteMs: 900,
      status: "ok",
      errorCode: null,
      rateLimited: false
    });
    gatewayStore.close();

    const unifiedKey = `cmev1.${issued.token}.mev2_live_test_secret`;
    const rawMessages = runCliRaw(
      dbPath,
      [
        "--client-events-db",
        clientEventsDbPath,
        "client-messages",
        "--unified-key-env",
        "SUPPORT_UNIFIED_KEY",
        "--limit",
        "1",
        "--preview-chars",
        "12",
        "--timezone",
        "Asia/Shanghai"
      ],
      { SUPPORT_UNIFIED_KEY: unifiedKey }
    );
    expect(rawMessages).not.toContain(issued.token);
    expect(rawMessages).not.toContain(unifiedKey);
    expect(rawMessages).not.toContain("mev2_live_test_secret");
    expect(rawMessages).not.toContain(prompt);

    const messages = JSON.parse(rawMessages) as {
      subject: { id: string; name: string };
      credential: { prefix: string; token?: string };
      messages: Array<{
        credential_prefix: string;
        text_preview: string;
        text?: string;
        received_at_local: string;
        attachments_count: number;
        pdf_attachment_count: number;
        pdf_total_bytes: number;
        pdf_max_bytes: number;
        pdf_total_pages: number;
        pdf_max_pages: number;
        pdf_extracted_chars: number;
        pdf_chunk_count: number;
      }>;
    };
    expect(messages.subject).toMatchObject({ id: "duheng", name: "杜衡" });
    expect(messages.credential).toMatchObject({ prefix: issued.credential.prefix });
    expect(messages.credential.token).toBeUndefined();
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]).toMatchObject({
      credential_prefix: issued.credential.prefix,
      text_preview: "请不要调用 MedEvi...",
      received_at_local: "2026-05-07 11:31:19 Asia/Shanghai",
      attachments_count: 1,
      pdf_attachment_count: 1,
      pdf_total_bytes: 12_345_678,
      pdf_max_bytes: 12_345_678,
      pdf_total_pages: 24,
      pdf_max_pages: 24,
      pdf_extracted_chars: 98_765,
      pdf_chunk_count: 9
    });
    expect(messages.messages[0].text).toBeUndefined();

    const fullText = runCli(dbPath, [
      "--client-events-db",
      clientEventsDbPath,
      "client-messages",
      "--user",
      "杜衡",
      "--include-text",
      "--limit",
      "1"
    ]) as { messages: Array<{ text: string }> };
    expect(fullText.messages[0]?.text).toBe(prompt);

    const diagnostics = runCli(dbPath, [
      "--client-events-db",
      clientEventsDbPath,
      "client-diagnostics",
      "--credential-prefix",
      issued.credential.prefix,
      "--request-id",
      "me_req_1",
      "--include-metadata"
    ]) as {
      diagnostics: Array<{
        category: string;
        action: string;
        metadata_request_id: string;
        metadata_article_id: string;
        request_shape_pdf_count: number;
        request_shape_pdf_total_bytes: number;
        request_shape_pdf_max_bytes: number;
        request_shape_file_total_bytes: number;
        request_shape_media_base64_bytes: number;
        request_shape_estimated_prompt_tokens: number;
        request_shape_tools_schema_bytes: number;
        request_shape_pdf_context_overflow: boolean;
        metadata: { tool_name: string };
      }>;
    };
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({
        category: "tool",
        action: "medevidence",
        metadata_request_id: "me_req_1",
        metadata_client_turn_id: "msg_duheng_1",
        metadata_turn_code: "T:7K3P2",
        metadata_gateway_request_id: "req_model_turn_1",
        metadata_article_id: "article_1",
        request_shape_pdf_count: 1,
        request_shape_pdf_total_bytes: 12_345_678,
        request_shape_pdf_max_bytes: 12_345_678,
        request_shape_file_total_bytes: 12_345_678,
        request_shape_media_base64_bytes: 16_460_904,
        request_shape_estimated_prompt_tokens: 101_234,
        request_shape_tools_schema_bytes: 4096,
        request_shape_pdf_context_overflow: true,
        metadata: expect.objectContaining({ tool_name: "medevidence" })
      })
    ]);

    const clientTurn = runCli(dbPath, [
      "--client-events-db",
      clientEventsDbPath,
      "client-turn",
      "T:7K3P2",
      "--at",
      "2026-05-07 11:32",
      "--window-minutes",
      "10",
      "--timezone",
      "Asia/Shanghai",
      "--include-metadata"
    ]) as {
      client_diagnostics: Array<{ metadata_turn_code: string; metadata_gateway_request_id: string }>;
      gateway_requests: Array<{
        request_id: string;
        public_model_id: string;
        resolved_upstream_model: string;
        reasoning_effort: string;
        upstream_empty_stop: boolean;
        upstream_attempt_count: number;
        upstream_attempts: Array<{ kind: string; toolChoice: string }>;
        gateway_estimated_prompt_tokens: number;
        gateway_context_utilization: number;
        gateway_estimate_to_provider_prompt_ratio: number;
        tool_loop_guard: { decision: string; candidateCallCount: number };
      }>;
      timeline: Array<{ source: string; request_id: string }>;
    };
    expect(clientTurn.client_diagnostics).toEqual([
      expect.objectContaining({
        metadata_turn_code: "T:7K3P2",
        metadata_gateway_request_id: "req_model_turn_1"
      })
    ]);
    expect(clientTurn.gateway_requests).toEqual([
      expect.objectContaining({
        request_id: "req_model_turn_1",
        public_model_id: "pro",
        resolved_upstream_model: "z-ai/glm-5-turbo",
        reasoning_effort: "none",
        upstream_empty_stop: true,
        upstream_attempt_count: 2,
        gateway_estimated_prompt_tokens: 110_000,
        gateway_context_utilization: 0.55,
        gateway_estimate_to_provider_prompt_ratio: 1.1,
        tool_loop_guard: expect.objectContaining({
          decision: "shadow_warn",
          candidateCallCount: 8
        }),
        upstream_attempts: [
          expect.objectContaining({ kind: "native_initial", toolChoice: "required" }),
          expect.objectContaining({ kind: "validation_failed_to_auto", toolChoice: "auto" })
        ]
      })
    ]);
    expect(clientTurn.timeline.map((row) => row.source)).toEqual([
      "client_diagnostic",
      "gateway_request"
    ]);

    const auditJsonl = runCliRaw(dbPath, [
      "--client-events-db",
      clientEventsDbPath,
      "client-medevidence-tool-audit",
      "--since",
      "2026-05-07T00:00:00Z",
      "--timezone",
      "Asia/Shanghai",
      "--format",
      "jsonl",
      "--limit",
      "5"
    ]);
    const auditRows = auditJsonl
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(auditRows).toEqual([
      expect.objectContaining({
        request_id: "me_req_1",
        session_id: "ses_duheng_1",
        message_id: "msg_duheng_1",
        tool_call_id: "toolu_medevidence_1",
        agent: "research",
        status: "started",
        selected_backend: "cn2",
        entrypoint: "gateway",
        question: medevidenceToolText,
        question_length: medevidenceToolText.length,
        original_user_text: prompt,
        original_user_hash: "o".repeat(64),
        question_same_as_user: false,
        question_derived: true,
        medevidence_question_guard: { outcome: "accepted" },
        guard_reject_count: 1,
        tool_outcome: "called"
      })
    ]);

    const auditCsv = runCliRaw(dbPath, [
      "--client-events-db",
      clientEventsDbPath,
      "client-medevidence-tool-audit",
      "--since",
      "2026-05-07T00:00:00Z",
      "--format",
      "csv",
      "--limit",
      "5"
    ]);
    expect(auditCsv.split(/\r?\n/)[0]).toContain("request_id,");
    expect(auditCsv).toContain("me_req_1");
  }, 20_000);

  it("keeps stdout as clean JSON when migrating a legacy request-event database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-legacy-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    createLegacyUpstreamAccountDb(dbPath);

    const raw = runCliRaw(dbPath, ["events", "--limit", "1"]);
    const parsed = JSON.parse(raw) as {
      events: Array<{ request_id: string; upstream_account_id: string }>;
    };

    expect(parsed.events).toEqual([
      {
        ...parsed.events[0],
        request_id: "req_legacy",
        upstream_account_id: "sub_legacy"
      }
    ]);
    expect(raw).not.toContain("schema migrated");
  });
});

function runCli(dbPath: string, args: string[], env: Record<string, string> = {}): unknown {
  return JSON.parse(runCliRaw(dbPath, args, env));
}

function runCliRaw(dbPath: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", path.resolve("apps/admin-cli/src/index.ts"), "--db", dbPath, ...args],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        ...env,
        GATEWAY_API_KEY_ENCRYPTION_SECRET: "test-api-key-encryption-secret"
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}

function runCliRawAllowFailure(dbPath: string, args: string[]): string {
  try {
    return runCliRaw(dbPath, args);
  } catch (err) {
    const output = (err as { stdout?: string }).stdout;
    if (!output) {
      throw err;
    }
    return output;
  }
}

function createLegacyUpstreamAccountDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at) VALUES
        (1, '2026-01-01T00:00:00.000Z'),
        (2, '2026-01-01T00:00:00.000Z'),
        (3, '2026-01-01T00:00:00.000Z'),
        (4, '2026-01-01T00:00:00.000Z'),
        (5, '2026-01-01T00:00:00.000Z'),
        (6, '2026-01-01T00:00:00.000Z');

      CREATE TABLE subjects (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        name TEXT,
        phone_number TEXT
      );
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        state TEXT NOT NULL,
        health_json TEXT,
        last_used_at TEXT,
        cooldown_until TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE request_events (
        request_id TEXT PRIMARY KEY,
        credential_id TEXT,
        subject_id TEXT,
        scope TEXT,
        session_id TEXT,
        subscription_id TEXT,
        provider TEXT,
        started_at TEXT NOT NULL,
        duration_ms INTEGER,
        first_byte_ms INTEGER,
        status TEXT NOT NULL,
        error_code TEXT,
        rate_limited INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        cached_prompt_tokens INTEGER,
        estimated_tokens INTEGER,
        usage_source TEXT
      );

      INSERT INTO subjects (id, label, state, created_at)
        VALUES ('alice', 'Alice', 'active', '2026-01-01T00:00:00.000Z');
      INSERT INTO subscriptions (
        id, provider, label, credential_ref, state, created_at, updated_at
      ) VALUES (
        'sub_legacy', 'openai-codex', 'Legacy Codex', 'CODEX_HOME', 'active',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO request_events (
        request_id, subject_id, scope, subscription_id, provider, started_at, status
      ) VALUES (
        'req_legacy', 'alice', 'code', 'sub_legacy', 'openai-codex',
        '2026-01-01T00:00:00.000Z', 'ok'
      );
    `);
  } finally {
    db.close();
  }
}
