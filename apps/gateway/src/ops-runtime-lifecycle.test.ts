import { expect, it, vi } from "vitest";
import { buildGateway } from "./index.js";

it("starts the operations timer only when ready and releases it on close", async () => {
  const start = vi.spyOn(globalThis, "setInterval");
  const stop = vi.spyOn(globalThis, "clearInterval");
  const app = buildGateway({ logger: false });
  try {
    expect(start.mock.calls.filter(call => call[1] === 5000)).toHaveLength(0);
    await app.ready();
    const index = start.mock.calls.findIndex(call => call[1] === 5000);
    expect(index).toBeGreaterThanOrEqual(0);
    const timer = start.mock.results[index].value;
    await app.close();
    expect(stop).toHaveBeenCalledWith(timer);
  } finally {
    await app.close();
    start.mockRestore(); stop.mockRestore();
  }
});
