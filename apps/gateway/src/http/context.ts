import type { FastifyRequest } from "fastify";
import type {
  ProviderAdapter,
  GatewayErrorCode,
  LimitKind,
  ProviderKind,
  RateLimitPolicy,
  RequestTokenUsageSource,
  Scope,
  Subject,
  UpstreamAccount,
  TokenUsage,
  UpstreamAttemptSummary
} from "@codex-gateway/core";

export interface GatewayRequestContext {
  subject: Subject;
  upstreamAccount: UpstreamAccount;
  provider: ProviderAdapter;
  scope: Scope;
  credential: {
    id: string | null;
    prefix: string;
    label: string | null;
    expiresAt: Date | null;
    rate: RateLimitPolicy | null;
  };
}

export type GatewayRequest = FastifyRequest & {
  gatewayContext: GatewayRequestContext;
};

declare module "fastify" {
  interface FastifyContextConfig {
    public?: boolean;
    skipAuth?: boolean;
    skipRateLimit?: boolean;
    skipObservation?: boolean;
  }

  interface FastifyRequest {
    gatewayContext?: GatewayRequestContext;
    gatewayRateLimitRelease?: () => void;
    gatewayObservationStartedAt?: Date;
    gatewayObservationFirstByteAt?: Date;
    gatewayObservationRecorded?: boolean;
    gatewayErrorCode?: GatewayErrorCode | string;
    gatewayRateLimited?: boolean;
    gatewayLimitKind?: LimitKind;
    gatewaySessionId?: string | null;
    gatewayTokenUsage?: TokenUsage;
    gatewayEstimatedTokens?: number | null;
    gatewayTokenUsageSource?: RequestTokenUsageSource;
    gatewayTokenReservationId?: string | null;
    gatewayTokenReservationKind?: "reservation" | "soft_write";
    gatewayOverRequestLimit?: boolean;
    gatewayIdentityGuardHit?: boolean;
    gatewayObservedCredential?: {
      id: string | null;
      subjectId: string | null;
      scope: Scope | null;
    };
    gatewayObservedUpstreamAccount?: {
      id: string | null;
      provider: ProviderKind | null;
    };
    gatewayPublicModelId?: string | null;
    gatewayUpstreamRuntime?: string | null;
    gatewayUpstreamModel?: string | null;
    gatewayReasoningEffort?: string | null;
    gatewayClientTurnId?: string | null;
    gatewayTurnCode?: string | null;
    gatewayClientSessionId?: string | null;
    gatewayClientMessageId?: string | null;
    gatewayClientAppVersion?: string | null;
    gatewayToolChoice?: string | null;
    gatewayUpstreamFinishReason?: string | null;
    gatewayUpstreamRequestId?: string | null;
    gatewayUpstreamHttpStatus?: number | null;
    gatewayUpstreamContentChars?: number | null;
    gatewayUpstreamToolCallCount?: number | null;
    gatewayUpstreamToolNames?: string[] | null;
    gatewayUpstreamRawResponseHash?: string | null;
    gatewayUpstreamRawResponseChars?: number | null;
    gatewayUpstreamEmptyStop?: boolean | null;
    gatewayUpstreamAttemptCount?: number | null;
    gatewayUpstreamAttempts?: UpstreamAttemptSummary[] | null;
  }
}

export function getGatewayContext(request: FastifyRequest): GatewayRequestContext {
  if (!request.gatewayContext) {
    throw new Error("Gateway request context is missing.");
  }
  return request.gatewayContext;
}
