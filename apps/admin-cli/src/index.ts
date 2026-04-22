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

program
  .command("rotate")
  .argument("<credential-prefix>")
  .description("Issue a replacement credential for the same subject.")
  .option("--label <label>", "new credential label; defaults to the old label")
  .option("--expires-days <days>", "days until new credential expiration", parsePositiveInteger, 365)
  .option("--grace-hours <hours>", "hours before old credential expires; 0 revokes now", parseNonNegativeInteger, 24)
  .option("--rpm <n>", "requests per minute; defaults to old credential policy", parsePositiveInteger)
  .option("--rpd <n>", "requests per day; defaults to old credential policy", parseNullablePositiveInteger)
  .option("--concurrent <n>", "concurrent requests; defaults to old credential policy", parseNullablePositiveInteger)
  .action((prefix, options) => {
    withStore((store) => {
      const oldCredential = store.getAccessCredentialByPrefix(prefix);
      if (!oldCredential) {
        throw new Error(`Credential prefix not found: ${prefix}`);
      }
      const now = new Date();
      if (oldCredential.revokedAt) {
        throw new Error(`Credential prefix is revoked and cannot be rotated: ${prefix}`);
      }
      if (oldCredential.expiresAt.getTime() <= now.getTime()) {
        throw new Error(`Credential prefix is expired and cannot be rotated: ${prefix}`);
      }

      const issued = issueAccessCredential({
        subjectId: oldCredential.subjectId,
        label: options.label ?? oldCredential.label,
        scope: oldCredential.scope,
        expiresAt: addDays(now, options.expiresDays),
        rate: rateFromOptions({
          rpm: options.rpm ?? oldCredential.rate.requestsPerMinute,
          rpd: optionOrExisting(options.rpd, oldCredential.rate.requestsPerDay),
          concurrent: optionOrExisting(options.concurrent, oldCredential.rate.concurrentRequests)
        }),
        rotatesId: oldCredential.id
      });
      store.insertAccessCredential(issued.record);

      const graceHours = options.graceHours as number;
      const oldAfterRotate =
        graceHours === 0
          ? store.revokeAccessCredentialByPrefix(oldCredential.prefix) ?? oldCredential
          : store.setAccessCredentialExpiresAtByPrefix(
              oldCredential.prefix,
              earlierDate(oldCredential.expiresAt, addHours(now, graceHours))
            ) ?? oldCredential;

      printJson({
        token: issued.token,
        credential: publicCredential(issued.record),
        rotated_from: publicCredential(oldAfterRotate)
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

function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("value must be a non-negative integer");
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

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function earlierDate(first: Date, second: Date): Date {
  return first.getTime() <= second.getTime() ? first : second;
}

function optionOrExisting<T>(option: T | undefined, existing: T): T {
  return option === undefined ? existing : option;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
