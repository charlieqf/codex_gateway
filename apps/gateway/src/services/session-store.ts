import { randomUUID } from "node:crypto";
import type { GatewaySession } from "@codex-gateway/core";
import type { GatewaySessionStore } from "@codex-gateway/store-sqlite";

export class InMemorySessionStore implements GatewaySessionStore {
  private readonly sessions = new Map<string, GatewaySession>();

  upsertSubject(): void {
    return;
  }

  upsertSubscription(): void {
    return;
  }

  create(input: { subjectId: string; subscriptionId: string; now?: Date }): GatewaySession {
    const now = input.now ?? new Date();
    const session: GatewaySession = {
      id: `sess_${randomUUID()}`,
      subjectId: input.subjectId,
      subscriptionId: input.subscriptionId,
      providerSessionRef: null,
      title: null,
      state: "active",
      createdAt: now,
      updatedAt: now
    };

    this.sessions.set(session.id, session);
    return session;
  }

  list(subjectId: string): GatewaySession[] {
    return [...this.sessions.values()].filter((session) => session.subjectId === subjectId);
  }

  get(id: string): GatewaySession | null {
    return this.sessions.get(id) ?? null;
  }

  setProviderSessionRef(id: string, providerSessionRef: string): GatewaySession | null {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }

    const updated = {
      ...session,
      providerSessionRef,
      updatedAt: new Date()
    };
    this.sessions.set(id, updated);
    return updated;
  }
}
