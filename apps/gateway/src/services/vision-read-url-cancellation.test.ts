import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "@codex-gateway/core";
import { R2VisionAssetService } from "./vision-asset-service.js";

afterEach(() => vi.useRealTimers());

function fixture(fetchImpl: typeof fetch) {
  const service = new R2VisionAssetService({
    endpoint: "https://synthetic.example.invalid", bucket: "synthetic-images",
    accessKeyId: "synthetic-access-key", secretAccessKey: "synthetic-secret-key",
    now: () => new Date("2026-09-20T02:00:00Z"), fetchImpl
  });
  const asset = service.createAsset("owner", { contentType: "image/png", sizeBytes: 68, sha256: "a".repeat(64) });
  return { service, asset };
}
function head() { return new Response(null, { status: 200, headers: { "content-type": "image/png", "content-length": "68" } }); }
function cancellation() { return new GatewayError({ code: "client_aborted", message: "Client disconnected.", httpStatus: 499 }); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("R2 read URL cancellation", () => {
  it("does no storage work for a pre-aborted request or invalid ownership/token", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { service, asset } = fixture(fetcher);
    const reason = cancellation();
    await expect(service.createReadUrl("owner", asset.assetId, AbortSignal.abort(reason))).rejects.toBe(reason);
    await expect(service.createReadUrl("other", asset.assetId)).rejects.toMatchObject({ code: "vision_asset_not_found" });
    await expect(service.createReadUrl("owner", asset.assetId + "tampered")).rejects.toBeInstanceOf(GatewayError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([1, 2])("propagates disconnect while HEAD %s is pending without replacing its reason", async (target) => {
    const entered = deferred();
    const controller = new AbortController();
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      calls++;
      if (calls !== target) return head();
      entered.resolve();
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    });
    const { service, asset } = fixture(fetcher);
    const reason = cancellation();
    const outcome = expect(service.createReadUrl("owner", asset.assetId, controller.signal)).rejects.toBe(reason);
    await entered.promise; controller.abort(reason); await outcome;
    expect(fetcher).toHaveBeenCalledTimes(target);
  });

  it("does not start the next HEAD or sign a URL if cancelled between stages", async () => {
    for (const target of [1, 2]) {
      const controller = new AbortController();
      const reason = cancellation();
      let calls = 0;
      const fetcher = vi.fn<typeof fetch>(async () => { if (++calls === target) controller.abort(reason); return head(); });
      const { service, asset } = fixture(fetcher);
      await expect(service.createReadUrl("owner", asset.assetId, controller.signal)).rejects.toBe(reason);
      expect(calls).toBe(target);
    }
  });

  it("retains the storage timeout contract and clears its timers", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const { service, asset } = fixture(fetcher);
    const outcome = expect(service.createReadUrl("owner", asset.assetId)).rejects.toMatchObject({ code: "service_unavailable", httpStatus: 503 });
    await vi.advanceTimersByTimeAsync(30000); await outcome;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout when disconnect and timeout race", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = cancellation();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { controller.abort(reason); reject(init!.signal!.reason); }, { once: true });
    }));
    const { service, asset } = fixture(fetcher);
    const outcome = expect(service.createReadUrl("owner", asset.assetId, controller.signal)).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(30000); await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });
});
