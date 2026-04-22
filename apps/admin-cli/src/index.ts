#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import {
  issueAccessCredential,
  type AccessCredentialRecord,
  type RateLimitPolicy,
  type Scope,
  type Subject,
  type SubjectState
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
  .description("Issue an API key.")
  .requiredOption("--label <label>", "credential label")
  .requiredOption("--scope <scope>", "credential scope: code or medical", parseScope)
  .option("--user <id>", "user id; preferred alias for --subject-id")
  .option("--user-label <label>", "user label; preferred alias for --subject-label")
  .option("--subject-id <id>", "subject id", defaultSubjectId)
  .option("--subject-label <label>", "subject label", defaultSubjectLabel)
  .option("--expires-days <days>", "days until expiration", parsePositiveInteger, 365)
  .option("--rpm <n>", "requests per minute", parsePositiveInteger, 30)
  .option("--rpd <n>", "requests per day; omit for unlimited", parseNullablePositiveInteger)
  .option("--concurrent <n>", "concurrent requests", parseNullablePositiveInteger, 1)
  .action((options) => {
    withStore((store) => {
      const subject = issueSubject(store, options);
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
  .description("List API keys.")
  .option("--user <id>", "filter by user id; preferred alias for --subject-id")
  .option("--subject-id <id>", "filter by subject id")
  .option("--active-only", "hide revoked credentials")
  .action((options) => {
    withStore((store) => {
      const subjectId = resolveUserId(options);
      const credentials = store.listAccessCredentials({
        subjectId,
        includeRevoked: options.activeOnly ? false : true
      });
      printJson({
        credentials: credentials.map(publicCredential)
      });
    });
  });

program
  .command("list-users")
  .description("List users.")
  .option("--state <state>", "filter by state: active, disabled, or archived", parseSubjectState)
  .option("--hide-archived", "hide archived users")
  .action((options) => {
    withStore((store) => {
      printJson({
        users: store
          .listSubjects({
            state: options.state,
            includeArchived: options.hideArchived ? false : true
          })
          .map(publicSubject)
      });
    });
  });

program
  .command("disable-user")
  .argument("<user>")
  .description("Disable a user so all of their API keys are rejected.")
  .action((user) => {
    withStore((store) => {
      const subject = store.setSubjectState(user, "disabled");
      if (!subject) {
        throw new Error(`User not found: ${user}`);
      }

      printJson({
        user: publicSubject(subject)
      });
    });
  });

program
  .command("enable-user")
  .argument("<user>")
  .description("Re-enable a disabled user.")
  .action((user) => {
    withStore((store) => {
      const subject = store.setSubjectState(user, "active");
      if (!subject) {
        throw new Error(`User not found: ${user}`);
      }

      printJson({
        user: publicSubject(subject)
      });
    });
  });

program
  .command("events")
  .description("List recorded request events.")
  .option("--user <id>", "filter by user id; preferred alias for --subject-id")
  .option("--credential-id <id>", "filter by credential id")
  .option("--subject-id <id>", "filter by subject id")
  .option("--limit <n>", "maximum events to return", parsePositiveInteger, 50)
  .action((options) => {
    withStore((store) => {
      const subjectId = resolveUserId(options);
      const events = store.listRequestEvents({
        credentialId: options.credentialId,
        subjectId,
        limit: options.limit
      });
      printJson({
        events: events.map((event) => ({
          request_id: event.requestId,
          credential_id: event.credentialId,
          subject_id: event.subjectId,
          scope: event.scope,
          session_id: event.sessionId,
          subscription_id: event.subscriptionId,
          provider: event.provider,
          started_at: event.startedAt.toISOString(),
          duration_ms: event.durationMs,
          first_byte_ms: event.firstByteMs,
          status: event.status,
          error_code: event.errorCode,
          rate_limited: event.rateLimited
        }))
      });
    });
  });

program
  .command("report-usage")
  .description("Aggregate request events into daily usage rows.")
  .option("--user <id>", "filter by user id; preferred alias for --subject-id")
  .option("--credential-id <id>", "filter by credential id")
  .option("--subject-id <id>", "filter by subject id")
  .option("--days <days>", "days to report when --since is omitted", parsePositiveInteger, 7)
  .option("--since <iso>", "inclusive ISO start time", parseDate)
  .option("--until <iso>", "exclusive ISO end time", parseDate)
  .action((options) => {
    withStore((store) => {
      const subjectId = resolveUserId(options);
      const until = options.until ?? new Date();
      const since = options.since ?? addDays(until, -options.days);
      if (since.getTime() >= until.getTime()) {
        throw new Error("--since must be earlier than --until.");
      }
      const rows = store.reportRequestUsage({
        credentialId: options.credentialId,
        subjectId,
        since,
        until
      });
      printJson({
        since: since.toISOString(),
        until: until.toISOString(),
        rows: rows.map((row) => ({
          date: row.date,
          credential_id: row.credentialId,
          subject_id: row.subjectId,
          scope: row.scope,
          subscription_id: row.subscriptionId,
          provider: row.provider,
          requests: row.requests,
          ok: row.ok,
          errors: row.errors,
          rate_limited: row.rateLimited,
          avg_duration_ms: row.avgDurationMs,
          avg_first_byte_ms: row.avgFirstByteMs
        }))
      });
    });
  });

program
  .command("prune-events")
  .description("Delete request events older than a cutoff.")
  .option("--before-days <days>", "delete events older than this many days", parsePositiveInteger)
  .option("--before <iso>", "delete events before this ISO time", parseDate)
  .option("--dry-run", "show the number of matching events without deleting them")
  .action((options) => {
    withStore((store) => {
      if (options.beforeDays === undefined && options.before === undefined) {
        throw new Error("Use --before-days or --before to set the retention cutoff.");
      }
      const before = options.before ?? addDays(new Date(), -options.beforeDays);
      const result = store.pruneRequestEvents({ before, dryRun: options.dryRun });
      printJson({
        before: result.before.toISOString(),
        dry_run: result.dryRun,
        matched: result.matched,
        deleted: result.deleted
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

function subjectFromOptions(options: {
  user?: string;
  userLabel?: string;
  subjectId: string;
  subjectLabel: string;
}): Subject {
  const user = resolveUserId(options) ?? defaultSubjectId;
  const label =
    "userLabel" in options && typeof options.userLabel === "string"
      ? options.userLabel
      : options.user
        ? user
        : options.subjectLabel;

  return {
    id: user,
    label,
    state: "active",
    createdAt: new Date()
  };
}

function issueSubject(
  store: ReturnType<typeof createSqliteStore>,
  options: {
    user?: string;
    userLabel?: string;
    subjectId: string;
    subjectLabel: string;
  }
): Subject {
  const requested = subjectFromOptions(options);
  const existing = store.getSubject(requested.id);
  if (!existing) {
    return requested;
  }
  if (existing.state !== "active") {
    throw new Error(`User is ${existing.state}; enable the user before issuing a new API key.`);
  }

  return {
    ...existing,
    label: requested.label
  };
}

function resolveUserId(options: { user?: string; subjectId?: string }): string | undefined {
  if (options.user && options.subjectId && options.subjectId !== defaultSubjectId) {
    throw new Error("Use --user or --subject-id, not both.");
  }

  return options.user ?? options.subjectId;
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
    user_id: record.subjectId,
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

function publicSubject(subject: Subject) {
  return {
    id: subject.id,
    label: subject.label,
    state: subject.state,
    created_at: subject.createdAt.toISOString()
  };
}

function parseScope(value: string): Scope {
  if (value === "code" || value === "medical") {
    return value;
  }
  throw new InvalidArgumentError("scope must be code or medical");
}

function parseSubjectState(value: string): SubjectState {
  if (value === "active" || value === "disabled" || value === "archived") {
    return value;
  }
  throw new InvalidArgumentError("state must be active, disabled, or archived");
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

function parseDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidArgumentError("value must be a valid ISO date or datetime");
  }
  return parsed;
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
