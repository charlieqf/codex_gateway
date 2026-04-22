export type ProviderKind =
  | "openai-codex"
  | "openai-api"
  | "anthropic"
  | "kimi"
  | "deepseek";

export type Scope = "medical" | "code";

export type SubscriptionState =
  | "active"
  | "disabled"
  | "reauth_required"
  | "unhealthy";

export type SubjectState = "active" | "disabled" | "archived";

export interface Subject {
  id: string;
  label: string;
  state: SubjectState;
  createdAt: Date;
}

export interface AccessCredentialRecord {
  id: string;
  prefix: string;
  hash: string;
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
}

export type RequestEventStatus = "ok" | "error";

export interface RequestEventRecord {
  requestId: string;
  credentialId: string | null;
  subjectId: string | null;
  scope: Scope | null;
  sessionId: string | null;
  subscriptionId: string | null;
  provider: ProviderKind | null;
  startedAt: Date;
  durationMs: number | null;
  firstByteMs: number | null;
  status: RequestEventStatus;
  errorCode: string | null;
  rateLimited: boolean;
}

export interface Subscription {
  id: string;
  provider: ProviderKind;
  label: string;
  credentialRef: string;
  state: SubscriptionState;
  lastUsedAt: Date | null;
  cooldownUntil: Date | null;
}

export interface GatewaySession {
  id: string;
  subjectId: string;
  subscriptionId: string;
  providerSessionRef: string | null;
  title: string | null;
  state: "active" | "archived" | "failed";
  createdAt: Date;
  updatedAt: Date;
}

export type StreamEvent =
  | { type: "message_delta"; text: string }
  | { type: "tool_call"; name: string; callId: string; arguments?: unknown }
  | { type: "completed"; providerSessionRef?: string }
  | { type: "error"; code: string; message: string };

export interface ProviderHealth {
  state: "healthy" | "degraded" | "reauth_required" | "unhealthy";
  checkedAt: Date;
  detail?: string;
}

export interface CreateSessionInput {
  subscription: Subscription;
  subject: Subject;
  scope: Scope;
  initialMessage?: string;
}

export interface CreateSessionResult {
  providerSessionRef: string | null;
  title?: string;
}

export interface ListSessionInput {
  subscription: Subscription;
  subject: Subject;
}

export interface ProviderSession {
  providerSessionRef: string;
  title: string | null;
  updatedAt: Date | null;
}

export interface MessageInput {
  subscription: Subscription;
  session: GatewaySession;
  subject: Subject;
  scope: Scope;
  message: string;
  signal?: AbortSignal;
}

export interface CancelInput {
  subscription: Subscription;
  session: GatewaySession;
}
