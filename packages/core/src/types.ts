export type ProviderKind =
  | "openai-codex"
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

export interface RateLimitPolicy {
  requestsPerMinute: number;
  requestsPerDay: number | null;
  concurrentRequests: number | null;
  token?: import("./token-budget.js").TokenLimitPolicy | null;
}

export type RequestEventStatus = "ok" | "error";

export type AdminAuditAction =
  | "issue"
  | "provision-user"
  | "update-key"
  | "revoke"
  | "rotate"
  | "reveal-key"
  | "update-user"
  | "disable-user"
  | "enable-user"
  | "prune-events"
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
}

export type StreamEvent =
  | { type: "message_delta"; text: string }
  | { type: "tool_call"; name: string; callId: string; arguments?: unknown }
  | { type: "completed"; providerSessionRef?: string; usage?: TokenUsage }
  | { type: "error"; code: string; message: string };

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
  signal?: AbortSignal;
}
