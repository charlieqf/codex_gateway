import { createHash } from "node:crypto";
import type { OpenAICompatibleRuntimeKind } from "./services/public-model-registry.js";

export type GoldencodeRuntime = OpenAICompatibleRuntimeKind;

export interface GoldencodePoolMemberFixture {
  id: string;
  runtime: GoldencodeRuntime;
  upstreamModel: string;
  reasoning?: Record<string, unknown>;
  enabled?: boolean;
  maxConcurrent?: number;
}

export interface GoldencodePublicModelFixture {
  displayName: string;
  runtime: "pool";
  contextWindow: number;
  maxContextWindow: number;
  upstreamContextWindow: number;
  maxOutputTokens: number;
  reasoning?: Record<string, unknown>;
  enabled: boolean;
  pool: {
    selection: {
      strategy: "hrw_sticky";
      stickyKeyOrder: Array<"client_session" | "credential" | "subject">;
    };
    requireAllMembers: boolean;
    members: GoldencodePoolMemberFixture[];
  };
}

export function goldencodePoolConfig(): GoldencodePublicModelFixture {
  return {
    displayName: "GoldenCode",
    runtime: "pool",
    contextWindow: 200000,
    maxContextWindow: 200000,
    upstreamContextWindow: 1048576,
    maxOutputTokens: 128000,
    reasoning: { effort: "medium" },
    enabled: true,
    pool: {
      selection: {
        strategy: "hrw_sticky",
        stickyKeyOrder: ["client_session", "credential", "subject"]
      },
      requireAllMembers: true,
      members: [
        {
          id: "goldencode-qianfan",
          runtime: "qianfan",
          upstreamModel: "glm-5.2"
        },
        {
          id: "goldencode-tencent",
          runtime: "tencent",
          upstreamModel: "glm-5.2"
        },
        {
          id: "goldencode-aliyun",
          runtime: "aliyun",
          upstreamModel: "glm-5.2"
        },
        {
          id: "goldencode-openrouter",
          runtime: "openrouter",
          upstreamModel: "z-ai/glm-5.2"
        }
      ]
    }
  };
}

export function goldencodeMemberIds(): string[] {
  return goldencodePoolConfig().pool.members.map((member) => member.id);
}

export function sessionIdForGoldencodeMember(memberId: string): string {
  const memberIds = goldencodeMemberIds();
  for (let i = 0; i < 500; i += 1) {
    const sessionId = `golden-session-${memberId}-${i}`;
    if (hrwAccountForKey(`client_session:${sessionId}`, memberIds) === memberId) {
      return sessionId;
    }
  }
  throw new Error(`Could not find a GoldenCode session id for ${memberId}.`);
}

export function goldencodeRuntimeForMember(memberId: string): GoldencodeRuntime {
  const member = goldencodePoolConfig().pool.members.find((item) => item.id === memberId);
  if (!member) {
    throw new Error(`Unknown GoldenCode member '${memberId}'.`);
  }
  return member.runtime;
}

export function goldencodeUpstreamModelForMember(memberId: string): string {
  const member = goldencodePoolConfig().pool.members.find((item) => item.id === memberId);
  if (!member) {
    throw new Error(`Unknown GoldenCode member '${memberId}'.`);
  }
  return member.upstreamModel;
}

export function hrwAccountForKey(affinityKey: string, accountIds: string[]): string {
  return accountIds.reduce((best, accountId) =>
    hrwScore(affinityKey, accountId) > hrwScore(affinityKey, best) ? accountId : best
  );
}

function hrwScore(affinityKey: string, accountId: string): string {
  return createHash("sha256").update(affinityKey).update("\0").update(accountId).digest("hex");
}
