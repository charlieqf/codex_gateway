import {
  GatewayError,
  toGatewayError,
  type CancelInput,
  type CreateSessionInput,
  type CreateSessionResult,
  type ListSessionInput,
  type MessageInput,
  type ProviderAdapter,
  type ProviderHealth,
  type ProviderSession,
  type RefreshResult,
  type StreamEvent,
  type Subscription
} from "@codex-gateway/core";

export interface CodexProviderOptions {
  codexHome: string;
}

export class CodexProviderAdapter implements ProviderAdapter {
  readonly kind = "openai-codex";

  constructor(private readonly options: CodexProviderOptions) {}

  async health(_subscription: Subscription): Promise<ProviderHealth> {
    return {
      state: "degraded",
      checkedAt: new Date(),
      detail: `Phase 0 must verify Codex auth under CODEX_HOME=${this.options.codexHome}.`
    };
  }

  async refresh(_subscription: Subscription): Promise<RefreshResult> {
    return {
      state: "reauth_required",
      detail: "Codex subscription refresh is not wired until Phase 0 proves the app-server path."
    };
  }

  async create(_input: CreateSessionInput): Promise<CreateSessionResult> {
    throw new GatewayError({
      code: "service_unavailable",
      message: "OpenAI Codex adapter is awaiting Phase 0 validation.",
      httpStatus: 503
    });
  }

  async list(_input: ListSessionInput): Promise<ProviderSession[]> {
    return [];
  }

  async *message(_input: MessageInput): AsyncIterable<StreamEvent> {
    yield {
      type: "error",
      code: "service_unavailable",
      message: "OpenAI Codex adapter is awaiting Phase 0 validation."
    };
  }

  async cancel(_input: CancelInput): Promise<void> {
    return;
  }

  normalize(err: unknown): GatewayError {
    return toGatewayError(err);
  }
}

