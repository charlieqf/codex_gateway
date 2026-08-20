import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject
} from "node:crypto";
import {
  checkAccessCredentialState,
  decryptSecret,
  encryptSecret,
  extractUnifiedClientKeyPrefix,
  GatewayError,
  hashPhoneAuthRefreshToken,
  issuePhoneAuthRefreshToken,
  normalizeMainlandChinaPhone,
  phoneLookupHash,
  unifiedClientKeyTokenPrefix,
  verifyAccessCredentialToken,
  verifyUnifiedClientKeyToken,
  type CredentialAuthStore,
  type PhoneAuthAuditAction,
  type PhoneAuthAuditInput,
  type PhoneAuthIdentity,
  type PhoneAuthMethod,
  type PhoneAuthMode,
  type PhoneAuthSession,
  type PhoneAuthStore,
  type PlanEntitlementStore,
  type UnifiedClientKeyRecord,
  type UnifiedClientKeyStore
} from "@codex-gateway/core";
import { resolvePemSecret, resolveProviderApiKey } from "./provider-secret.js";

export const phoneAuthGatewayOrigin =
  "https://goldencode.instmarket.com.au:1443";
export const phoneAuthMedevidenceOrigin =
  "https://gw-47-116-7-37.nip.io";

export interface PhoneAuthServiceOptions {
  mode: PhoneAuthMode;
  store: PhoneAuthStore;
  credentialStore: CredentialAuthStore;
  unifiedKeyStore: UnifiedClientKeyStore;
  entitlementStore: PlanEntitlementStore;
  publicGatewayBaseUrl: string;
  issuer: string;
  audience: string;
  activeKid: string | null;
  privateKeyPem: string | null;
  phoneLookupSecret: string | null;
  phoneEncryptionSecret: string | null;
  unifiedKeyRecoverySecret: string | null;
  apiKeyEncryptionSecret: string | null;
  accessTtlSeconds?: number;
  refreshIdleDays?: number;
  sessionAbsoluteDays?: number;
  now?: () => Date;
}

export interface PhoneAuthLoginInput {
  phone: string;
  deviceId: string;
  requestId: string;
}

export interface PhoneAuthRefreshInput {
  refreshToken: string;
  deviceId: string;
  requestId: string;
}

export interface PreparePhoneAuthInput {
  phone: string;
  subjectId: string;
  unifiedKey: string;
  requestId: string;
}

export interface PhoneAuthTokenResponse {
  status: "authenticated";
  auth_method: PhoneAuthMethod;
  token_type: "Bearer";
  access_token: string;
  expires_in_seconds: number;
  refresh_token: string;
  refresh_idle_expires_in_seconds: number;
  session_absolute_expires_at: string;
  subject: { id: string; state: "active" };
}

export interface PhoneAuthAccessContext {
  session: PhoneAuthSession;
  subjectId: string;
}

interface AccessTokenPayload {
  iss: string;
  aud: string;
  sub: string;
  sid: string;
  auth_method: PhoneAuthMethod;
  credential_class: "desktop";
  iat: number;
  exp: number;
  jti: string;
}

interface ReadyAccount {
  unifiedKey: UnifiedClientKeyRecord;
  planId: string;
  periodEnd: Date | null;
  capabilities: string[];
}

const secondsPerDay = 86_400;
const defaultAccessTtlSeconds = 900;
const defaultRefreshIdleDays = 30;
const defaultSessionAbsoluteDays = 180;

export function resolvePhoneAuthServiceOptions(
  env: NodeJS.ProcessEnv,
  dependencies: Pick<
    PhoneAuthServiceOptions,
    "store" | "credentialStore" | "unifiedKeyStore" | "entitlementStore" | "now"
  >
): PhoneAuthServiceOptions {
  const mode = resolvePhoneAuthMode(env.GATEWAY_PHONE_AUTH_MODE);
  return {
    ...dependencies,
    mode,
    publicGatewayBaseUrl: phoneAuthGatewayOrigin,
    issuer:
      env.GATEWAY_PHONE_AUTH_ISSUER?.trim() ||
      `${phoneAuthGatewayOrigin}/gateway/auth/v1`,
    audience: env.GATEWAY_PHONE_AUTH_AUDIENCE?.trim() || "codex-gateway",
    activeKid: env.GATEWAY_PHONE_AUTH_JWT_ACTIVE_KID?.trim() || null,
    privateKeyPem: resolvePemSecret(
      env,
      "GATEWAY_PHONE_AUTH_JWT_PRIVATE_KEY"
    ).apiKey,
    phoneLookupSecret: resolveProviderApiKey(
      env,
      "GATEWAY_PHONE_LOOKUP_HMAC_SECRET"
    ).apiKey,
    phoneEncryptionSecret: resolveProviderApiKey(
      env,
      "GATEWAY_PHONE_DATA_ENCRYPTION_KEY"
    ).apiKey,
    unifiedKeyRecoverySecret: resolveProviderApiKey(
      env,
      "GATEWAY_UNIFIED_KEY_RECOVERY_KEY"
    ).apiKey,
    apiKeyEncryptionSecret:
      env.GATEWAY_API_KEY_ENCRYPTION_SECRET?.trim() || null,
    accessTtlSeconds: boundedPositiveIntegerEnv(
      env.GATEWAY_PHONE_AUTH_ACCESS_TTL_SECONDS,
      defaultAccessTtlSeconds,
      3_600,
      "GATEWAY_PHONE_AUTH_ACCESS_TTL_SECONDS"
    ),
    refreshIdleDays: boundedPositiveIntegerEnv(
      env.GATEWAY_PHONE_AUTH_REFRESH_IDLE_DAYS,
      defaultRefreshIdleDays,
      90,
      "GATEWAY_PHONE_AUTH_REFRESH_IDLE_DAYS"
    ),
    sessionAbsoluteDays: boundedPositiveIntegerEnv(
      env.GATEWAY_PHONE_AUTH_SESSION_ABSOLUTE_DAYS,
      defaultSessionAbsoluteDays,
      365,
      "GATEWAY_PHONE_AUTH_SESSION_ABSOLUTE_DAYS"
    )
  };
}

export class PhoneAuthService {
  readonly mode: PhoneAuthMode;
  readonly publicGatewayBaseUrl: string;
  readonly accessTtlSeconds: number;
  readonly refreshIdleSeconds: number;
  private readonly store: PhoneAuthStore;
  private readonly credentialStore: CredentialAuthStore;
  private readonly unifiedKeyStore: UnifiedClientKeyStore;
  private readonly entitlementStore: PlanEntitlementStore;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly activeKid: string | null;
  private readonly privateKey: KeyObject | null;
  private readonly publicKey: KeyObject | null;
  private readonly phoneLookupSecret: string | null;
  private readonly phoneEncryptionSecret: string | null;
  private readonly unifiedKeyRecoverySecret: string | null;
  private readonly apiKeyEncryptionSecret: string | null;
  private readonly sessionAbsoluteSeconds: number;
  private readonly now: () => Date;

  constructor(options: PhoneAuthServiceOptions) {
    this.mode = options.mode;
    this.store = options.store;
    this.credentialStore = options.credentialStore;
    this.unifiedKeyStore = options.unifiedKeyStore;
    this.entitlementStore = options.entitlementStore;
    this.publicGatewayBaseUrl = normalizeRequiredBaseUrl(options.publicGatewayBaseUrl);
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.activeKid = options.activeKid;
    this.phoneLookupSecret = options.phoneLookupSecret;
    this.phoneEncryptionSecret = options.phoneEncryptionSecret;
    this.unifiedKeyRecoverySecret = options.unifiedKeyRecoverySecret;
    this.apiKeyEncryptionSecret = options.apiKeyEncryptionSecret;
    this.accessTtlSeconds = positiveInteger(
      options.accessTtlSeconds ?? defaultAccessTtlSeconds,
      "accessTtlSeconds"
    );
    this.refreshIdleSeconds =
      positiveInteger(options.refreshIdleDays ?? defaultRefreshIdleDays, "refreshIdleDays") *
      secondsPerDay;
    this.sessionAbsoluteSeconds =
      positiveInteger(
        options.sessionAbsoluteDays ?? defaultSessionAbsoluteDays,
        "sessionAbsoluteDays"
      ) * secondsPerDay;
    this.now = options.now ?? (() => new Date());

    if (options.privateKeyPem) {
      const privateKey = createPrivateKey(options.privateKeyPem);
      if (privateKey.asymmetricKeyType !== "ed25519") {
        throw new Error("Phone auth JWT private key must be Ed25519.");
      }
      this.privateKey = privateKey;
      this.publicKey = createPublicKey(privateKey);
    } else {
      this.privateKey = null;
      this.publicKey = null;
    }
    if (this.mode === "transition") {
      this.assertRuntimeConfigured();
    }
  }

  phoneHash(phone: string): string {
    const normalized = normalizeMainlandChinaPhone(phone);
    if (!normalized) {
      throw invalidRequest();
    }
    return phoneLookupHash(normalized, this.requiredPhoneLookupSecret());
  }

  prepareIdentity(input: PreparePhoneAuthInput): PhoneAuthIdentity {
    const normalizedPhone = normalizeMainlandChinaPhone(input.phone);
    if (!normalizedPhone || !input.subjectId) {
      throw invalidRequest();
    }
    const subject = this.credentialStore.getSubject(input.subjectId);
    if (!subject) {
      throw new GatewayError({
        code: "subject_not_found",
        message: "Subject does not exist.",
        httpStatus: 404
      });
    }
    if (normalizeMainlandChinaPhone(subject.phoneNumber ?? "") !== normalizedPhone) {
      throw new GatewayError({
        code: "account_migration_required",
        message: "The Subject does not have this registered phone.",
        httpStatus: 409
      });
    }
    const matchingSubjects = this.credentialStore
      .listSubjects({ includeArchived: true })
      .filter(
        (candidate) =>
          normalizeMainlandChinaPhone(candidate.phoneNumber ?? "") === normalizedPhone
      );
    if (
      matchingSubjects.length !== 1 ||
      matchingSubjects[0]?.id !== input.subjectId
    ) {
      throw new GatewayError({
        code: "phone_identity_conflict",
        message: "The registered phone does not map to one unique Subject.",
        httpStatus: 409
      });
    }
    const prefix = extractUnifiedClientKeyPrefix(input.unifiedKey);
    const key = prefix ? this.unifiedKeyStore.getUnifiedClientKeyByPrefix(prefix) : null;
    const now = this.now();
    if (
      !key ||
      key.subjectId !== input.subjectId ||
      verifyUnifiedClientKeyToken(input.unifiedKey, key, now)
    ) {
      throw new GatewayError({
        code: "account_migration_required",
        message: "The current unified key cannot be recovered.",
        httpStatus: 409
      });
    }
    this.requireRuntimeBundle(key, now, false);
    this.requireActiveInternalAccount(input.subjectId, now);
    const phoneHash = phoneLookupHash(
      normalizedPhone,
      this.requiredPhoneLookupSecret()
    );
    return this.store.preparePhoneAuthIdentity({
      phoneHash,
      phoneCiphertext: encryptSecret(
        normalizedPhone,
        requiredSecret(this.phoneEncryptionSecret, "phone encryption")
      ),
      subjectId: input.subjectId,
      unifiedKeyId: key.id,
      unifiedKeyTokenCiphertext: encryptSecret(
        input.unifiedKey,
        requiredSecret(this.unifiedKeyRecoverySecret, "unified key recovery")
      ),
      unifiedKeyMetadata: {
        ...(key.metadata ?? {}),
        medevidence_base_url: phoneAuthMedevidenceOrigin
      },
      backingAllowedPublicModels: ["goldencode"],
      requestId: input.requestId,
      now
    });
  }

  setIdentityState(
    subjectId: string,
    state: "active" | "disabled",
    requestId: string
  ): PhoneAuthIdentity | null {
    const identity = this.store.getPhoneAuthIdentityBySubjectId(subjectId);
    if (!identity) {
      return null;
    }
    return this.store.setPhoneAuthIdentityState(identity.phoneHash, state, {
      requestId,
      action: "identity_state",
      phoneHash: identity.phoneHash,
      subjectId,
      sessionId: null,
      authMethod: null,
      outcome: "ok",
      reasonCode: state,
      now: this.now()
    });
  }

  login(input: PhoneAuthLoginInput): PhoneAuthTokenResponse {
    this.assertLoginEnabled();
    const now = this.now();
    const phoneHash = this.phoneHash(input.phone);
    const identity = this.store.getPhoneAuthIdentityByPhoneHash(phoneHash);
    if (!identity) {
      this.auditFailure("login", input.requestId, phoneHash, null, null, "phone_not_registered", now);
      throw phoneNotRegistered();
    }
    if (identity.state !== "active") {
      this.auditFailure("login", input.requestId, phoneHash, identity.subjectId, null, "account_disabled", now);
      throw accountDisabled();
    }
    try {
      this.requireReadyAccountForIdentity(identity, now);
    } catch (error) {
      this.auditFailure(
        "login",
        input.requestId,
        phoneHash,
        identity.subjectId,
        null,
        error instanceof GatewayError ? error.code : "service_unavailable",
        now
      );
      throw error;
    }

    const session: PhoneAuthSession = {
      id: `phas_${randomUUID().replaceAll("-", "")}`,
      subjectId: identity.subjectId,
      phoneHash,
      deviceId: input.deviceId,
      client: "medevidence-desktop",
      authMethod: "transition_phone_only",
      state: "active",
      absoluteExpiresAt: addSeconds(now, this.sessionAbsoluteSeconds),
      revokedAt: null,
      createdAt: now,
      updatedAt: now
    };
    const refresh = issuePhoneAuthRefreshToken();
    const refreshExpiresAt = minDate(
      addSeconds(now, this.refreshIdleSeconds),
      session.absoluteExpiresAt
    );
    this.store.createPhoneAuthSession({
      session,
      refreshToken: {
        id: `phrt_${randomUUID().replaceAll("-", "")}`,
        sessionId: session.id,
        prefix: refresh.prefix,
        hash: refresh.hash,
        generation: 0,
        state: "active",
        expiresAt: refreshExpiresAt,
        rotatedAt: null,
        createdAt: now
      },
      requestId: input.requestId
    });
    return this.tokenResponse(session, refresh.token, refreshExpiresAt, now);
  }

  refresh(input: PhoneAuthRefreshInput): PhoneAuthTokenResponse {
    this.assertLoginEnabled();
    if (!/^rft_[A-Za-z0-9_-]{64}$/u.test(input.refreshToken)) {
      this.auditFailure(
        "refresh",
        input.requestId,
        null,
        null,
        null,
        "refresh_token_invalid",
        this.now()
      );
      throw refreshTokenInvalid();
    }
    const now = this.now();
    const replacement = issuePhoneAuthRefreshToken();
    const replacementExpiresAt = addSeconds(now, this.refreshIdleSeconds);
    const result = this.store.rotatePhoneAuthRefreshToken({
      refreshTokenHash: hashPhoneAuthRefreshToken(input.refreshToken),
      deviceId: input.deviceId,
      replacement: {
        id: `phrt_${randomUUID().replaceAll("-", "")}`,
        prefix: replacement.prefix,
        hash: replacement.hash,
        state: "active",
        expiresAt: replacementExpiresAt,
        rotatedAt: null,
        createdAt: now
      },
      requestId: input.requestId,
      now
    });
    if (result.status !== "ok") {
      throw refreshTokenInvalid();
    }
    try {
      const identity = this.store.getPhoneAuthIdentityByPhoneHash(
        result.session.phoneHash
      );
      if (!identity || identity.subjectId !== result.session.subjectId) {
        throw accountDisabled();
      }
      this.requireReadyAccountForIdentity(identity, now);
    } catch (error) {
      this.revokeAfterFailedRefresh(result.session, input.requestId, now);
      throw error;
    }
    const expiresAt = minDate(replacementExpiresAt, result.session.absoluteExpiresAt);
    return this.tokenResponse(result.session, replacement.token, expiresAt, now);
  }

  authenticateAccessToken(
    token: string,
    allowRevokedSession = false
  ): PhoneAuthAccessContext {
    this.assertLoginEnabled();
    const payload = this.verifyAccessToken(token);
    const session = this.store.getPhoneAuthSession(payload.sid);
    const now = this.now();
    if (
      !session ||
      session.subjectId !== payload.sub ||
      session.authMethod !== payload.auth_method ||
      session.absoluteExpiresAt.getTime() <= now.getTime() ||
      (!allowRevokedSession && session.state !== "active")
    ) {
      throw accessTokenInvalid();
    }
    return { session, subjectId: session.subjectId };
  }

  logout(token: string, requestId: string): void {
    const context = this.authenticateAccessToken(token, true);
    this.store.revokePhoneAuthSession(context.session.id, {
      requestId,
      action: "logout",
      phoneHash: context.session.phoneHash,
      subjectId: context.session.subjectId,
      sessionId: context.session.id,
      authMethod: context.session.authMethod,
      outcome: "ok",
      reasonCode: "logout",
      now: this.now()
    });
  }

  bootstrap(token: string, requestId: string) {
    const context = this.authenticateAccessToken(token);
    const account = this.requireReadyAccountForSession(context.session, this.now());
    const unifiedKey = this.recoverUnifiedKey(account.unifiedKey);
    this.recordSuccess("bootstrap", requestId, context.session);
    return {
      contract_version: 1,
      subject: { id: context.subjectId, state: "active" as const },
      unified_key: {
        key: unifiedKey,
        key_prefix: `${unifiedClientKeyTokenPrefix}${account.unifiedKey.prefix}`,
        expires_at: account.unifiedKey.expiresAt.toISOString()
      },
      resolver_url: `${this.publicGatewayBaseUrl}/gateway/unified-keys/resolve`,
      account_url: `${this.publicGatewayBaseUrl}/gateway/account/v1/current`
    };
  }

  accountCurrent(token: string, requestId: string) {
    const context = this.authenticateAccessToken(token);
    const account = this.requireReadyAccountForSession(context.session, this.now());
    this.recordSuccess("account_current", requestId, context.session);
    return {
      subject: { id: context.subjectId, state: "active" as const },
      identity: {
        kind: "internal" as const,
        plan_id: account.planId,
        period_end: account.periodEnd?.toISOString() ?? null
      },
      token_wallet: null,
      image_credits: null,
      capabilities: account.capabilities
    };
  }

  recordLoginRateLimit(phoneHash: string, requestId: string): void {
    this.auditFailure(
      "login",
      requestId,
      phoneHash,
      null,
      null,
      "auth_rate_limited",
      this.now()
    );
  }

  private tokenResponse(
    session: PhoneAuthSession,
    refreshToken: string,
    refreshExpiresAt: Date,
    now: Date
  ): PhoneAuthTokenResponse {
    return {
      status: "authenticated",
      auth_method: session.authMethod,
      token_type: "Bearer",
      access_token: this.signAccessToken(session, now),
      expires_in_seconds: this.accessTtlSeconds,
      refresh_token: refreshToken,
      refresh_idle_expires_in_seconds: Math.max(
        0,
        Math.floor((refreshExpiresAt.getTime() - now.getTime()) / 1000)
      ),
      session_absolute_expires_at: session.absoluteExpiresAt.toISOString(),
      subject: { id: session.subjectId, state: "active" }
    };
  }

  private signAccessToken(session: PhoneAuthSession, now: Date): string {
    if (!this.privateKey || !this.activeKid) {
      throw phoneAuthUnavailable();
    }
    const issuedAt = Math.floor(now.getTime() / 1000);
    const header = encodeJwtPart({ alg: "EdDSA", kid: this.activeKid, typ: "JWT" });
    const payload = encodeJwtPart({
      iss: this.issuer,
      aud: this.audience,
      sub: session.subjectId,
      sid: session.id,
      auth_method: session.authMethod,
      credential_class: "desktop",
      iat: issuedAt,
      exp: issuedAt + this.accessTtlSeconds,
      jti: `phat_${randomUUID().replaceAll("-", "")}`
    } satisfies AccessTokenPayload);
    const signingInput = `${header}.${payload}`;
    const signature = sign(null, Buffer.from(signingInput), this.privateKey).toString(
      "base64url"
    );
    return `${signingInput}.${signature}`;
  }

  private verifyAccessToken(token: string): AccessTokenPayload {
    if (!this.publicKey || !this.activeKid || token.length > 4_096) {
      throw accessTokenInvalid();
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw accessTokenInvalid();
    }
    let header: unknown;
    let payload: unknown;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
      payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    } catch {
      throw accessTokenInvalid();
    }
    if (
      !isRecord(header) ||
      header.alg !== "EdDSA" ||
      header.kid !== this.activeKid ||
      header.typ !== "JWT" ||
      !verify(
        null,
        Buffer.from(`${parts[0]}.${parts[1]}`),
        this.publicKey,
        Buffer.from(parts[2]!, "base64url")
      ) ||
      !isAccessTokenPayload(payload, this.issuer, this.audience)
    ) {
      throw accessTokenInvalid();
    }
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (payload.exp <= nowSeconds) {
      throw new GatewayError({
        code: "access_token_expired",
        message: "The access token has expired.",
        httpStatus: 401
      });
    }
    if (
      payload.iat > nowSeconds + 60 ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat !== this.accessTtlSeconds
    ) {
      throw accessTokenInvalid();
    }
    return payload;
  }

  private requireReadyAccountForSession(
    session: PhoneAuthSession,
    now: Date
  ): ReadyAccount {
    const identity = this.store.getPhoneAuthIdentityByPhoneHash(session.phoneHash);
    if (
      !identity ||
      identity.subjectId !== session.subjectId ||
      identity.state !== "active"
    ) {
      throw accountDisabled();
    }
    return this.requireReadyAccountForIdentity(identity, now);
  }

  private requireReadyAccountForIdentity(
    identity: PhoneAuthIdentity,
    now: Date
  ): ReadyAccount {
    const subject = this.credentialStore.getSubject(identity.subjectId);
    if (!subject || subject.state !== "active") {
      throw accountDisabled();
    }
    const normalizedPhone = normalizeMainlandChinaPhone(
      subject.phoneNumber ?? ""
    );
    if (
      !normalizedPhone ||
      phoneLookupHash(normalizedPhone, this.requiredPhoneLookupSecret()) !==
        identity.phoneHash
    ) {
      throw accountMigrationRequired();
    }
    const matchingSubjects = this.credentialStore
      .listSubjects({ includeArchived: true })
      .filter(
        (candidate) =>
          normalizeMainlandChinaPhone(candidate.phoneNumber ?? "") ===
          normalizedPhone
      );
    if (
      matchingSubjects.length !== 1 ||
      matchingSubjects[0]?.id !== identity.subjectId
    ) {
      throw phoneIdentityConflict();
    }
    const unifiedKey = this.store.getPhoneAuthUnifiedKey(identity.unifiedKeyId);
    if (
      !unifiedKey ||
      unifiedKey.subjectId !== identity.subjectId ||
      unifiedKey.revokedAt ||
      unifiedKey.expiresAt.getTime() <= now.getTime() ||
      !unifiedKey.isCurrent ||
      unifiedKey.credentialClass !== "desktop" ||
      !unifiedKey.tokenCiphertext
    ) {
      throw accountMigrationRequired();
    }
    this.requireRuntimeBundle(unifiedKey, now, true);
    const entitlement = this.requireActiveInternalAccount(identity.subjectId, now);
    return {
      unifiedKey,
      planId: entitlement.planId,
      periodEnd: entitlement.periodEnd,
      capabilities: entitlement.capabilities
    };
  }

  private requireActiveInternalAccount(subjectId: string, now: Date) {
    const access = this.entitlementStore.entitlementAccessForSubject(subjectId, now);
    if (
      access.status !== "active" ||
      !access.plan ||
      !access.entitlement.scopeAllowlist.includes("code") ||
      !access.entitlement.featurePolicySnapshot.capabilities.includes("chat")
    ) {
      throw new GatewayError({
        code: "capability_not_allowed",
        message: "The internal plan does not allow chat.",
        httpStatus: 403
      });
    }
    return {
      planId: access.plan.id,
      periodEnd: access.entitlement.periodEnd,
      capabilities: [...access.entitlement.featurePolicySnapshot.capabilities]
    };
  }

  private requireRuntimeBundle(
    unifiedKey: UnifiedClientKeyRecord,
    now: Date,
    requireDesktopClass: boolean
  ): void {
    const credential = this.credentialStore.getAccessCredentialByPrefix(
      unifiedKey.codexCredentialPrefix
    );
    const allowedPublicModelsReady =
      credential?.allowedPublicModels?.includes("goldencode") === true ||
      (!requireDesktopClass && credential?.allowedPublicModels === null);
    const medevidenceBaseUrl = normalizeBaseUrl(
      metadataString(unifiedKey.metadata, "medevidence_base_url")
    );
    const medevidenceOriginReady =
      medevidenceBaseUrl === phoneAuthMedevidenceOrigin ||
      (!requireDesktopClass && medevidenceBaseUrl === null);
    if (
      !credential ||
      credential.id !== unifiedKey.codexCredentialId ||
      credential.subjectId !== unifiedKey.subjectId ||
      credential.scope !== "code" ||
      !allowedPublicModelsReady ||
      (requireDesktopClass && credential.credentialClass !== "desktop") ||
      checkAccessCredentialState(credential, now) ||
      !unifiedKey.medevidenceKeyPrefix ||
      !medevidenceOriginReady
    ) {
      throw accountMigrationRequired();
    }
    try {
      const secret = requiredSecret(
        this.apiKeyEncryptionSecret,
        "API key encryption"
      );
      const backingToken = decryptSecret(unifiedKey.codexKeyCiphertext, secret);
      const medevidenceToken = decryptSecret(
        unifiedKey.medevidenceKeyCiphertext,
        secret
      );
      if (
        !medevidenceToken ||
        verifyAccessCredentialToken(backingToken, credential, now)
      ) {
        throw accountMigrationRequired();
      }
    } catch (error) {
      if (error instanceof GatewayError) {
        throw error;
      }
      throw accountMigrationRequired();
    }
  }

  private recoverUnifiedKey(record: UnifiedClientKeyRecord): string {
    if (!record.tokenCiphertext) {
      throw accountMigrationRequired();
    }
    let token: string;
    try {
      token = decryptSecret(
        record.tokenCiphertext,
        requiredSecret(this.unifiedKeyRecoverySecret, "unified key recovery")
      );
    } catch {
      throw accountMigrationRequired();
    }
    if (verifyUnifiedClientKeyToken(token, record, this.now())) {
      throw accountMigrationRequired();
    }
    return token;
  }

  private recordSuccess(
    action: PhoneAuthAuditAction,
    requestId: string,
    session: PhoneAuthSession
  ): void {
    this.store.recordPhoneAuthAudit({
      requestId,
      action,
      phoneHash: session.phoneHash,
      subjectId: session.subjectId,
      sessionId: session.id,
      authMethod: session.authMethod,
      outcome: "ok",
      reasonCode: null,
      now: this.now()
    });
  }

  private auditFailure(
    action: PhoneAuthAuditAction,
    requestId: string,
    phoneHash: string | null,
    subjectId: string | null,
    sessionId: string | null,
    reasonCode: string,
    now: Date
  ): void {
    const audit: PhoneAuthAuditInput = {
      requestId,
      action,
      phoneHash,
      subjectId,
      sessionId,
      authMethod: "transition_phone_only",
      outcome: "error",
      reasonCode,
      now
    };
    this.store.recordPhoneAuthAudit(audit);
  }

  private revokeAfterFailedRefresh(
    session: PhoneAuthSession,
    requestId: string,
    now: Date
  ): void {
    this.store.revokePhoneAuthSession(session.id, {
      requestId,
      action: "refresh",
      phoneHash: session.phoneHash,
      subjectId: session.subjectId,
      sessionId: session.id,
      authMethod: session.authMethod,
      outcome: "error",
      reasonCode: "account_not_ready",
      now
    });
  }

  private requiredPhoneLookupSecret(): string {
    return requiredSecret(this.phoneLookupSecret, "phone lookup");
  }

  private assertRuntimeConfigured(): void {
    if (
      !this.privateKey ||
      !this.publicKey ||
      !this.activeKid ||
      !this.issuer ||
      !this.audience
    ) {
      throw new Error("Phone auth JWT configuration is incomplete.");
    }
    this.requiredPhoneLookupSecret();
    requiredSecret(this.phoneEncryptionSecret, "phone encryption");
    requiredSecret(this.unifiedKeyRecoverySecret, "unified key recovery");
    requiredSecret(this.apiKeyEncryptionSecret, "API key encryption");
  }

  private assertLoginEnabled(): void {
    if (this.mode !== "transition") {
      throw phoneAuthUnavailable();
    }
    this.assertRuntimeConfigured();
  }
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function isAccessTokenPayload(
  value: unknown,
  issuer: string,
  audience: string
): value is AccessTokenPayload {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.iss === issuer &&
    value.aud === audience &&
    typeof value.sub === "string" &&
    value.sub.length > 0 &&
    typeof value.sid === "string" &&
    value.sid.length > 0 &&
    value.auth_method === "transition_phone_only" &&
    value.credential_class === "desktop" &&
    Number.isInteger(value.iat) &&
    Number.isInteger(value.exp) &&
    typeof value.jti === "string" &&
    value.jti.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1_000);
}

function minDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function requiredSecret(value: string | null, name: string): string {
  if (!value || value.length < 32) {
    throw new GatewayError({
      code: "service_unavailable",
      message: `Phone auth ${name} secret is not configured.`,
      httpStatus: 503
    });
  }
  return value;
}

function normalizeRequiredBaseUrl(value: string): string {
  const normalized = value.replace(/\/+$/u, "");
  const url = new URL(normalized);
  if (url.protocol !== "https:" || url.pathname !== "/") {
    throw new Error("Phone auth public Gateway base URL must be an HTTPS origin.");
  }
  if (normalized !== phoneAuthGatewayOrigin) {
    throw new Error(`Phone auth origin must be ${phoneAuthGatewayOrigin}.`);
  }
  return normalized;
}

function metadataString(
  metadata: Record<string, unknown> | null,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeBaseUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function resolvePhoneAuthMode(value: string | undefined): PhoneAuthMode {
  const mode = value?.trim() || "disabled";
  if (mode === "disabled" || mode === "transition") {
    return mode;
  }
  throw new Error(
    "GATEWAY_PHONE_AUTH_MODE must be disabled or transition; SMS is outside this implementation."
  );
}

function boundedPositiveIntegerEnv(
  value: string | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  if (!/^[1-9][0-9]*$/u.test(value.trim())) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must be at most ${maximum}.`);
  }
  return parsed;
}

function invalidRequest(): GatewayError {
  return new GatewayError({
    code: "invalid_request",
    message: "Request does not match contract version 1.",
    httpStatus: 400
  });
}

function phoneNotRegistered(): GatewayError {
  return new GatewayError({
    code: "phone_not_registered",
    message: "This phone is not enabled for internal access.",
    httpStatus: 403
  });
}

function accountDisabled(): GatewayError {
  return new GatewayError({
    code: "account_disabled",
    message: "This internal account is disabled.",
    httpStatus: 403
  });
}

function phoneIdentityConflict(): GatewayError {
  return new GatewayError({
    code: "phone_identity_conflict",
    message: "The registered phone does not map to one unique Subject.",
    httpStatus: 409
  });
}

function accountMigrationRequired(): GatewayError {
  return new GatewayError({
    code: "account_migration_required",
    message: "The internal account runtime key is not recoverable.",
    httpStatus: 409
  });
}

function accessTokenInvalid(): GatewayError {
  return new GatewayError({
    code: "access_token_invalid",
    message: "The access token or Session is invalid.",
    httpStatus: 401
  });
}

function refreshTokenInvalid(): GatewayError {
  return new GatewayError({
    code: "refresh_token_invalid",
    message: "The refresh session is invalid.",
    httpStatus: 401
  });
}

function phoneAuthUnavailable(): GatewayError {
  return new GatewayError({
    code: "service_unavailable",
    message: "Phone authentication is not enabled.",
    httpStatus: 503
  });
}
