#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import {
  issueAccessCredential,
  type AccessCredentialRecord,
  type AdminAuditAction,
  type AdminAuditEventRecord,
  type AdminAuditStatus,
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
    withAuditedStore(
      {
        action: "issue",
        targetUserId: issueTargetUserId(options),
        params: {
          label: options.label,
          scope: options.scope,
          expires_days: options.expiresDays,
          rate: rateFromOptions(options)
        }
      },
      (store) => {
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

        return {
          output: {
            token: issued.token,
            credential: publicCredential(issued.record)
          },
          audit: {
            targetUserId: subject.id,
            targetCredentialId: issued.record.id,
            targetCredentialPrefix: issued.record.prefix
          }
        };
      }
    );
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
  .command("trial-check")
  .description("Run read-only checks before a very small controlled internal trial.")
  .option("--max-active-users <n>", "maximum active users expected for the trial", parsePositiveInteger, 2)
  .action((options: TrialCheckOptions) => {
    const dbPath = requireDbPath();
    if (!existsSync(dbPath)) {
      const result = trialCheckResult({
        generatedAt: new Date(),
        summary: emptyTrialSummary(options.maxActiveUsers),
        checks: [
          {
            name: "sqlite_db",
            status: "error",
            message: "SQLite database file does not exist.",
            detail: { db_path: dbPath }
          }
        ]
      });
      printJson(result);
      process.exitCode = 1;
      return;
    }

    withStore((store) => {
      const result = buildTrialCheck(store, dbPath, options.maxActiveUsers);
      printJson(result);
      if (!result.ready_for_controlled_trial) {
        process.exitCode = 1;
      }
    });
  });

program
  .command("update-key")
  .argument("<credential-prefix>")
  .description("Update an API key's label, scope, expiration, or rate limits.")
  .option("--label <label>", "new API key label")
  .option("--scope <scope>", "new scope: code or medical", parseScope)
  .option("--expires-days <days>", "set expiration to this many days from now", parsePositiveInteger)
  .option("--expires-at <iso>", "set expiration to this ISO time", parseDate)
  .option("--rpm <n>", "requests per minute", parsePositiveInteger)
  .option("--rpd <n>", "requests per day; use none for unlimited", parseNullablePositiveInteger)
  .option("--concurrent <n>", "concurrent requests; use none for unlimited", parseNullablePositiveInteger)
  .action((prefix, options: UpdateKeyOptions) => {
    withAuditedStore(
      {
        action: "update-key",
        targetCredentialPrefix: prefix,
        params: requestedUpdateKeyParams(options)
      },
      (store) => {
        assertHasUpdateKeyChanges(options);
        if (options.expiresDays !== undefined && options.expiresAt !== undefined) {
          throw new Error("Use --expires-days or --expires-at, not both.");
        }

        const oldCredential = store.getAccessCredentialByPrefix(prefix);
        if (!oldCredential) {
          throw new Error(`Credential prefix not found: ${prefix}`);
        }
        if (oldCredential.revokedAt) {
          throw new Error(`Credential prefix is revoked and cannot be updated: ${prefix}`);
        }

        const expiresAt = updateKeyExpiresAt(options);
        const rate = updateKeyRate(oldCredential.rate, options);
        const updated = store.updateAccessCredentialByPrefix(prefix, {
          label: options.label,
          scope: options.scope,
          expiresAt,
          rate
        });
        if (!updated) {
          throw new Error(`Credential prefix not found: ${prefix}`);
        }

        return {
          output: {
            credential: publicCredential(updated)
          },
          audit: {
            targetUserId: updated.subjectId,
            targetCredentialId: updated.id,
            targetCredentialPrefix: updated.prefix,
            params: {
              before: auditCredentialSnapshot(oldCredential),
              after: auditCredentialSnapshot(updated)
            }
          }
        };
      }
    );
  });

program
  .command("disable-user")
  .argument("<user>")
  .description("Disable a user so all of their API keys are rejected.")
  .action((user) => {
    withAuditedStore({ action: "disable-user", targetUserId: user }, (store) => {
      const subject = store.setSubjectState(user, "disabled");
      if (!subject) {
        throw new Error(`User not found: ${user}`);
      }

      return {
        output: {
          user: publicSubject(subject)
        }
      };
    });
  });

program
  .command("enable-user")
  .argument("<user>")
  .description("Re-enable a disabled user.")
  .action((user) => {
    withAuditedStore({ action: "enable-user", targetUserId: user }, (store) => {
      const subject = store.setSubjectState(user, "active");
      if (!subject) {
        throw new Error(`User not found: ${user}`);
      }

      return {
        output: {
          user: publicSubject(subject)
        }
      };
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
    withAuditedStore(
      {
        action: "prune-events",
        params: {
          before_days: options.beforeDays,
          before: options.before?.toISOString(),
          dry_run: Boolean(options.dryRun)
        }
      },
      (store) => {
        if (options.beforeDays === undefined && options.before === undefined) {
          throw new Error("Use --before-days or --before to set the retention cutoff.");
        }
        const before = options.before ?? addDays(new Date(), -options.beforeDays);
        const result = store.pruneRequestEvents({ before, dryRun: options.dryRun });
        return {
          output: {
            before: result.before.toISOString(),
            dry_run: result.dryRun,
            matched: result.matched,
            deleted: result.deleted
          },
          audit: {
            params: {
              before: result.before.toISOString(),
              dry_run: result.dryRun,
              matched: result.matched,
              deleted: result.deleted
            }
          }
        };
      }
    );
  });

program
  .command("revoke")
  .argument("<credential-prefix>")
  .description("Revoke an access credential.")
  .action((prefix) => {
    withAuditedStore(
      { action: "revoke", targetCredentialPrefix: prefix },
      (store) => {
        const revoked = store.revokeAccessCredentialByPrefix(prefix);
        if (!revoked) {
          throw new Error(`Credential prefix not found: ${prefix}`);
        }

        return {
          output: {
            credential: publicCredential(revoked)
          },
          audit: {
            targetUserId: revoked.subjectId,
            targetCredentialId: revoked.id,
            targetCredentialPrefix: revoked.prefix
          }
        };
      }
    );
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
    withAuditedStore(
      {
        action: "rotate",
        targetCredentialPrefix: prefix,
        params: {
          label: options.label,
          expires_days: options.expiresDays,
          grace_hours: options.graceHours,
          rpm: options.rpm,
          rpd: options.rpd,
          concurrent: options.concurrent
        }
      },
      (store) => {
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
            rpd: nullableOptionOrExisting(options.rpd, oldCredential.rate.requestsPerDay),
            concurrent: nullableOptionOrExisting(
              options.concurrent,
              oldCredential.rate.concurrentRequests
            )
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

        return {
          output: {
            token: issued.token,
            credential: publicCredential(issued.record),
            rotated_from: publicCredential(oldAfterRotate)
          },
          audit: {
            targetUserId: oldCredential.subjectId,
            targetCredentialId: oldCredential.id,
            targetCredentialPrefix: oldCredential.prefix,
            params: {
              new_credential_id: issued.record.id,
              new_credential_prefix: issued.record.prefix,
              label: issued.record.label,
              expires_at: issued.record.expiresAt.toISOString(),
              old_expires_at: oldAfterRotate.expiresAt.toISOString(),
              old_revoked_at: oldAfterRotate.revokedAt?.toISOString() ?? null,
              grace_hours: graceHours,
              rate: issued.record.rate
            }
          }
        };
      }
    );
  });

program
  .command("audit")
  .description("List admin audit events.")
  .option("--user <id>", "filter by user id")
  .option("--action <action>", "filter by action", parseAdminAuditAction)
  .option("--status <status>", "filter by status: ok or error", parseAdminAuditStatus)
  .option("--limit <n>", "maximum events to return", parsePositiveInteger, 50)
  .action((options) => {
    withStore((store) => {
      const events = store.listAdminAuditEvents({
        userId: options.user,
        action: options.action,
        status: options.status,
        limit: options.limit
      });
      printJson({
        events: events.map(publicAdminAuditEvent)
      });
    });
  });

await program.parseAsync();

interface AuditInput {
  action: AdminAuditAction;
  targetUserId?: string | null;
  targetCredentialId?: string | null;
  targetCredentialPrefix?: string | null;
  params?: Record<string, unknown> | null;
}

interface AuditedActionResult {
  output: unknown;
  audit?: Partial<AuditInput>;
}

interface UpdateKeyOptions {
  label?: string;
  scope?: Scope;
  expiresDays?: number;
  expiresAt?: Date;
  rpm?: number;
  rpd?: NullableIntegerOption;
  concurrent?: NullableIntegerOption;
}

type NullableIntegerOption = number | null | "";

interface TrialCheckOptions {
  maxActiveUsers: number;
}

type TrialCheckStatus = "ok" | "warning" | "error";

interface TrialCheck {
  name: string;
  status: TrialCheckStatus;
  message: string;
  detail?: Record<string, unknown>;
}

interface TrialSummary {
  max_active_users: number;
  total_users: number;
  active_users: number;
  disabled_users: number;
  archived_users: number;
  total_api_keys: number;
  active_api_keys: number;
  revoked_api_keys: number;
  expired_api_keys: number;
  uncapped_active_api_keys: number;
  ignored_internal_users: number;
  latest_audit_event_at: string | null;
}

interface TrialCheckResultInput {
  generatedAt: Date;
  summary: TrialSummary;
  checks: TrialCheck[];
}

function withStore<T>(fn: (store: ReturnType<typeof createSqliteStore>) => T): T {
  const store = createSqliteStore({ path: requireDbPath() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function withAuditedStore(
  baseAudit: AuditInput,
  fn: (store: ReturnType<typeof createSqliteStore>) => AuditedActionResult
): void {
  const store = createSqliteStore({ path: requireDbPath() });
  try {
    const result = fn(store);
    const finalAudit = mergeAudit(baseAudit, result.audit);
    store.insertAdminAuditEvent(adminAuditRecord(finalAudit, "ok", null));
    printJson(result.output);
  } catch (err) {
    store.insertAdminAuditEvent(
      adminAuditRecord(baseAudit, "error", sanitizeAuditErrorMessage(err))
    );
    throw err;
  } finally {
    store.close();
  }
}

function requireDbPath(): string {
  const dbPath = program.opts<{ db?: string }>().db;
  if (!dbPath) {
    throw new Error("SQLite database path is required. Use --db or GATEWAY_SQLITE_PATH.");
  }
  return dbPath;
}

function buildTrialCheck(
  store: ReturnType<typeof createSqliteStore>,
  dbPath: string,
  maxActiveUsers: number
) {
  const generatedAt = new Date();
  const subjects = store.listSubjects({ includeArchived: true });
  const trialSubjects = subjects.filter((subject) => subject.id !== defaultSubjectId);
  const credentials = store.listAccessCredentials({ includeRevoked: true });
  const activeUsers = trialSubjects.filter((subject) => subject.state === "active");
  const disabledUsers = trialSubjects.filter((subject) => subject.state === "disabled");
  const archivedUsers = trialSubjects.filter((subject) => subject.state === "archived");
  const activeCredentials = credentials.filter(
    (credential) =>
      credential.revokedAt === null && credential.expiresAt.getTime() > generatedAt.getTime()
  );
  const revokedCredentials = credentials.filter((credential) => credential.revokedAt !== null);
  const expiredCredentials = credentials.filter(
    (credential) =>
      credential.revokedAt === null && credential.expiresAt.getTime() <= generatedAt.getTime()
  );
  const uncappedCredentials = activeCredentials.filter(
    (credential) =>
      credential.rate.requestsPerDay === null || credential.rate.concurrentRequests === null
  );
  const latestAuditEvent = store.listAdminAuditEvents({ limit: 1 })[0] ?? null;

  const summary: TrialSummary = {
    max_active_users: maxActiveUsers,
    total_users: trialSubjects.length,
    active_users: activeUsers.length,
    disabled_users: disabledUsers.length,
    archived_users: archivedUsers.length,
    total_api_keys: credentials.length,
    active_api_keys: activeCredentials.length,
    revoked_api_keys: revokedCredentials.length,
    expired_api_keys: expiredCredentials.length,
    uncapped_active_api_keys: uncappedCredentials.length,
    ignored_internal_users: subjects.length - trialSubjects.length,
    latest_audit_event_at: latestAuditEvent?.createdAt.toISOString() ?? null
  };

  const checks: TrialCheck[] = [
    {
      name: "sqlite_db",
      status: "ok",
      message: "SQLite database exists and opened successfully.",
      detail: { db_path: dbPath }
    },
    authModeTrialCheck(),
    nodeEnvTrialCheck(),
    codexHomeTrialCheck(),
    activeUserCountTrialCheck(activeUsers.length, maxActiveUsers),
    activeApiKeyTrialCheck(activeCredentials.length),
    apiKeyLimitsTrialCheck(uncappedCredentials),
    auditTrailTrialCheck(latestAuditEvent)
  ];

  return trialCheckResult({ generatedAt, summary, checks });
}

function trialCheckResult(input: TrialCheckResultInput) {
  return {
    ready_for_controlled_trial: !input.checks.some((check) => check.status === "error"),
    generated_at: input.generatedAt.toISOString(),
    summary: input.summary,
    checks: input.checks
  };
}

function emptyTrialSummary(maxActiveUsers: number): TrialSummary {
  return {
    max_active_users: maxActiveUsers,
    total_users: 0,
    active_users: 0,
    disabled_users: 0,
    archived_users: 0,
    total_api_keys: 0,
    active_api_keys: 0,
    revoked_api_keys: 0,
    expired_api_keys: 0,
    uncapped_active_api_keys: 0,
    ignored_internal_users: 0,
    latest_audit_event_at: null
  };
}

function authModeTrialCheck(): TrialCheck {
  const authMode = process.env.GATEWAY_AUTH_MODE;
  if (authMode === "dev") {
    return {
      name: "auth_mode",
      status: "error",
      message: "GATEWAY_AUTH_MODE=dev is not appropriate for an internal trial."
    };
  }
  if (authMode === "credential") {
    return {
      name: "auth_mode",
      status: "ok",
      message: "GATEWAY_AUTH_MODE is explicitly set to credential."
    };
  }
  return {
    name: "auth_mode",
    status: "warning",
    message:
      "GATEWAY_AUTH_MODE is not set; gateway startup defaults to credential auth when SQLite is configured, but explicit credential mode is clearer for trial runs."
  };
}

function nodeEnvTrialCheck(): TrialCheck {
  if (process.env.NODE_ENV === "production") {
    return {
      name: "node_env",
      status: "ok",
      message: "NODE_ENV is set to production."
    };
  }
  return {
    name: "node_env",
    status: "warning",
    message: "NODE_ENV is not production; acceptable for local smoke, but set production for a trial service."
  };
}

function codexHomeTrialCheck(): TrialCheck {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) {
    return {
      name: "codex_home",
      status: "warning",
      message: "CODEX_HOME is not set in this shell; gateway runtime must set it for Codex provider auth."
    };
  }
  const authPath = path.join(codexHome, "auth.json");
  if (!existsSync(codexHome)) {
    return {
      name: "codex_home",
      status: "error",
      message: "CODEX_HOME directory does not exist.",
      detail: { codex_home: codexHome }
    };
  }
  if (!existsSync(authPath)) {
    return {
      name: "codex_home",
      status: "warning",
      message: "CODEX_HOME exists, but auth.json was not found. Complete Codex device login before trial traffic.",
      detail: { codex_home: codexHome }
    };
  }
  return {
    name: "codex_home",
    status: "ok",
    message: "CODEX_HOME and auth.json are present.",
    detail: { codex_home: codexHome }
  };
}

function activeUserCountTrialCheck(activeUsers: number, maxActiveUsers: number): TrialCheck {
  if (activeUsers > maxActiveUsers) {
    return {
      name: "active_user_count",
      status: "error",
      message: "Active user count exceeds the configured controlled-trial limit.",
      detail: { active_users: activeUsers, max_active_users: maxActiveUsers }
    };
  }
  return {
    name: "active_user_count",
    status: "ok",
    message: "Active user count is within the controlled-trial limit.",
    detail: { active_users: activeUsers, max_active_users: maxActiveUsers }
  };
}

function activeApiKeyTrialCheck(activeCredentials: number): TrialCheck {
  if (activeCredentials === 0) {
    return {
      name: "active_api_keys",
      status: "error",
      message: "No active API keys are available for the trial."
    };
  }
  return {
    name: "active_api_keys",
    status: "ok",
    message: "At least one active API key is available.",
    detail: { active_api_keys: activeCredentials }
  };
}

function apiKeyLimitsTrialCheck(uncappedCredentials: AccessCredentialRecord[]): TrialCheck {
  if (uncappedCredentials.length > 0) {
    return {
      name: "api_key_limits",
      status: "warning",
      message: "Some active API keys do not have both daily and concurrency caps.",
      detail: {
        prefixes: uncappedCredentials.map((credential) => credential.prefix)
      }
    };
  }
  return {
    name: "api_key_limits",
    status: "ok",
    message: "Active API keys have daily and concurrency caps."
  };
}

function auditTrailTrialCheck(latestAuditEvent: AdminAuditEventRecord | null): TrialCheck {
  if (!latestAuditEvent) {
    return {
      name: "audit_trail",
      status: "warning",
      message: "No admin audit events exist yet."
    };
  }
  return {
    name: "audit_trail",
    status: "ok",
    message: "Admin audit events are present.",
    detail: {
      latest_action: latestAuditEvent.action,
      latest_status: latestAuditEvent.status,
      latest_created_at: latestAuditEvent.createdAt.toISOString()
    }
  };
}

function mergeAudit(base: AuditInput, extra: Partial<AuditInput> | undefined): AuditInput {
  return {
    ...base,
    ...extra,
    params: extra?.params ?? base.params ?? null
  };
}

function adminAuditRecord(
  input: AuditInput,
  status: AdminAuditStatus,
  errorMessage: string | null
): AdminAuditEventRecord {
  return {
    id: `audit_${randomUUID()}`,
    action: input.action,
    targetUserId: input.targetUserId ?? null,
    targetCredentialId: input.targetCredentialId ?? null,
    targetCredentialPrefix: input.targetCredentialPrefix ?? null,
    status,
    params: input.params ?? null,
    errorMessage,
    createdAt: new Date()
  };
}

function sanitizeAuditErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/cgw\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "cgw.<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
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

function issueTargetUserId(options: { user?: string; subjectId?: string }): string {
  return resolveUserId(options) ?? defaultSubjectId;
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
  rpd?: NullableIntegerOption;
  concurrent?: NullableIntegerOption;
}): RateLimitPolicy {
  return {
    requestsPerMinute: options.rpm,
    requestsPerDay: normalizeNullableIntegerOption(options.rpd) ?? null,
    concurrentRequests: normalizeNullableIntegerOption(options.concurrent) ?? null
  };
}

function requestedUpdateKeyParams(options: UpdateKeyOptions): Record<string, unknown> {
  return {
    label: options.label,
    scope: options.scope,
    expires_days: options.expiresDays,
    expires_at: options.expiresAt?.toISOString(),
    rpm: options.rpm,
    rpd: normalizeNullableIntegerOption(options.rpd),
    concurrent: normalizeNullableIntegerOption(options.concurrent)
  };
}

function assertHasUpdateKeyChanges(options: UpdateKeyOptions): void {
  if (
    options.label === undefined &&
    options.scope === undefined &&
    options.expiresDays === undefined &&
    options.expiresAt === undefined &&
    options.rpm === undefined &&
    options.rpd === undefined &&
    options.concurrent === undefined
  ) {
    throw new Error(
      "Set at least one of --label, --scope, --expires-days, --expires-at, --rpm, --rpd, or --concurrent."
    );
  }
}

function updateKeyExpiresAt(options: UpdateKeyOptions): Date | undefined {
  if (options.expiresAt) {
    return options.expiresAt;
  }
  if (options.expiresDays !== undefined) {
    return addDays(new Date(), options.expiresDays);
  }
  return undefined;
}

function updateKeyRate(
  existing: RateLimitPolicy,
  options: UpdateKeyOptions
): RateLimitPolicy | undefined {
  if (options.rpm === undefined && options.rpd === undefined && options.concurrent === undefined) {
    return undefined;
  }
  return rateFromOptions({
    rpm: options.rpm ?? existing.requestsPerMinute,
    rpd: nullableOptionOrExisting(options.rpd, existing.requestsPerDay),
    concurrent: nullableOptionOrExisting(options.concurrent, existing.concurrentRequests)
  });
}

function auditCredentialSnapshot(record: AccessCredentialRecord) {
  return {
    id: record.id,
    prefix: record.prefix,
    user_id: record.subjectId,
    label: record.label,
    scope: record.scope,
    expires_at: record.expiresAt.toISOString(),
    revoked_at: record.revokedAt?.toISOString() ?? null,
    rate: record.rate
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

function publicAdminAuditEvent(record: AdminAuditEventRecord) {
  return {
    id: record.id,
    action: record.action,
    target_user_id: record.targetUserId,
    target_credential_id: record.targetCredentialId,
    target_credential_prefix: record.targetCredentialPrefix,
    status: record.status,
    params: record.params,
    error_message: record.errorMessage,
    created_at: record.createdAt.toISOString()
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

function parseAdminAuditAction(value: string): AdminAuditAction {
  if (
    value === "issue" ||
    value === "update-key" ||
    value === "revoke" ||
    value === "rotate" ||
    value === "disable-user" ||
    value === "enable-user" ||
    value === "prune-events"
  ) {
    return value;
  }
  throw new InvalidArgumentError(
    "action must be issue, update-key, revoke, rotate, disable-user, enable-user, or prune-events"
  );
}

function parseAdminAuditStatus(value: string): AdminAuditStatus {
  if (value === "ok" || value === "error") {
    return value;
  }
  throw new InvalidArgumentError("status must be ok or error");
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

function normalizeNullableIntegerOption(
  value: NullableIntegerOption | undefined
): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  return value;
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

function nullableOptionOrExisting(
  option: NullableIntegerOption | undefined,
  existing: number | null
): number | null {
  const normalized = normalizeNullableIntegerOption(option);
  return normalized === undefined ? existing : normalized;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
