import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  patchCodexSdkSource,
  patchCodexSdkStdinEpipe
} from "../scripts/patch-codex-sdk-stdin-epipe.mjs";

const VULNERABLE_FIXTURE = `prefix
    let spawnError = null;
    child.once("error", (err) => spawnError = err);
    if (!child.stdin) {
      child.kill();
      throw new Error("Child process has no stdin");
    }
    child.stdin.write(args.input);
    child.stdin.end();
middle
      if (spawnError) throw spawnError;
      const { code, signal } = await exitPromise;
      if (code !== 0 || signal) {
suffix`;

describe("@openai/codex-sdk stdin EPIPE patch", () => {
  it("adds an stdin error listener and remains idempotent", () => {
    const patched = patchCodexSdkSource(VULNERABLE_FIXTURE);

    expect(patched.status).toBe("patched");
    expect(patched.source).toContain('child.stdin.on("error"');
    expect(patched.source).toContain(
      "if (stdinError && !args.signal?.aborted) throw stdinError;"
    );
    expect(patchCodexSdkSource(patched.source)).toEqual({
      source: patched.source,
      status: "already-patched"
    });
  });

  it("verifies that the installed SDK contains the expected patch", async () => {
    await expect(patchCodexSdkStdinEpipe()).resolves.toBe("already-patched");
  });

  it("survives a large-input SDK cancellation without an unhandled stdin error", () => {
    const childSource = `
      import { Codex } from "@openai/codex-sdk";
      const controller = new AbortController();
      const client = new Codex({
        codexPathOverride: process.execPath,
        env: process.env
      });
      const thread = client.startThread({
        workingDirectory: process.cwd(),
        skipGitRepoCheck: true
      });
      const { events } = await thread.runStreamed(
        "x".repeat(16 * 1024 * 1024),
        { signal: controller.signal }
      );
      setImmediate(() =>
        controller.abort(new Error("client_aborted"))
      );
      try {
        for await (const event of events) void event;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
      console.log("sdk-stdin-error-survived");
    `;

    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", childSource],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024
      }
    );

    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr
    }).toMatchObject({
      status: 0,
      signal: null,
      stdout: expect.stringContaining("sdk-stdin-error-survived")
    });
    expect(result.stderr).not.toContain("Unhandled 'error' event");
  });
});
