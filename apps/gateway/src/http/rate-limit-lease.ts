import type { RateLimitPermit } from "../services/rate-limiter.js";

/** Keep capacity until both HTTP and any registered asynchronous work have ended. */
export class RateLimitLease {
  private releaseRequested = false;
  private released = false;
  private pendingWork = 0;

  constructor(private readonly permit: RateLimitPermit) {}

  release(): void {
    this.releaseRequested = true;
    this.flush();
  }

  hold(): () => void {
    if (this.releaseRequested || this.released) {
      throw new Error("Cannot start work after the request rate limit lease ended.");
    }
    this.pendingWork++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.pendingWork--;
      this.flush();
    };
  }

  private flush(): void {
    if (this.released || !this.releaseRequested || this.pendingWork !== 0) return;
    this.released = true;
    this.permit.release();
  }
}
