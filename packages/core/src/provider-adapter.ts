import type {
  CancelInput,
  CreateSessionInput,
  CreateSessionResult,
  ListSessionInput,
  MessageInput,
  ProviderHealth,
  ProviderSession,
  StreamEvent,
  UpstreamAccount
} from "./types.js";
import type { GatewayError } from "./errors.js";

export interface RefreshResult {
  state: "refreshed" | "not_needed" | "reauth_required";
  detail?: string;
}

export interface ProviderAdapter {
  readonly kind: string;

  health(upstreamAccount: UpstreamAccount): Promise<ProviderHealth>;
  refresh(upstreamAccount: UpstreamAccount): Promise<RefreshResult>;
  create(input: CreateSessionInput): Promise<CreateSessionResult>;
  list(input: ListSessionInput): Promise<ProviderSession[]>;
  message(input: MessageInput): AsyncIterable<StreamEvent>;
  cancel(input: CancelInput): Promise<void>;
  normalize(err: unknown): GatewayError;
}
