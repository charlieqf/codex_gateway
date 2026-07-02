export type ProviderKind =
  | "openai-codex"
  | "openrouter"
  | "qianfan"
  | "aliyun"
  | "tencent"
  | "openai-api"
  | "anthropic"
  | "kimi"
  | "deepseek";

export type Scope = "medical" | "code";

export type UpstreamAccountState =
  | "active"
  | "disabled"
  | "reauth_required"
  | "unhealthy";

export type SubjectState = "active" | "disabled" | "archived";

export interface Subject {
  id: string;
  label: string;
  name?: string | null;
  phoneNumber?: string | null;
  externalProvider?: string | null;
  externalUserId?: string | null;
  displayName?: string | null;
  state: SubjectState;
  createdAt: Date;
}

export interface AccessCredentialRecord {
  id: string;
  prefix: string;
  hash: string;
  tokenCiphertext?: string | null;
  subjectId: string;
  label: string;
  scope: Scope;
  expiresAt: Date;
  revokedAt: Date | null;
  rate: RateLimitPolicy;
  createdAt: Date;
  rotatesId: string | null;
}

export interface UnifiedClientKeyRecord {
  id: string;
  prefix: string;
  hash: string;
  subjectId: string;
  label: string;
  expiresAt: Date;
  revokedAt: Date | null;
  codexCredentialId: string;
  codexCredentialPrefix: string;
  codexKeyCiphertext: string;
  medevidenceKeyCiphertext: string;
  medevidenceKeyPrefix: string | null;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
}

export type BillingAdminTokenKind = "test" | "live";
export type BillingAdminTokenState = "active" | "revoked";

export interface BillingAdminTokenRecord {
  id: string;
  prefix: string;
  hash: string;
  label: string;
  kind: BillingAdminTokenKind;
  state: BillingAdminTokenState;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  metadata: Record<string, unknown> | null;
}

export interface UpstreamV2BindingRecord {
  subjectId: string;
  v2UserId: string;
  v2KeyId: string | null;
  state: "active" | "disabled" | "pending";
  lastSyncedAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RateLimitPolicy {
  requestsPerMinute: number;
  requestsPerDay: number | null;
  concurrentRequests: number | null;
  token?: import("./token-budget.js").TokenLimitPolicy | null;
}

export type RequestEventStatus = "ok" | "error";

export type AdminAuditAction =
  | "issue"
  | "unified-key-issue"
  | "unified-key-resolve"
  | "unified-key-revoke"
  | "billing-token-issue"
  | "billing-token-revoke"
  | "provision-user"
  | "update-key"
  | "revoke"
  | "rotate"
  | "reveal-key"
  | "update-user"
  | "disable-user"
  | "enable-user"
  | "prune-events"
  | "quota-reset"
  | "token-overrun"
  | "token-reservation-expired"
  | "plan-create"
  | "plan-deprecate"
  | "entitlement-grant"
  | "entitlement-renew"
  | "entitlement-cancel"
  | "entitlement-pause"
  | "entitlement-resume"
  | "entitlement-activate"
  | "entitlement-expire";

export type AdminAuditStatus = "ok" | "error";

export interface AdminAuditEventRecord {
  id: string;
  action: AdminAuditAction;
  targetUserId: string | null;
  targetCredentialId: string | null;
  targetCredentialPrefix: string | null;
  status: AdminAuditStatus;
  params: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface RequestEventRecord {
  requestId: string;
  credentialId: string | null;
  subjectId: string | null;
  scope: Scope | null;
  sessionId: string | null;
  upstreamAccountId: string | null;
  provider: ProviderKind | null;
  publicModelId?: string | null;
  upstreamRuntime?: string | null;
  upstreamModel?: string | null;
  reasoningEffort?: string | null;
  reasoningTokens?: number | null;
  clientTurnId?: string | null;
  turnCode?: string | null;
  clientSessionId?: string | null;
  clientMessageId?: string | null;
  clientAppVersion?: string | null;
  toolChoice?: string | null;
  upstreamFinishReason?: string | null;
  upstreamRequestId?: string | null;
  upstreamHttpStatus?: number | null;
  upstreamContentChars?: number | null;
  upstreamToolCallCount?: number | null;
  upstreamToolNames?: string[] | null;
  upstreamRawResponseHash?: string | null;
  upstreamRawResponseChars?: number | null;
  upstreamEmptyStop?: boolean | null;
  upstreamAttemptCount?: number | null;
  upstreamAttempts?: UpstreamAttemptSummary[] | null;
  startedAt: Date;
  durationMs: number | null;
  firstByteMs: number | null;
  status: RequestEventStatus;
  errorCode: string | null;
  rateLimited: boolean;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cachedPromptTokens?: number | null;
  estimatedTokens?: number | null;
  usageSource?: RequestTokenUsageSource | null;
  limitKind?: import("./token-budget.js").LimitKind | null;
  reservationId?: string | null;
  overRequestLimit?: boolean;
  identityGuardHit?: boolean;
}

export type RequestTokenUsageSource = "provider" | "estimate" | "reserve" | "none";

export interface UpstreamAttemptSummary {
  index: number;
  kind: string | null;
  toolChoice: string | null;
  provider: ProviderKind | null;
  upstreamRuntime: string | null;
  upstreamModel: string | null;
  upstreamAccountId: string | null;
  finishReason: string | null;
  upstreamRequestId: string | null;
  upstreamHttpStatus: number | null;
  errorCode: string | null;
  contentChars: number;
  toolCallCount: number;
  toolNames: string[];
  rawResponseHash: string | null;
  rawResponseChars: number | null;
  emptyStop: boolean | null;
}

export interface ClientMessageEventRecord {
  id: string;
  eventId: string;
  requestId: string;
  credentialId: string;
  subjectId: string;
  scope: Scope;
  sessionId: string;
  messageId: string;
  agent: string | null;
  providerId: string | null;
  modelId: string | null;
  engine: string | null;
  text: string;
  textSha256: string;
  attachmentsJson: string;
  appName: string | null;
  appVersion: string | null;
  createdAt: Date;
  receivedAt: Date;
}

export type ClientDiagnosticEventStatus =
  | "started"
  | "ok"
  | "error"
  | "aborted"
  | "timeout"
  | "queued"
  | "dropped";

export interface ClientDiagnosticEventRecord {
  id: string;
  eventId: string;
  requestId: string;
  credentialId: string;
  subjectId: string;
  scope: Scope;
  sessionId: string | null;
  messageId: string | null;
  toolCallId: string | null;
  providerId: string | null;
  modelId: string | null;
  category: string;
  action: string;
  status: ClientDiagnosticEventStatus;
  method: string | null;
  path: string | null;
  monoMs: number | null;
  durationMs: number | null;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  metadataJson: string;
  appName: string | null;
  appVersion: string | null;
  createdAt: Date;
  receivedAt: Date;
}

export interface UpstreamAccount {
  id: string;
  provider: ProviderKind;
  label: string;
  credentialRef: string;
  imageApiKeyEnv?: string | null;
  state: UpstreamAccountState;
  lastUsedAt: Date | null;
  cooldownUntil: Date | null;
}

export interface GatewaySession {
  id: string;
  subjectId: string;
  upstreamAccountId: string;
  providerSessionRef: string | null;
  title: string | null;
  state: "active" | "archived" | "failed";
  createdAt: Date;
  updatedAt: Date;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
}

export interface ProviderResponseSummary {
  finishReason?: string | null;
  upstreamRequestId?: string | null;
  upstreamHttpStatus?: number | null;
  rawResponseHash?: string | null;
  rawResponseChars?: number | null;
}

export type StreamEvent =
  | { type: "message_delta"; text: string }
  | {
      type: "tool_call";
      name: string;
      callId: string;
      arguments?: unknown;
      argumentsJson?: string;
    }
  | {
      type: "completed";
      providerSessionRef?: string;
      usage?: TokenUsage;
      responseSummary?: ProviderResponseSummary;
    }
  | { type: "error"; code: string; message: string };

export interface ClientToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type ClientToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

export interface ProviderErrorDiagnostic {
  source: string;
  code: string;
  publicMessage: string;
  rawMessage: string;
  rawName?: string;
  rawCode?: string;
  rawStatus?: number;
}

export interface ProviderHealth {
  state: "healthy" | "degraded" | "reauth_required" | "unhealthy";
  checkedAt: Date;
  detail?: string;
}

export interface MessageInput {
  upstreamAccount: UpstreamAccount;
  session: GatewaySession;
  subject: Subject;
  scope: Scope;
  message: string;
  reasoningEffort?: string | null;
  clientTools?: ClientToolDefinition[];
  clientToolChoice?: ClientToolChoice;
  signal?: AbortSignal;
  onProviderError?: (diagnostic: ProviderErrorDiagnostic) => void;
}
