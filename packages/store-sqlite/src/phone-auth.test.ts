import { describe, expect, it } from "vitest";
import {
  issueAccessCredential,
  issueUnifiedClientKey,
  type PhoneAuthSession
} from "@codex-gateway/core";
import { createSqliteStore } from "./index.js";

const now = new Date("2026-08-20T00:00:00.000Z");

describe("SQLite phone auth store", () => {
  it("prepares an existing recoverable account without creating a new subject or key", () => {
    const { store, credential, unified } = seededStore();

    const identity = store.preparePhoneAuthIdentity({
      phoneHash: "hmac-sha256:phone-one",
      phoneCiphertext: "v1.phone",
      subjectId: "subj_internal",
      unifiedKeyId: unified.record.id,
      unifiedKeyTokenCiphertext: "v1.unified",
      unifiedKeyMetadata: { medevidence_base_url: "https://medevidence.test" },
      backingAllowedPublicModels: ["goldencode"],
      requestId: "req_prepare",
      now
    });

    expect(identity).toMatchObject({
      phoneHash: "hmac-sha256:phone-one",
      subjectId: "subj_internal",
      unifiedKeyId: unified.record.id,
      state: "active"
    });
    expect(store.listSubjects()).toHaveLength(1);
    expect(store.listUnifiedClientKeys()).toHaveLength(1);
    expect(store.getUnifiedClientKeyByPrefix(unified.record.prefix)).toMatchObject({
      tokenCiphertext: "v1.unified",
      credentialClass: "desktop",
      isCurrent: true,
      metadata: { medevidence_base_url: "https://medevidence.test" }
    });
    expect(store.getAccessCredentialByPrefix(credential.record.prefix)).toMatchObject({
      credentialClass: "desktop",
      allowedPublicModels: ["goldencode"]
    });
    expect(
      store.database
        .prepare("SELECT action, phone_hash FROM phone_auth_audit_events")
        .get()
    ).toMatchObject({
      action: "prepare_identity",
      phone_hash: "hmac-sha256:phone-one"
    });
    store.close();
  });

  it("rotates refresh tokens atomically and revokes the family on replay", () => {
    const { store, unified } = seededStore();
    store.preparePhoneAuthIdentity({
      phoneHash: "hmac-sha256:phone-one",
      phoneCiphertext: "v1.phone",
      subjectId: "subj_internal",
      unifiedKeyId: unified.record.id,
      unifiedKeyTokenCiphertext: "v1.unified",
      unifiedKeyMetadata: { medevidence_base_url: "https://medevidence.test" },
      backingAllowedPublicModels: ["goldencode"],
      requestId: "req_prepare",
      now
    });
    const session = phoneSession();
    store.createPhoneAuthSession({
      session,
      refreshToken: {
        id: "phrt_first",
        sessionId: session.id,
        prefix: "first",
        hash: "sha256:first",
        generation: 0,
        state: "active",
        expiresAt: new Date("2026-09-19T00:00:00.000Z"),
        rotatedAt: null,
        createdAt: now
      },
      requestId: "req_login"
    });

    expect(
      store.rotatePhoneAuthRefreshToken({
        refreshTokenHash: "sha256:first",
        deviceId: session.deviceId,
        replacement: {
          id: "phrt_second",
          prefix: "second",
          hash: "sha256:second",
          state: "active",
          expiresAt: new Date("2027-12-31T00:00:00.000Z"),
          rotatedAt: null,
          createdAt: new Date("2026-08-21T00:00:00.000Z")
        },
        requestId: "req_refresh",
        now: new Date("2026-08-21T00:00:00.000Z")
      })
    ).toMatchObject({ status: "ok", session: { id: session.id } });
    expect(
      store.database
        .prepare(
          "SELECT generation, state, expires_at FROM phone_auth_refresh_tokens WHERE id = 'phrt_second'"
        )
        .get()
    ).toMatchObject({
      generation: 1,
      state: "active",
      expires_at: session.absoluteExpiresAt.toISOString()
    });

    expect(
      store.rotatePhoneAuthRefreshToken({
        refreshTokenHash: "sha256:first",
        deviceId: session.deviceId,
        replacement: {
          id: "phrt_unused",
          prefix: "unused",
          hash: "sha256:unused",
          state: "active",
          expiresAt: new Date("2026-09-20T00:00:00.000Z"),
          rotatedAt: null,
          createdAt: new Date("2026-08-22T00:00:00.000Z")
        },
        requestId: "req_replay",
        now: new Date("2026-08-22T00:00:00.000Z")
      })
    ).toEqual({ status: "replay" });
    expect(store.getPhoneAuthSession(session.id)?.state).toBe("revoked");
    expect(
      store.database
        .prepare("SELECT state FROM phone_auth_refresh_tokens WHERE id = 'phrt_second'")
        .get()
    ).toMatchObject({ state: "revoked" });
    store.close();
  });

  it("revokes active sessions when an identity is disabled", () => {
    const { store, unified } = seededStore();
    store.preparePhoneAuthIdentity({
      phoneHash: "hmac-sha256:phone-one",
      phoneCiphertext: "v1.phone",
      subjectId: "subj_internal",
      unifiedKeyId: unified.record.id,
      unifiedKeyTokenCiphertext: "v1.unified",
      unifiedKeyMetadata: { medevidence_base_url: "https://medevidence.test" },
      backingAllowedPublicModels: ["goldencode"],
      requestId: "req_prepare",
      now
    });
    const session = phoneSession();
    store.createPhoneAuthSession({
      session,
      refreshToken: {
        id: "phrt_first",
        sessionId: session.id,
        prefix: "first",
        hash: "sha256:first",
        generation: 0,
        state: "active",
        expiresAt: new Date("2026-09-19T00:00:00.000Z"),
        rotatedAt: null,
        createdAt: now
      },
      requestId: "req_login"
    });

    store.setPhoneAuthIdentityState("hmac-sha256:phone-one", "disabled", {
      requestId: "req_disable",
      action: "identity_state",
      phoneHash: "hmac-sha256:phone-one",
      subjectId: "subj_internal",
      sessionId: null,
      authMethod: null,
      outcome: "ok",
      reasonCode: "disabled",
      now: new Date("2026-08-21T00:00:00.000Z")
    });

    expect(store.getPhoneAuthSession(session.id)).toMatchObject({
      state: "revoked",
      revokedAt: new Date("2026-08-21T00:00:00.000Z")
    });
    store.close();
  });
});

function seededStore() {
  const store = createSqliteStore({ path: ":memory:" });
  store.upsertSubject({
    id: "subj_internal",
    label: "Internal user",
    state: "active",
    createdAt: now
  });
  const credential = issueAccessCredential({
    subjectId: "subj_internal",
    label: "Desktop backing key",
    scope: "code",
    expiresAt: new Date("2027-08-20T00:00:00.000Z"),
    now
  });
  store.insertAccessCredential(credential.record);
  const unified = issueUnifiedClientKey({
    subjectId: "subj_internal",
    label: "medevidence-internal",
    expiresAt: new Date("2027-08-20T00:00:00.000Z"),
    codexCredentialId: credential.record.id,
    codexCredentialPrefix: credential.record.prefix,
    codexKeyCiphertext: "v1.codex",
    medevidenceKeyCiphertext: "v1.medevidence",
    medevidenceKeyPrefix: "medevidence-prefix",
    now
  });
  store.insertUnifiedClientKey(unified.record);
  return { store, credential, unified };
}

function phoneSession(): PhoneAuthSession {
  return {
    id: "phas_session",
    subjectId: "subj_internal",
    phoneHash: "hmac-sha256:phone-one",
    deviceId: "desktop-device-example-01",
    client: "medevidence-desktop",
    authMethod: "transition_phone_only",
    state: "active",
    absoluteExpiresAt: new Date("2027-02-16T00:00:00.000Z"),
    revokedAt: null,
    createdAt: now,
    updatedAt: now
  };
}
