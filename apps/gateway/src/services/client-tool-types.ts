import {
  type GatewaySession,
  type ProviderAdapter,
  type ProviderErrorDiagnostic,
  type Scope,
  type StreamEvent,
  type Subject,
  type UpstreamAccount
} from "@codex-gateway/core";
import { type WriteDeliveryNegotiation, type WriteDeliveryResponse } from "./write-delivery.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionShape,
  type OpenAIChatToolCall,
  type OpenAIChatUsage
} from "../openai-compat.js";
import { type ProviderStreamSummary, type OutputTruncationMode } from "./provider-stream.js";
import { type ChatRuntimeContext } from "./chat-runtime-dispatcher.js";
import { NativeCallBudget } from "./native-tool-failover.js";
import { type QuotaRequestShape } from "./provider-quota-circuit.js";

export interface StrictClientToolsInput {
  provider: ProviderAdapter;
  upstreamAccount: UpstreamAccount;
  upstreamRuntime: ChatRuntimeContext["runtime"];
  upstreamModel: string;
  subject: Subject;
  scope: Scope;
  session: GatewaySession;
  reasoningEffort: string | null;
  request: ChatCompletionRequest;
  prompt: string;
  signal?: AbortSignal;
  requestId?: string;
  log?: StrictClientToolsLogger;
  onProviderError?: (diagnostic: ProviderErrorDiagnostic) => void;
  onProviderEvent?: (event: StreamEvent) => void;
  nativeFileToolRecoveryPolicy: NativeFileToolRecoveryPolicy;
  boundedWriteEnabled?: boolean;
  writeDelivery?: { negotiation: WriteDeliveryNegotiation; shape: ChatCompletionShape };
  deadlineAt?: Date | null;
  now?: () => Date;
}

export interface NativeClientToolsInput extends StrictClientToolsInput {
  callBudget?: NativeCallBudget;
  onNativeCall?: (shape: QuotaRequestShape) => void;
  failoverAttempt?: boolean;
  nativeToolForceRequiredMode: NativeToolForceRequiredMode;
}

export interface StrictClientToolsResult {
  content: string;
  toolCalls: OpenAIChatToolCall[];
  usage: OpenAIChatUsage | null;
  providerSummary: ProviderStreamSummary | null;
  writeDelivery?: WriteDeliveryResponse;
}

export interface StrictClientToolsLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export type NativeToolForceRequiredMode = "first_step" | "disabled" | "legacy";

export interface NativeFileToolRecoveryPolicy {
  mode: OutputTruncationMode;
  softArgumentBytes: number;
  hardArgumentBytes: number | null;
  canaryPercent: number;
}
