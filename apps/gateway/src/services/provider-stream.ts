import {
  GatewayError,
  type GatewaySession,
  type ProviderAdapter,
  type ProviderErrorDiagnostic,
  type Scope,
  type Subject,
  type ClientToolChoice,
  type ClientToolDefinition,
  type TokenUsage,
  type UpstreamAccount
} from "@codex-gateway/core";

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments?: unknown;
  argumentsJson?: string;
}

export interface CollectedProviderMessage {
  content: string;
  toolCalls: ProviderToolCall[];
  usage?: TokenUsage;
  providerSessionRef?: string;
}

export interface CollectProviderMessageInput {
  provider: ProviderAdapter;
  upstreamAccount: UpstreamAccount;
  subject: Subject;
  scope: Scope;
  session: GatewaySession;
  message: string;
  clientTools?: ClientToolDefinition[];
  clientToolChoice?: ClientToolChoice;
  signal?: AbortSignal;
  onProviderError?: (diagnostic: ProviderErrorDiagnostic) => void;
  suppressToolCalls?: boolean;
  suppressTextAfterToolCall?: boolean;
}

export async function collectProviderMessage(
  input: CollectProviderMessageInput
): Promise<CollectedProviderMessage | GatewayError> {
  const result: CollectedProviderMessage = {
    content: "",
    toolCalls: []
  };
  let hasToolCalls = false;

  for await (const event of input.provider.message({
    upstreamAccount: input.upstreamAccount,
    subject: input.subject,
    scope: input.scope,
    session: input.session,
    message: input.message,
    clientTools: input.clientTools,
    clientToolChoice: input.clientToolChoice,
    signal: input.signal,
    onProviderError: input.onProviderError
  })) {
    if (event.type === "message_delta") {
      if (input.suppressTextAfterToolCall && hasToolCalls) {
        continue;
      }
      result.content += event.text;
      continue;
    }

    if (event.type === "tool_call") {
      if (input.suppressToolCalls) {
        continue;
      }
      hasToolCalls = true;
      result.toolCalls.push({
        id: event.callId,
        name: event.name,
        arguments: event.arguments,
        argumentsJson: event.argumentsJson
      });
      continue;
    }

    if (event.type === "completed") {
      result.usage = event.usage;
      result.providerSessionRef = event.providerSessionRef;
      continue;
    }

    if (event.type === "error") {
      return streamErrorToGatewayError(event);
    }
  }

  return result;
}

export function streamErrorToGatewayError(event: { code: string; message: string }): GatewayError {
  if (event.code === "rate_limited") {
    return new GatewayError({
      code: "rate_limited",
      message: event.message,
      httpStatus: 429,
      retryAfterSeconds: 60
    });
  }
  if (event.code === "provider_reauth_required") {
    return new GatewayError({
      code: "provider_reauth_required",
      message: event.message,
      httpStatus: 503
    });
  }
  if (event.code === "subscription_unavailable") {
    return new GatewayError({
      code: "subscription_unavailable",
      message: event.message,
      httpStatus: 503
    });
  }
  if (event.code === "context_length_exceeded" || event.code === "context_too_large") {
    return new GatewayError({
      code: "context_length_exceeded",
      message: event.message,
      httpStatus: 413
    });
  }
  if (event.code === "invalid_request") {
    return new GatewayError({
      code: "invalid_request",
      message: event.message,
      httpStatus: 400
    });
  }
  if (event.code === "upstream_timeout") {
    return new GatewayError({
      code: "upstream_timeout",
      message: event.message,
      httpStatus: 504
    });
  }
  if (event.code === "upstream_unavailable") {
    return new GatewayError({
      code: "upstream_unavailable",
      message: event.message,
      httpStatus: 503
    });
  }
  return new GatewayError({
    code: "service_unavailable",
    message: event.message,
    httpStatus: 503
  });
}
