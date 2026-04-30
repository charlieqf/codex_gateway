import type {
  MessageInput,
  ProviderHealth,
  StreamEvent,
  UpstreamAccount
} from "./types.js";

export interface ProviderAdapter {
  readonly kind: string;

  health(upstreamAccount: UpstreamAccount): Promise<ProviderHealth>;
  message(input: MessageInput): AsyncIterable<StreamEvent>;
}
