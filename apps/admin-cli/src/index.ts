#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import {
  issueAccessCredential,
  type AccessCredentialRecord,
  type RateLimitPolicy,
  type Scope,
  type Subject
} from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";

const defaultSubjectId = "subj_dev";
const defaultSubjectLabel = "dev-subject";

const program = new Command();

program
  .name("codex-gateway-admin")
  .description("Admin CLI for Codex Gateway")
  .version("0.1.0")
  .option("--db <path>", "SQLite database path", process.env.GATEWAY_SQLITE_PATH);

program
  .command("issue")
  .description("Issue an access credential.")
  .requiredOption("--label <label>", "credential label")
  .requiredOption("--scope <scope>", "credential scope: code or medical", parseScope)
  .option("--subject-id <id>", "subject id", defaultSubjectId)
  .option("--subject-label <label>", "subject label", defaultSubjectLabel)
  .option("--expires-days <days>", "days until expiration", parsePositiveInteger, 365)
  .option("--rpm <n>", "requests per minute", parsePositiveInteger, 30)
  .option("--rpd <n>", "requests per day; omit for unlimited", parseNullablePositiveInteger)
  .option("--concurrent <n>", "concurrent requests", parseNullablePositiveInteger, 1)
  .action((options) => {
    withStore((store) => {
      const subject = subjectFromOptions(options);
      store.upsertSubject(subject);

      const issued = issueAccessCredential({
        subjectId: subject.id,
        label: options.label,
        scope: options.scope,
        expiresAt: addDays(new Date(), options.expiresDays),
        rate: rateFromOptions(options)
      });
      store.insertAccessCredential(issued.record);

      printJson({
        token: issued.token,
        credential: publicCredential(issued.record)
      });
    });
  });

program
  .command("list")
  .description("List access credentials.")
  .option("--subject-id <id>", "filter by subject id")
  .option("--active-only", "hide revoked credentials")
  .action((options) => {
    withStore((store) => {
      const credentials = store.listAccessCredentials({
        subjectId: options.subjectId,
        includeRevoked: options.activeOnly ? false : true
      });
      printJson({
        credentials: credentials.map(publicCredential)
      });
    });
  });

program
  .command("revoke")
  .argument("<credential-prefix>")
  .description("Revoke an access credential.")
  .action((prefix) => {
    withStore((store) => {
      const revoked = store.revokeAccessCredentialByPrefix(prefix);
      if (!revoked) {
        throw new Error(`Credential prefix not found: ${prefix}`);
      }

      printJson({
        credential: publicCredential(revoked)
      });
    });
  });

await program.parseAsync();

function withStore<T>(fn: (store: ReturnType<typeof createSqliteStore>) => T): T {
  const dbPath = program.opts<{ db?: string }>().db;
  if (!dbPath) {
    throw new Error("SQLite database path is required. Use --db or GATEWAY_SQLITE_PATH.");
  }

  const store = createSqliteStore({ path: dbPath });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function subjectFromOptions(options: { subjectId: string; subjectLabel: string }): Subject {
  return {
    id: options.subjectId,
    label: options.subjectLabel,
    state: "active",
    createdAt: new Date()
  };
}

function rateFromOptions(options: {
  rpm: number;
  rpd?: number | null;
  concurrent?: number | null;
}): RateLimitPolicy {
  return {
    requestsPerMinute: options.rpm,
    requestsPerDay: options.rpd ?? null,
    concurrentRequests: options.concurrent ?? null
  };
}

function publicCredential(record: AccessCredentialRecord) {
  return {
    id: record.id,
    prefix: record.prefix,
    subject_id: record.subjectId,
    label: record.label,
    scope: record.scope,
    expires_at: record.expiresAt.toISOString(),
    revoked_at: record.revokedAt?.toISOString() ?? null,
    rate: record.rate,
    created_at: record.createdAt.toISOString(),
    rotates_id: record.rotatesId
  };
}

function parseScope(value: string): Scope {
  if (value === "code" || value === "medical") {
    return value;
  }
  throw new InvalidArgumentError("scope must be code or medical");
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("value must be a positive integer");
  }
  return parsed;
}

function parseNullablePositiveInteger(value: string): number | null {
  if (value.toLowerCase() === "null" || value.toLowerCase() === "none") {
    return null;
  }
  return parsePositiveInteger(value);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
