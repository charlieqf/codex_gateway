import type {
  CancelInput,
  CreateSessionInput,
  CreateSessionResult,
  ListSessionInput,
  MessageInput,
  ProviderHealth,
  ProviderSession,
  StreamEvent,
  Subscription
} from "./types.js";
import type { GatewayError } from "./errors.js";

export interface RefreshResult {
  state: "refreshed" | "not_needed" | "reauth_required";
  detail?: string;
}

export interface ProviderAdapter {
  readonly kind: string;

  health(subscription: Subscription): Promise<ProviderHealth>;
  refresh(subscription: Subscription): Promise<RefreshResult>;
  create(input: CreateSessionInput): Promise<CreateSessionResult>;
  list(input: ListSessionInput): Promise<ProviderSession[]>;
  message(input: MessageInput): AsyncIterable<StreamEvent>;
  cancel(input: CancelInput): Promise<void>;
  normalize(err: unknown): GatewayError;
}

