import type { FastifyRequest } from "fastify";
import type {
  ProviderAdapter,
  GatewayErrorCode,
  RateLimitPolicy,
  RequestTokenUsageSource,
  Scope,
  Subject,
  UpstreamAccount,
  TokenUsage
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
    gatewaySessionId?: string | null;
    gatewayTokenUsage?: TokenUsage;
    gatewayEstimatedTokens?: number | null;
    gatewayTokenUsageSource?: RequestTokenUsageSource;
    gatewayObservedCredential?: {
      id: string | null;
      subjectId: string | null;
      scope: Scope | null;
    };
  }
}

export function getGatewayContext(request: FastifyRequest): GatewayRequestContext {
  if (!request.gatewayContext) {
    throw new Error("Gateway request context is missing.");
  }
  return request.gatewayContext;
}
