import { describe, expect, it, vi } from "vitest";
import { createMedevidenceRuntimeKeyValidator } from "./medevidence-runtime-key.js";
import { phoneAuthR760MedevidenceOrigin as origin } from "./medevidence-origin-policy.js";

describe("MedEvidence runtime key validation", () => {
  it("validates the exact key at the selected origin without following redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ valid: true }));
    const validate = createMedevidenceRuntimeKeyValidator({ fetchImpl });
    expect(await validate(origin, "test-key")).toEqual({ outcome: "valid" });
    expect(fetchImpl).toHaveBeenCalledWith(`${origin}/validate-key`, {
      method: "GET", headers: { "X-API-Key": "test-key" },
      redirect: "error", signal: expect.any(AbortSignal)
    });
  });

  it.each([401, 403])("rejects HTTP %i as server-side account migration, without leaking the body", async status => {
    const validate = createMedevidenceRuntimeKeyValidator({
      fetchImpl: async () => new Response("sensitive-upstream-body", { status })
    });
    const result = await validate(origin, "test-key");
    expect(result).toMatchObject({ outcome: "rejected", error: { httpStatus: 409, code: "account_migration_required" } });
    expect(JSON.stringify(result)).not.toContain("sensitive-upstream-body");
  });

  it("rejects an explicit valid=false the same way as 401/403", async () => {
    const validate = createMedevidenceRuntimeKeyValidator({ fetchImpl: async () => Response.json({ valid: false }) });
    expect(await validate(origin, "test-key")).toMatchObject({
      outcome: "rejected", error: { httpStatus: 409, code: "account_migration_required" }
    });
  });

  it.each([302, 429, 500, 503])("leaves HTTP %i unverified instead of calling the key invalid", async status => {
    const validate = createMedevidenceRuntimeKeyValidator({
      fetchImpl: async () => new Response(null, { status })
    });
    expect(await validate(origin, "test-key")).toEqual({ outcome: "unverified", reason: "upstream_status", status });
  });

  it.each([null, {}, { valid: "true" }, { valid: 1 }])("treats a 200 without a boolean verdict (%j) as unverified", async body => {
    const validate = createMedevidenceRuntimeKeyValidator({
      fetchImpl: async () => Response.json(body)
    });
    expect(await validate(origin, "test-key")).toEqual({ outcome: "unverified", reason: "malformed_response" });
  });

  it("sanitizes network errors and non-JSON bodies", async () => {
    for (const [fetchImpl, reason] of [
      [async () => { throw new Error("test-key in transport error"); }, "transport"],
      [async () => new Response("test-key is not JSON"), "malformed_response"]
    ] as const) {
      const result = await createMedevidenceRuntimeKeyValidator({ fetchImpl })(origin, "test-key");
      expect(result).toEqual({ outcome: "unverified", reason });
      expect(JSON.stringify(result)).not.toContain("test-key");
    }
  });

  it("bounds both connection and response-body waits", async () => {
    for (const bodyWait of [false, true]) {
      const validate = createMedevidenceRuntimeKeyValidator({
        timeoutMs: 10,
        fetchImpl: async (_url, init) => {
          const aborted = new Promise<never>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          return bodyWait ? Object.assign(new Response(), { json: () => aborted }) : aborted;
        }
      });
      expect(await validate(origin, "test-key")).toEqual({ outcome: "unverified", reason: "transport" });
    }
  });

  it("does not send credentials to an unapproved origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await createMedevidenceRuntimeKeyValidator({ fetchImpl })(
      "https://untrusted.example", "test-key"
    )).toEqual({ outcome: "unverified", reason: "unapproved_origin" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("revalidates after a previous success so a revocation is not cached", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ valid: true }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const validate = createMedevidenceRuntimeKeyValidator({ fetchImpl });
    expect(await validate(origin, "test-key")).toEqual({ outcome: "valid" });
    expect(await validate(origin, "test-key")).toMatchObject({ outcome: "rejected" });
  });
});
