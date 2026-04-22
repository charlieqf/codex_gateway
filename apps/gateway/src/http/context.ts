import type { FastifyRequest } from "fastify";
import type {
  ProviderAdapter,
  RateLimitPolicy,
  Scope,
  Subject,
  Subscription
} from "@codex-gateway/core";

export interface GatewayRequestContext {
  subject: Subject;
  subscription: Subscription;
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
  }

  interface FastifyRequest {
    gatewayContext?: GatewayRequestContext;
    gatewayRateLimitRelease?: () => void;
  }
}

export function getGatewayContext(request: FastifyRequest): GatewayRequestContext {
  if (!request.gatewayContext) {
    throw new Error("Gateway request context is missing.");
  }
  return request.gatewayContext;
}
