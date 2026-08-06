import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  MessageInput,
  ProviderAdapter,
  ProviderHealth,
  StreamEvent,
  UpstreamAccount
} from "@codex-gateway/core";
import { buildGateway } from "./index.js";

const externalFixtureDir = process.env.MEDCODE_LONG_TASK_FIXTURE_DIR?.trim() ?? "";

const expectedFixture = {
  task: {
    fileName: "长任务.txt",
    bytes: 5_978,
    sha256: "a31d10e15104a608a193f9ad12e320e7e3590c422c67e06e4ab64420401d1019"
  },
  source: {
    fileName: "教授_科研方向检索.md",
    bytes: 43_479,
    sha256: "b454e08debbf2aaccf68bdb6d53f744cb58bc12635d2d0319e80dd25afddd5c4"
  }
} as const;

class LongTaskFixtureProvider implements ProviderAdapter {
  readonly kind = "long-task-fixture";
  readonly messages: MessageInput[] = [];

  constructor(private readonly events: StreamEvent[]) {}

  async health(_upstreamAccount: UpstreamAccount): Promise<ProviderHealth> {
    return {
      state: "healthy",
      checkedAt: new Date("2026-08-06T00:00:00Z")
    };
  }

  async *message(input: MessageInput): AsyncIterable<StreamEvent> {
    this.messages.push(input);
    yield* this.events;
  }
}

describe.skipIf(externalFixtureDir.length === 0)(
  "Du Heng external long-task regression fixture",
  () => {
    it("accepts and forwards the pinned long-task input without treating its size as failure", async () => {
      const fixture = loadExternalFixture(externalFixtureDir);
      const provider = new LongTaskFixtureProvider([
        {
          type: "message_delta",
          text: "Deterministic long-task replay completed."
        },
        {
          type: "completed",
          usage: {
            promptTokens: 18_000,
            completionTokens: 12,
            totalTokens: 18_012
          },
          responseSummary: {
            finishReason: "stop",
            terminationKind: "finish_reason_and_done"
          }
        }
      ]);
      const app = buildGateway({
        accessToken: "secret",
        provider,
        logger: false
      });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: "Bearer secret" },
          payload: longTaskRequest(fixture)
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().choices[0].message.content).toBe(
          "Deterministic long-task replay completed."
        );
        expect(provider.messages).toHaveLength(1);
        expectPinnedBlock(provider.messages[0].message, "research_task", expectedFixture.task);
        expectPinnedBlock(
          provider.messages[0].message,
          "research_source",
          expectedFixture.source
        );
        expect(Buffer.byteLength(provider.messages[0].message, "utf8")).toBeGreaterThan(
          expectedFixture.task.bytes + expectedFixture.source.bytes
        );
      } finally {
        await app.close();
      }
    });

    it("returns an explicit terminal error when the same long task reaches the output limit", async () => {
      const fixture = loadExternalFixture(externalFixtureDir);
      const provider = new LongTaskFixtureProvider([
        {
          type: "message_delta",
          text: "Partial evidence review that must not be presented as complete."
        },
        {
          type: "completed",
          usage: {
            promptTokens: 18_000,
            completionTokens: 32_768,
            totalTokens: 50_768
          },
          responseSummary: {
            finishReason: "length",
            terminationKind: "finish_reason_and_done"
          }
        }
      ]);

      await withRecoveryMode("error", async () => {
        const app = buildGateway({
          accessToken: "secret",
          provider,
          logger: false
        });

        try {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            headers: { authorization: "Bearer secret" },
            payload: longTaskRequest(fixture)
          });

          expect(response.statusCode).toBe(502);
          expect(response.json().error).toMatchObject({
            code: "output_length_exceeded",
            type: "server_error",
            contract_version: 1,
            failure_kind: "confirmed_output_limit",
            retryable: false,
            transformed_retry_allowed: true,
            recovery_owner: "client"
          });
          expect(provider.messages).toHaveLength(1);
        } finally {
          await app.close();
        }
      });
    });
  }
);

function loadExternalFixture(fixtureDir: string): { task: string; source: string } {
  return {
    task: readPinnedFile(fixtureDir, expectedFixture.task),
    source: readPinnedFile(fixtureDir, expectedFixture.source)
  };
}

function readPinnedFile(
  fixtureDir: string,
  expected: { fileName: string; bytes: number; sha256: string }
): string {
  const content = readFileSync(path.join(fixtureDir, expected.fileName));
  expect(content.byteLength, `${expected.fileName} byte length`).toBe(expected.bytes);
  expect(
    createHash("sha256").update(content).digest("hex"),
    `${expected.fileName} SHA-256`
  ).toBe(expected.sha256);
  return content.toString("utf8");
}

function expectPinnedBlock(
  message: string,
  tag: string,
  expected: { bytes: number; sha256: string }
): void {
  const opening = `<${tag}>\n`;
  const closing = `\n</${tag}>`;
  const start = message.indexOf(opening);
  expect(start, `${tag} opening marker`).toBeGreaterThanOrEqual(0);
  const contentStart = start + opening.length;
  const end = message.indexOf(closing, contentStart);
  expect(end, `${tag} closing marker`).toBeGreaterThanOrEqual(contentStart);
  const content = message.slice(contentStart, end);
  expect(Buffer.byteLength(content, "utf8"), `${tag} byte length`).toBe(expected.bytes);
  expect(createHash("sha256").update(content).digest("hex"), `${tag} SHA-256`).toBe(
    expected.sha256
  );
}

function longTaskRequest(fixture: { task: string; source: string }): Record<string, unknown> {
  return {
    model: "medcode",
    messages: [
      {
        role: "developer",
        content:
          "Use the supplied research context, preserve source traceability, and do not disclose personal or institution identifiers from the source."
      },
      {
        role: "user",
        content: [
          "<research_source>",
          fixture.source,
          "</research_source>",
          "",
          "<research_task>",
          fixture.task,
          "</research_task>"
        ].join("\n")
      }
    ]
  };
}

async function withRecoveryMode(
  value: string,
  run: () => Promise<void>
): Promise<void> {
  const previous = process.env.MEDCODE_NATIVE_FILE_TOOL_RECOVERY_MODE;
  process.env.MEDCODE_NATIVE_FILE_TOOL_RECOVERY_MODE = value;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.MEDCODE_NATIVE_FILE_TOOL_RECOVERY_MODE;
    } else {
      process.env.MEDCODE_NATIVE_FILE_TOOL_RECOVERY_MODE = previous;
    }
  }
}
