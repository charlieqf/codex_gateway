import type { GatewaySession, Subject, Subscription } from "./types.js";

export interface CreateGatewaySessionInput {
  subjectId: string;
  subscriptionId: string;
  now?: Date;
}

export interface GatewaySessionStore {
  create(input: CreateGatewaySessionInput): GatewaySession;
  list(subjectId: string): GatewaySession[];
  get(id: string): GatewaySession | null;
  setProviderSessionRef(id: string, providerSessionRef: string): GatewaySession | null;
  close?(): void;
}

export interface BootstrapStore {
  upsertSubject(subject: Subject): void;
  upsertSubscription(subscription: Subscription): void;
}

export type GatewayStore = GatewaySessionStore & BootstrapStore;
