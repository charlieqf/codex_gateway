import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpUpstreamV2Client } from "./upstream-v2-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("provisioning cancellation", () => {
  const input = {externalProvider: "test", externalUserId: "test", displayName: "Test", idempotencyKey: "test"};
  it.each([
    {payload: {user: {id: "test"}}, disabled: false},
    {payload: {disabled: "true", user: {id: "test"}}, disabled: false},
    {payload: {disabled: null, user: {id: "test"}}, disabled: false},
    {payload: {disabled: false, user: {id: "test", state: "disabled"}}, disabled: false},
    {payload: {disabled: true, user: {id: "test"}}, disabled: true},
    {payload: {user: {id: "test", state: "disabled"}}, disabled: true}
  ])("requires explicit upstream disable evidence: $payload", async ({payload, disabled}) => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload)));
    const client = new HttpUpstreamV2Client({baseUrl: "https://provision.test", token: "test-only"});
    expect(await client.disableUser({externalUserId: "test", userId: "test", idempotencyKey: "test"})).toMatchObject({disabled});
  });
  it("propagates an already-aborted caller signal", async () => {
    const parent = new AbortController(); parent.abort();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      expect(init.signal?.aborted).toBe(true);
      init.signal!.throwIfAborted();
    });
    const client = new HttpUpstreamV2Client({baseUrl: "https://provision.test", token: "test-only", timeoutMs: 300_000});
    await expect(client.createUser({...input, signal: parent.signal})).rejects.toMatchObject({code: "upstream_unavailable"});
  });

  it("bounds response-body reads by the caller deadline even with a longer global timeout", async () => {
    const parent = new AbortController();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => ({
      ok: true,
      text: () => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("test deadline")), {once: true});
        parent.abort();
      })
    }));
    const client = new HttpUpstreamV2Client({baseUrl: "https://provision.test", token: "test-only", timeoutMs: 300_000});
    await expect(client.createUser({...input, signal: parent.signal})).rejects.toMatchObject({code: "upstream_unavailable"});
  });
});
