import type {
  MessageInput,
  ProviderHealth,
  StreamEvent,
  UpstreamAccount
} from "./types.js";

export interface ProviderPromptTokenCount {
  promptTokens: number;
  maxContextTokens: number;
  source: "provider_tokenizer";
}

export interface ProviderAdapter {
  readonly kind: string;

  health(upstreamAccount: UpstreamAccount): Promise<ProviderHealth>;
  countPromptTokens?(input: MessageInput): Promise<ProviderPromptTokenCount>;
  message(input: MessageInput): AsyncIterable<StreamEvent>;
}
