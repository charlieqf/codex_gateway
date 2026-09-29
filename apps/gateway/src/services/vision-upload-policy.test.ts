import { expect, it } from "vitest";
import { createVisionUploadLimits } from "./vision-upload-policy.js";

it("caps total verification work across subjects without consuming cleanup/signing capacity", () => {
  const pools = createVisionUploadLimits(() => new Date("2026-09-29T00:00:00Z"));
  const acquire = (subject: string) => pools.vision_upload.limiter.acquire({ key: subject, scope: "subject", policy: pools.vision_upload.policy });
  const held = [acquire("a"), acquire("a"), acquire("b"), acquire("b")];
  expect(held.every(p => "release" in p)).toBe(true);
  expect(acquire("c")).toMatchObject({ ok: false, limitKind: "concurrency", details: { scope: "request", limit: 4 } });
  const control = pools.vision_control.limiter.acquire({ key: "a", scope: "subject", policy: pools.vision_control.policy });
  expect("release" in control).toBe(true);
  for (const permit of held) if ("release" in permit) { permit.release(); permit.release(); }
  if ("release" in control) control.release();
  const next = acquire("c"); expect("release" in next).toBe(true);
  if ("release" in next) next.release();
});
