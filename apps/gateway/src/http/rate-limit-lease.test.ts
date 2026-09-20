import { describe, expect, it, vi } from "vitest";
import { RateLimitLease } from "./rate-limit-lease.js";

describe("request rate limit lease", () => {
  it("keeps legacy requests immediately releasable and idempotent", () => {
    const release = vi.fn();
    const lease = new RateLimitLease({ release });
    lease.release(); lease.release();
    expect(release).toHaveBeenCalledOnce();
    expect(() => lease.hold()).toThrow("ended");
  });

  it.each([true, false])("waits for both HTTP and all work, HTTP first = %s", (httpFirst) => {
    const release = vi.fn();
    const lease = new RateLimitLease({ release });
    const first = lease.hold(), second = lease.hold();
    if (httpFirst) { lease.release(); lease.release(); }
    first(); first();
    expect(release).not.toHaveBeenCalled();
    second(); second();
    if (!httpFirst) expect(release).not.toHaveBeenCalled();
    lease.release();
    expect(release).toHaveBeenCalledOnce();
    expect(() => lease.hold()).toThrow("ended");
  });
});
