#!/usr/bin/env node
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import {
  issueAccessCredential,
  mergeEntitlementTokenPolicy,
  validatePlanPolicy,
  type AccessCredentialRecord,
  type AdminAuditAction,
  type AdminAuditEventRecord,
  type AdminAuditStatus,
  type Entitlement,
  type EntitlementState,
  type PeriodKind,
  type Plan,
  type PlanState,
  type RateLimitPolicy,
  type Scope,
  type Subject,
  type SubjectState,
  type TokenLimitPolicy
} from "@codex-gateway/core";
import { createSqliteStore, createSqliteTokenBudgetLimiter } from "@codex-gateway/store-sqlite";

const defaultSubjectId = "subj_dev";
const defaultSubjectLabel = "dev-subject";

const program = new Command();

program
  .name("codex-gateway-admin")
  .description("Admin CLI for Codex Gateway")
  .version("0.1.0")
  .option("--db <path>", "SQLite database path", process.env.GATEWAY_SQLITE_PATH)
  .option("--verbose", "write diagnostic logs to stderr");

program
  .command("issue")
  .description("Issue an API key.")
  .requiredOption("--label <label>", "credential label")
  .requiredOption("--scope <scope>", "credential scope: code or medical", parseScope)
  .option("--user <id>", "user id; preferred alias for --subject-id")
  .option("--user-label <label>", "user label; preferred alias for --subject-label")
  .option("--name <name>", "user real name")
  .option("--phone <phone>", "user phone number")
  .option("--subject-id <id>", "subject id", defaultSubjectId)
  .option("--subject-label <label>", "subject label", defaultSubjectLabel)
  .option("--expires-days <days>", "days until expiration", parsePositiveInteger, 365)
  .option("--rpm <n>", "requests per minute", parsePositiveInteger, 30)
  .option("--rpd <n>", "requests per day; omit for unlimited", parseNullablePositiveInteger)
  .option("--concurrent <n>", "concurrent requests", parseNullablePositiveInteger, 1)
  .option("--tokens-per-minute <n>", "tokens per minute; use none for unlimited", parseNullableNonNegativeInteger)
  .option("--tokens-per-day <n>", "tokens per day; use none for unlimited", parseNullableNonNegativeInteger)
  .option("--tokens-per-month <n>", "tokens per month; use none for unlimited", parseNullableNonNegativeInteger)
  .option("--max-prompt-tokens <n>", "max prompt tokens per request; use none for unlimited", parseNullableNonNegativeInteger)
  .option("--max-total-tokens <n>", "max total reserved tokens per request; use none for unlimited", parseNullableNonNegativeInteger)
  .option("--reserve-tokens <n>", "tokens to reserve per request", parseNonNegativeInteger)
  .option("--missing-usage-charge <mode>", "charge policy when provider usage is missing: none, estimate, or reserve", parseMissingUsageCharge)
  .option("--no-entitlement-check", "allow issuing a key without an active entitlement during compatibility rollout")
  .action((options) => {
    withAuditedStore(
      {
        action: "issue",
        targetUserId: issueTargetUserId(options),
        params: {
          label: options.label,
          scope: options.scope,
          user_id: issueTargetUserId(options),
          user_name: normalizeOptionalText(options.name),
          user_phone: normalizeOptionalText(options.phone),
          expires_days: options.expiresDays,
          no_entitlement_check: Boolean(options.noEntitlementCheck),
          rate: rateFromOptions(options)
        }
      },
      (store) => {
        const subject = issueSubject(store, options);
        store.upsertSubject(subject);
        assertCanIssueCredentialForEntitlement(
          store,
          subject.id,
          options.scope,
          Boolean(options.noEntitlementCheck)
        );

        const issued = issueAccessCredential({
          subjectId: subject.id,
          label: options.label,
          scope: options.scope,
          expiresAt: addDays(new Date(), options.expiresDays),
          rate: rateFromOptions(options)
        });
        const record = {
          ...issued.record,
          tokenCiphertext: encryptAccessCredentialToken(issued.token)
        };
        store.insertAccessCredential(record);

        return {
          output: {
            token: issued.token,
            credential: publicCredential(record, subject)
          },
          audit: {
            targetUserId: subject.id,
            targetCredentialId: record.id,
            targetCredentialPrefix: record.prefix
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
  .option("--active-only", "hide revoked, expired, or disabled-user credentials")
  .action((options) => {
    withStore((store) => {
      const subjectId = resolveUserId(options);
      const now = new Date();
      const subjects = subjectMap(store.listSubjects({ includeArchived: true }));
      const credentials = store.listAccessCredentials({
        subjectId,
        includeRevoked: options.activeOnly ? false : true
      }).filter(
        (credential) =>
          !options.activeOnly || credentialStatus(credential, subjects.get(credential.subjectId), now) === "active"
      );
      printJson({
        credentials: credentials.map((credential) =>
          publicCredential(credential, subjects.get(credential.subjectId) ?? null, now)
        )
      });
    });
  });

program
  .command("list-active-keys")
  .alias("active-keys")
  .description("List currently valid API keys with user contact metadata.")
  .option("--user <id>", "filter by user id; preferred alias for --subject-id")
  .option("--subject-id <id>", "filter by subject id")
  .action((options) => {
    withStore((store) => {
      const subjectId = resolveUserId(options);
      const now = new Date();
      const subjects = subjectMap(store.listSubjects({ includeArchived: true }));
      const credentials = store
        .listAccessCredentials({ subjectId, includeRevoked: false })
        .filter(
          (credential) =>
            credentialStatus(credential, subjects.get(credential.subjectId), now) === "active"
        );

      printJson({
        credentials: credentials.map((credential) =>
          publicCredential(credential, subjects.get(credential.subjectId) ?? null, now)
        )
      });
    });
  });

program
  .command("reveal-key")
  .argument("<credential-prefix>")
  .description("Reveal a stored full API key by prefix.")
  .action((prefix) => {
    withAuditedStore(
      {
        action: "reveal-key",
        targetCredentialPrefix: prefix
      },
      (store) => {
        const credential = store.getAccessCredentialByPrefix(prefix);
        if (!credential) {
          throw new Error(`Credential prefix not found: ${prefix}`);
        }
        const subject = store.getSubject(credential.subjectId);
        return {
          output: {
            credential: publicCredential(
              credential,
              subject,
              new Date(),
              revealAccessCredentialToken(credential)
            )
          },
          audit: {
            targetUserId: credential.subjectId,
            targetCredentialId: credential.id,
            targetCredentialPrefix: credential.prefix
          }
        };
      }
    );
  });

program
  .command("reveal-keys")
  .description("Reveal stored full API keys, optionally filtered to currently valid keys.")
  .option("--user <id>", "filter by user id; preferred alias for --subject-id")
  .option("--subject-id <id>", "filter by subject id")
  .option("--active-only", "hide revoked, expired, or disabled-user credentials")
  .action((options) => {
    withAuditedStore(
      {
        action: "reveal-key",
        targetUserId: resolveUserId(options),
        params: {
          active_only: Boolean(options.activeOnly)
        }
      },
      (store) => {
        const subjectId = resolveUserId(options);
        const now = new Date();
        const subjects = subjectMap(store.listSubjects({ includeArchived: true }));
        const credentials = store
          .listAccessCredentials({
            subjectId,
            includeRevoked: options.activeOnly ? false : true
          })
          .filter(
            (credential) =>
              !options.activeOnly ||
              credentialStatus(credential, subjects.get(credential.subjectId), now) === "active"
          );

        return {
          output: {
            credentials: credentials.map((credential) =>
              publicCredential(
                credential,
                subjects.get(credential.subjectId) ?? null,
                now,
                revealAccessCredentialToken(credential)
              )
            )
          },
          audit: {
            targetUserId: subjectId ?? null,
            params: {
              active_only: Boolean(options.activeOnly),
              credential_count: credentials.length
            }
          }
        };
      }
    );
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

const planCommand = program.command("plan").description("Manage plan templates.");

planCommand
  .command("create")
  .description("Create an immutable plan template.")
  .requiredOption("--id <id>", "plan id, e.g. plan_pro_v1")
  .requiredOption("--policy-file <path>", "JSON token policy file")
  .option("--display-name <name>", "public display name")
  .option("--scope <list>", "comma-separated scopes", parseScopeList, ["code"])
  .option("--priority-class <n>", "reserved for future scheduling", parseNonNegativeInteger, 5)
  .option("--team-pool-id <id>", "reserved team pool id")
  .action((options) => {
    withAuditedStore(
      {
        action: "plan-create",
        params: {
          plan_id: options.id,
          display_name: options.displayName,
          scope_allowlist: options.scope,
          priority_class: options.priorityClass,
          team_pool_id: options.teamPoolId ?? null
        }
      },
      (store) => {
        const plan = store.createPlan({
          id: options.id,
          displayName: options.displayName ?? options.id,
          policy: readTokenPolicyFile(options.policyFile),
          scopeAllowlist: options.scope,
          priorityClass: options.priorityClass,
          teamPoolId: options.teamPoolId ?? null
        });
        return {
          output: { plan: publicPlan(plan, true) },
          audit: {
            params: { plan_id: plan.id }
          }
        };
      }
    );
  });

planCommand
  .command("list")
  .description("List plans.")
  .option("--state <state>", "active or deprecated", parsePlanState)
  .action((options) => {
    withStore((store) => {
      printJson({
        plans: store.listPlans({ state: options.state }).map((plan) => publicPlan(plan, false))
      });
    });
  });

planCommand
  .command("show")
  .argument("<plan-id>")
  .description("Show a plan.")
  .action((planId) => {
    withStore((store) => {
      const plan = store.getPlan(planId);
      if (!plan) {
        throw new Error(`Plan not found: ${planId}`);
      }
      printJson({ plan: publicPlan(plan, true) });
    });
  });

planCommand
  .command("deprecate")
  .argument("<plan-id>")
  .description("Deprecate a plan so it cannot grant new entitlements.")
  .action((planId) => {
    withAuditedStore(
      { action: "plan-deprecate", params: { plan_id: planId } },
      (store) => {
        const plan = store.deprecatePlan(planId);
        if (!plan) {
          throw new Error(`Plan not found: ${planId}`);
        }
        return {
          output: { plan: publicPlan(plan, true) },
          audit: { params: { plan_id: plan.id } }
        };
      }
    );
  });

const entitlementCommand = program
  .command("entitlement")
  .description("Manage user plan entitlements.");

entitlementCommand
  .command("grant")
  .description("Grant a plan entitlement to a user.")
  .requiredOption("--user <id>", "user id")
  .requiredOption("--plan <id>", "plan id")
  .requiredOption("--period <kind>", "monthly, one_off, or unlimited", parsePeriodKind)
  .option("--start <iso>", "period start", parseDate)
  .option("--duration <duration>", "one_off duration such as 1h, 30m, or 7d", parseDurationMs)
  .option("--end <iso>", "period end for one_off", parseDate)
  .option("--replace", "cancel conflicting current/scheduled entitlement before grant")
  .option("--notes <text>", "operator notes")
  .action((options) => {
    withAuditedStore(
      {
        action: "entitlement-grant",
        targetUserId: options.user,
        params: entitlementGrantAuditParams(options)
      },
      (store) => {
        const periodEnd = entitlementEndFromOptions(options.start, options.end, options.duration);
        const entitlement = store.grantEntitlement({
          subjectId: options.user,
          planId: options.plan,
          periodKind: options.period,
          periodStart: options.start,
          periodEnd,
          replace: Boolean(options.replace),
          notes: normalizeOptionalText(options.notes)
        });
        return {
          output: { entitlement: publicEntitlement(entitlement) },
          audit: {
            targetUserId: entitlement.subjectId,
            params: { entitlement_id: entitlement.id, plan_id: entitlement.planId }
          }
        };
      }
    );
  });

entitlementCommand
  .command("renew")
  .description("Create a scheduled renewal after the current monthly entitlement.")
  .requiredOption("--user <id>", "user id")
  .option("--plan <id>", "replacement plan id")
  .option("--replace", "replace an existing scheduled renewal")
  .action((options) => {
    withAuditedStore(
      {
        action: "entitlement-renew",
        targetUserId: options.user,
        params: { plan_id: options.plan, replace: Boolean(options.replace) }
      },
      (store) => {
        const entitlement = store.renewEntitlement({
          subjectId: options.user,
          planId: options.plan,
          replace: Boolean(options.replace)
        });
        return {
          output: { entitlement: publicEntitlement(entitlement) },
          audit: {
            targetUserId: entitlement.subjectId,
            params: { entitlement_id: entitlement.id, plan_id: entitlement.planId }
          }
        };
      }
    );
  });

entitlementCommand
  .command("pause")
  .argument("<entitlement-id>")
  .description("Pause an active entitlement.")
  .action((id) => {
    withAuditedStore({ action: "entitlement-pause", params: { entitlement_id: id } }, (store) => {
      const entitlement = store.pauseEntitlement({ id });
      return {
        output: { entitlement: publicEntitlement(entitlement) },
        audit: { targetUserId: entitlement.subjectId, params: { entitlement_id: entitlement.id } }
      };
    });
  });

entitlementCommand
  .command("resume")
  .argument("<entitlement-id>")
  .description("Resume a paused entitlement.")
  .action((id) => {
    withAuditedStore({ action: "entitlement-resume", params: { entitlement_id: id } }, (store) => {
      const entitlement = store.resumeEntitlement({ id });
      return {
        output: { entitlement: publicEntitlement(entitlement) },
        audit: { targetUserId: entitlement.subjectId, params: { entitlement_id: entitlement.id } }
      };
    });
  });

entitlementCommand
  .command("cancel")
  .argument("<entitlement-id>")
  .description("Cancel an entitlement.")
  .option("--reason <text>", "cancellation reason")
  .action((id, options) => {
    withAuditedStore(
      { action: "entitlement-cancel", params: { entitlement_id: id, reason: options.reason } },
      (store) => {
        const entitlement = store.cancelEntitlement({
          id,
          reason: normalizeOptionalText(options.reason)
        });
        return {
          output: { entitlement: publicEntitlement(entitlement) },
          audit: { targetUserId: entitlement.subjectId, params: { entitlement_id: entitlement.id } }
        };
      }
    );
  });

entitlementCommand
  .command("show")
  .argument("[entitlement-id]")
  .description("Show an entitlement by id or the current user entitlement with --user.")
  .option("--user <id>", "user id")
  .action((id, options) => {
    withStore((store) => {
      if (id) {
        const entitlement = store.getEntitlement(id);
        if (!entitlement) {
          throw new Error(`Entitlement not found: ${id}`);
        }
        printJson({ entitlement: publicEntitlement(entitlement) });
        return;
      }
      if (!options.user) {
        throw new Error("Use an entitlement id or --user.");
      }
      const access = store.entitlementAccessForSubject(options.user);
      printJson({
        user_id: options.user,
        access: publicEntitlementAccess(access)
      });
    });
  });

entitlementCommand
  .command("list")
  .description("List entitlements.")
  .option("--user <id>", "filter by user id")
  .option("--plan <id>", "filter by plan id")
  .option("--state <state>", "filter by state", parseEntitlementState)
  .option("--period-active-at <iso>", "filter entitlements active at this time", parseDate)
  .action((options) => {
    withStore((store) => {
      printJson({
        entitlements: store
          .listEntitlements({
            subjectId: options.user,
            planId: options.plan,
            state: options.state,
            periodActiveAt: options.periodActiveAt
          })
          .map(publicEntitlement)
      });
    });
  });

entitlementCommand
  .command("bulk-grant")
  .description("Grant a plan entitlement to multiple users, best effort.")
  .requiredOption("--plan <id>", "plan id")
  .requiredOption("--period <kind>", "monthly, one_off, or unlimited", parsePeriodKind)
  .requiredOption("--users <list>", "comma-separated user ids")
  .option("--start <iso>", "period start", parseDate)
  .option("--duration <duration>", "one_off duration such as 1h, 30m, or 7d", parseDurationMs)
  .option("--end <iso>", "period end for one_off", parseDate)
  .option("--replace", "cancel conflicting current/scheduled entitlement before grant")
  .action((options) => {
    withAuditedStore(
      {
        action: "entitlement-grant",
        params: {
          bulk: true,
          plan_id: options.plan,
          users: parseCommaList(options.users),
          period: options.period,
          replace: Boolean(options.replace)
        }
      },
      (store) => {
        const periodEnd = entitlementEndFromOptions(options.start, options.end, options.duration);
        const granted: Entitlement[] = [];
        const failures: Array<{ user_id: string; error: string }> = [];
        for (const user of parseCommaList(options.users)) {
          try {
            granted.push(
              store.grantEntitlement({
                subjectId: user,
                planId: options.plan,
                periodKind: options.period,
                periodStart: options.start,
                periodEnd,
                replace: Boolean(options.replace)
              })
            );
          } catch (err) {
            failures.push({
              user_id: user,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
        return {
          output: {
            granted: granted.map(publicEntitlement),
            failures
          },
          audit: {
            params: {
              plan_id: options.plan,
              granted: granted.length,
              failed: failures.length
            }
          }
        };
      }
    );
  });

program
  .command("update-user")
  .argument("<user>")
  .description("Update user display/contact metadata.")
  .option("--label <label>", "user display label")
  .option("--name <name>", "user real name")
  .option("--phone <phone>", "user phone number")
  .option("--clear-name", "clear stored user real name")
  .option("--clear-phone", "clear stored user phone number")
  .action((user, options: UpdateUserOptions) => {
    withAuditedStore(
      {
        action: "update-user",
        targetUserId: user,
        params: requestedUpdateUserParams(options)
      },
      (store) => {
        assertHasUpdateUserChanges(options);
        if (options.name !== undefined && options.clearName) {
          throw new Error("Use --name or --clear-name, not both.");
        }
        if (options.phone !== undefined && options.clearPhone) {
          throw new Error("Use --phone or --clear-phone, not both.");
        }

        const existing = store.getSubject(user);
        if (!existing) {
          throw new Error(`User not found: ${user}`);
        }

        const updated = store.updateSubject(user, updateSubjectInput(options));
        if (!updated) {
          throw new Error(`User not found: ${user}`);
        }

        return {
          output: {
            user: publicSubject(updated)
          },
          audit: {
            targetUserId: updated.id,
            params: {
              before: publicSubject(existing),
              after: publicSubject(updated)
            }
          }
        };
      }
    );
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
  .option("--tokens-per-minute <n>", "tokens per minute; use none for unlimited", parseNullableNonNegativeInteger)
  .option("--tokens-per-day <n>", "tokens per day; use none for unlimited", parseNullableNonNegativeInteger)
  .option("--tokens-per-month <n>", "tokens per month; use none for unlimited", parseNullableNonNegativeInteger)
  .option("--max-prompt-tokens <n>", "max prompt tokens per request; use none for unlimited", parseNullableNonNegativeInteger)
  .option("--max-total-tokens <n>", "max total reserved tokens per request; use none for unlimited", parseNullableNonNegativeInteger)
  .option("--reserve-tokens <n>", "tokens to reserve per request", parseNonNegativeInteger)
  .option("--missing-usage-charge <mode>", "charge policy when provider usage is missing: none, estimate, or reserve", parseMissingUsageCharge)
  .option("--clear-token-policy", "remove token budget policy from this credential")
  .option("--no-entitlement-check", "allow updating a key without an active entitlement during compatibility rollout")
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
        assertCanIssueCredentialForEntitlement(
          store,
          oldCredential.subjectId,
          options.scope ?? oldCredential.scope,
          Boolean(options.noEntitlementCheck)
        );

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
            credential: publicCredential(updated, store.getSubject(updated.subjectId))
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
          upstream_account_id: event.upstreamAccountId,
          provider: event.provider,
          started_at: event.startedAt.toISOString(),
          duration_ms: event.durationMs,
          first_byte_ms: event.firstByteMs,
          status: event.status,
          error_code: event.errorCode,
          rate_limited: event.rateLimited,
          prompt_tokens: event.promptTokens ?? null,
          completion_tokens: event.completionTokens ?? null,
          total_tokens: event.totalTokens ?? null,
          cached_prompt_tokens: event.cachedPromptTokens ?? null,
          estimated_tokens: event.estimatedTokens ?? null,
          usage_source: event.usageSource ?? null,
          limit_kind: event.limitKind ?? null,
          reservation_id: event.reservationId ?? null,
          over_request_limit: event.overRequestLimit === true,
          identity_guard_hit: event.identityGuardHit === true
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
  .option("--group-by <dimension>", "optional grouping dimension: entitlement", parseReportGroupBy)
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
        until,
        groupBy: options.groupBy
      });
      printJson({
        since: since.toISOString(),
        until: until.toISOString(),
        rows: rows.map((row) => ({
          date: row.date,
          credential_id: row.credentialId,
          subject_id: row.subjectId,
          scope: row.scope,
          upstream_account_id: row.upstreamAccountId,
          provider: row.provider,
          entitlement_id: row.entitlementId ?? null,
          requests: row.requests,
          ok: row.ok,
          errors: row.errors,
          rate_limited: row.rateLimited,
          avg_duration_ms: row.avgDurationMs,
          avg_first_byte_ms: row.avgFirstByteMs,
          prompt_tokens: row.promptTokens,
          completion_tokens: row.completionTokens,
          total_tokens: row.totalTokens,
          cached_prompt_tokens: row.cachedPromptTokens,
          estimated_tokens: row.estimatedTokens,
          rate_limited_by: row.rateLimitedBy,
          over_request_limit: row.overRequestLimit,
          identity_guard_hit: row.identityGuardHit
        }))
      });
    });
  });

program
  .command("token-windows")
  .description("Show current token usage windows for a user's token policy.")
  .requiredOption("--user <id>", "user id; preferred alias for --subject-id")
  .option("--credential-prefix <prefix>", "credential prefix to choose the token policy")
  .option("--subject-id <id>", "subject id")
  .action(async (options) => {
    await withStoreAsync(async (store) => {
      const userId = resolveUserId(options);
      if (!userId) {
        throw new Error("--user is required.");
      }
      const resolved = resolveTokenWindowPolicy(store, userId, options.credentialPrefix);
      const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
      const usage = await limiter.getCurrentUsage({
        subjectId: userId,
        entitlementId: resolved.entitlementId,
        policy: resolved.policy
      });
      printJson({
        user_id: userId,
        credential_id: resolved.credential?.id ?? null,
        credential_prefix: resolved.credential?.prefix ?? null,
        entitlement_id: resolved.entitlementId,
        token: publicTokenPolicy(resolved.policy),
        token_usage: publicTokenUsage(usage)
      });
    });
  });

program
  .command("token-reservations")
  .description("List token reservations.")
  .option("--user <id>", "filter by user id; preferred alias for --subject-id")
  .option("--subject-id <id>", "filter by subject id")
  .option("--include-finalized", "include recently finalized reservations")
  .option("--limit <n>", "maximum reservations to return", parsePositiveInteger, 50)
  .action((options) => {
    withStore((store) => {
      const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
      const reservations = limiter.listReservations({
        subjectId: resolveUserId(options),
        includeFinalized: options.includeFinalized,
        limit: options.limit
      });
      printJson({
        reservations: reservations.map((reservation) => ({
          id: reservation.id,
          request_id: reservation.requestId,
          kind: reservation.kind,
          credential_id: reservation.credentialId,
          subject_id: reservation.subjectId,
          entitlement_id: reservation.entitlementId,
          scope: reservation.scope,
          upstream_account_id: reservation.upstreamAccountId,
          provider: reservation.provider,
          created_at: reservation.createdAt.toISOString(),
          expires_at: reservation.expiresAt?.toISOString() ?? null,
          finalized_at: reservation.finalizedAt?.toISOString() ?? null,
          reserved_tokens: reservation.reservedTokens,
          estimated_prompt_tokens: reservation.estimatedPromptTokens,
          estimated_total_tokens: reservation.estimatedTotalTokens,
          final_prompt_tokens: reservation.finalPromptTokens,
          final_completion_tokens: reservation.finalCompletionTokens,
          final_total_tokens: reservation.finalTotalTokens,
          final_cached_prompt_tokens: reservation.finalCachedPromptTokens,
          final_estimated_tokens: reservation.finalEstimatedTokens,
          final_usage_source: reservation.finalUsageSource,
          charge_policy_snapshot: reservation.chargePolicySnapshot,
          over_request_limit: reservation.overRequestLimit
        }))
      });
    });
  });

program
  .command("cleanup-token-reservations")
  .description("Finalize expired token reservations using their snapshot charge policy.")
  .action(async () => {
    await withStoreAsync(async (store) => {
      const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
      const result = await limiter.cleanupExpired();
      printJson({
        count: result.count,
        sample_ids: result.sampleIds
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
            credential: publicCredential(revoked, store.getSubject(revoked.subjectId))
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
          rate: {
            ...rateFromOptions({
              rpm: options.rpm ?? oldCredential.rate.requestsPerMinute,
              rpd: nullableOptionOrExisting(options.rpd, oldCredential.rate.requestsPerDay),
              concurrent: nullableOptionOrExisting(
                options.concurrent,
                oldCredential.rate.concurrentRequests
              )
            }),
            token: oldCredential.rate.token ?? undefined
          },
          rotatesId: oldCredential.id
        });
        const record = {
          ...issued.record,
          tokenCiphertext: encryptAccessCredentialToken(issued.token)
        };
        store.insertAccessCredential(record);

        const graceHours = options.graceHours as number;
        const oldAfterRotate =
          graceHours === 0
            ? store.revokeAccessCredentialByPrefix(oldCredential.prefix) ?? oldCredential
            : store.setAccessCredentialExpiresAtByPrefix(
                oldCredential.prefix,
                earlierDate(oldCredential.expiresAt, addHours(now, graceHours))
              ) ?? oldCredential;
        const subject = store.getSubject(oldCredential.subjectId);

        return {
          output: {
            token: issued.token,
            credential: publicCredential(record, subject),
            rotated_from: publicCredential(oldAfterRotate, subject)
          },
          audit: {
            targetUserId: oldCredential.subjectId,
            targetCredentialId: oldCredential.id,
            targetCredentialPrefix: oldCredential.prefix,
            params: {
              new_credential_id: record.id,
              new_credential_prefix: record.prefix,
              label: record.label,
              expires_at: record.expiresAt.toISOString(),
              old_expires_at: oldAfterRotate.expiresAt.toISOString(),
              old_revoked_at: oldAfterRotate.revokedAt?.toISOString() ?? null,
              grace_hours: graceHours,
              rate: record.rate
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
  tokensPerMinute?: NullableIntegerOption;
  tokensPerDay?: NullableIntegerOption;
  tokensPerMonth?: NullableIntegerOption;
  maxPromptTokens?: NullableIntegerOption;
  maxTotalTokens?: NullableIntegerOption;
  reserveTokens?: number;
  missingUsageCharge?: MissingUsageCharge;
  clearTokenPolicy?: boolean;
  noEntitlementCheck?: boolean;
}

interface UpdateUserOptions {
  label?: string;
  name?: string;
  phone?: string;
  clearName?: boolean;
  clearPhone?: boolean;
}

type NullableIntegerOption = number | null | "";
type MissingUsageCharge = TokenLimitPolicy["missingUsageCharge"];

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
  active_users_missing_contact: number;
  ignored_internal_users: number;
  latest_audit_event_at: string | null;
}

interface TrialCheckResultInput {
  generatedAt: Date;
  summary: TrialSummary;
  checks: TrialCheck[];
}

function withStore<T>(fn: (store: ReturnType<typeof createSqliteStore>) => T): T {
  const store = createSqliteStore({ path: requireDbPath(), logger: sqliteLogger() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

async function withStoreAsync<T>(
  fn: (store: ReturnType<typeof createSqliteStore>) => Promise<T>
): Promise<T> {
  const store = createSqliteStore({ path: requireDbPath(), logger: sqliteLogger() });
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

function withAuditedStore(
  baseAudit: AuditInput,
  fn: (store: ReturnType<typeof createSqliteStore>) => AuditedActionResult
): void {
  const store = createSqliteStore({ path: requireDbPath(), logger: sqliteLogger() });
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

function sqliteLogger() {
  return program.opts<{ verbose?: boolean }>().verbose
    ? { info: (message: string) => console.error(message) }
    : undefined;
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
  const subjectsById = subjectMap(subjects);
  const trialSubjects = subjects.filter((subject) => subject.id !== defaultSubjectId);
  const credentials = store.listAccessCredentials({ includeRevoked: true });
  const activeUsers = trialSubjects.filter((subject) => subject.state === "active");
  const disabledUsers = trialSubjects.filter((subject) => subject.state === "disabled");
  const archivedUsers = trialSubjects.filter((subject) => subject.state === "archived");
  const activeCredentials = credentials.filter(
    (credential) =>
      credentialStatus(credential, subjectsById.get(credential.subjectId), generatedAt) === "active"
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
  const activeUsersMissingContact = activeUsers.filter(
    (subject) => !subject.name || !subject.phoneNumber
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
    active_users_missing_contact: activeUsersMissingContact.length,
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
    userContactTrialCheck(activeUsersMissingContact),
    activeCredentialEntitlementTrialCheck(store, activeCredentials),
    expiringEntitlementTrialCheck(store, generatedAt),
    idleActivePlanTrialCheck(store, generatedAt),
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
    active_users_missing_contact: 0,
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

function userContactTrialCheck(subjects: Subject[]): TrialCheck {
  if (subjects.length > 0) {
    return {
      name: "user_contact_metadata",
      status: "warning",
      message: "Some active users are missing name or phone metadata.",
      detail: {
        users: subjects.map((subject) => subject.id)
      }
    };
  }
  return {
    name: "user_contact_metadata",
    status: "ok",
    message: "Active users have name and phone metadata."
  };
}

function activeCredentialEntitlementTrialCheck(
  store: ReturnType<typeof createSqliteStore>,
  activeCredentials: AccessCredentialRecord[]
): TrialCheck {
  const legacy: string[] = [];
  const rejected: Array<{ user_id: string; status: string; reason?: string }> = [];
  for (const subjectId of new Set(activeCredentials.map((credential) => credential.subjectId))) {
    const access = store.entitlementAccessForSubject(subjectId);
    if (access.status === "active") {
      continue;
    }
    if (access.status === "legacy") {
      legacy.push(subjectId);
      continue;
    }
    rejected.push({
      user_id: subjectId,
      status: access.status,
      ...("reason" in access ? { reason: access.reason } : {})
    });
  }
  if (legacy.length === 0 && rejected.length === 0) {
    return {
      name: "active_credential_entitlements",
      status: "ok",
      message: "Active credentials have active entitlements."
    };
  }
  const strict = process.env.GATEWAY_REQUIRE_ENTITLEMENT === "1";
  if (rejected.length > 0) {
    return {
      name: "active_credential_entitlements",
      status: "error",
      message: "Some active credentials have entitlement states that gateway requests reject.",
      detail: {
        ...(legacy.length > 0 ? { legacy_users: legacy } : {}),
        rejected_users: rejected
      }
    };
  }
  return {
    name: "active_credential_entitlements",
    status: strict ? "error" : "warning",
    message: strict
      ? "Some active credentials have no active entitlement and will be rejected."
      : "Some active credentials have no active entitlement; compatibility mode keeps legacy keys usable.",
    detail: { users: legacy }
  };
}

function expiringEntitlementTrialCheck(
  store: ReturnType<typeof createSqliteStore>,
  now: Date
): TrialCheck {
  const soon = addDays(now, 7);
  const expiring = store
    .listEntitlements({ state: "active" })
    .filter(
      (entitlement) =>
        entitlement.periodEnd &&
        entitlement.periodEnd.getTime() > now.getTime() &&
        entitlement.periodEnd.getTime() < soon.getTime()
    );
  if (expiring.length === 0) {
    return {
      name: "entitlement_renewal_window",
      status: "ok",
      message: "No active entitlements expire in the next 7 days."
    };
  }
  return {
    name: "entitlement_renewal_window",
    status: "warning",
    message: "Some active entitlements expire in the next 7 days.",
    detail: {
      entitlements: expiring.map((entitlement) => ({
        id: entitlement.id,
        user_id: entitlement.subjectId,
        period_end: entitlement.periodEnd?.toISOString() ?? null
      }))
    }
  };
}

function idleActivePlanTrialCheck(
  store: ReturnType<typeof createSqliteStore>,
  now: Date
): TrialCheck {
  const cutoff = addDays(now, -90);
  const idlePlans = store
    .listPlans({ state: "active" })
    .filter(
      (plan) =>
        plan.createdAt.getTime() < cutoff.getTime() &&
        store.listEntitlements({ planId: plan.id }).length === 0
    );
  if (idlePlans.length === 0) {
    return {
      name: "active_plan_usage",
      status: "ok",
      message: "Active plans have recent or historical entitlement usage."
    };
  }
  return {
    name: "active_plan_usage",
    status: "warning",
    message: "Some active plans have no entitlements granted in 90 days.",
    detail: { plans: idlePlans.map((plan) => plan.id) }
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

function encryptAccessCredentialToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", apiKeyEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

function revealAccessCredentialToken(record: AccessCredentialRecord): string | null {
  if (!record.tokenCiphertext) {
    return null;
  }
  const [version, ivText, tagText, ciphertextText] = record.tokenCiphertext.split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) {
    throw new Error(`Credential prefix has an unsupported stored token format: ${record.prefix}`);
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    apiKeyEncryptionKey(),
    Buffer.from(ivText, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

function apiKeyEncryptionKey(): Buffer {
  const secret = process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "GATEWAY_API_KEY_ENCRYPTION_SECRET is required to issue or reveal recoverable API keys."
    );
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

function subjectFromOptions(options: {
  user?: string;
  userLabel?: string;
  name?: string;
  phone?: string;
  subjectId: string;
  subjectLabel: string;
}): Subject {
  const user = resolveUserId(options) ?? defaultSubjectId;
  const name = normalizeOptionalText(options.name);
  const phoneNumber = normalizeOptionalText(options.phone);
  const label =
    normalizeOptionalText(options.userLabel) ??
    name ??
    (options.user
      ? user
      : normalizeOptionalText(options.subjectLabel) ?? defaultSubjectLabel);

  return {
    id: user,
    label,
    name,
    phoneNumber,
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
    name?: string;
    phone?: string;
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
    label: requested.label,
    name: requested.name ?? existing.name ?? null,
    phoneNumber: requested.phoneNumber ?? existing.phoneNumber ?? null
  };
}

function assertCanIssueCredentialForEntitlement(
  store: ReturnType<typeof createSqliteStore>,
  userId: string,
  scope: Scope,
  bypass: boolean
): void {
  const access = store.entitlementAccessForSubject(userId);
  if (access.status === "active") {
    if (!access.entitlement.scopeAllowlist.includes(scope)) {
      throw new Error(`Credential scope is not allowed by active entitlement: ${scope}`);
    }
    return;
  }
  if (access.status !== "legacy" && !bypass) {
    throw new Error(`User has no active entitlement: ${userId}`);
  }
  if (process.env.GATEWAY_REQUIRE_ENTITLEMENT === "1" && !bypass) {
    throw new Error(`User has no active entitlement: ${userId}`);
  }
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
  tokensPerMinute?: NullableIntegerOption;
  tokensPerDay?: NullableIntegerOption;
  tokensPerMonth?: NullableIntegerOption;
  maxPromptTokens?: NullableIntegerOption;
  maxTotalTokens?: NullableIntegerOption;
  reserveTokens?: number;
  missingUsageCharge?: MissingUsageCharge;
}): RateLimitPolicy {
  const rate: RateLimitPolicy = {
    requestsPerMinute: options.rpm,
    requestsPerDay: normalizeNullableIntegerOption(options.rpd) ?? null,
    concurrentRequests: normalizeNullableIntegerOption(options.concurrent) ?? null
  };
  const token = tokenPolicyFromOptions(options);
  if (token !== undefined) {
    rate.token = token;
  }
  return rate;
}

function tokenPolicyFromOptions(
  options: {
    tokensPerMinute?: NullableIntegerOption;
    tokensPerDay?: NullableIntegerOption;
    tokensPerMonth?: NullableIntegerOption;
    maxPromptTokens?: NullableIntegerOption;
    maxTotalTokens?: NullableIntegerOption;
    reserveTokens?: number;
    missingUsageCharge?: MissingUsageCharge;
  },
  existing?: TokenLimitPolicy | null
): TokenLimitPolicy | undefined {
  if (!hasTokenPolicyOption(options)) {
    return undefined;
  }
  if (!existing && options.missingUsageCharge === undefined) {
    throw new Error("--missing-usage-charge is required when setting a token policy.");
  }
  return {
    tokensPerMinute: nullableOptionOrExisting(options.tokensPerMinute, existing?.tokensPerMinute ?? null),
    tokensPerDay: nullableOptionOrExisting(options.tokensPerDay, existing?.tokensPerDay ?? null),
    tokensPerMonth: nullableOptionOrExisting(options.tokensPerMonth, existing?.tokensPerMonth ?? null),
    maxPromptTokensPerRequest: nullableOptionOrExisting(
      options.maxPromptTokens,
      existing?.maxPromptTokensPerRequest ?? null
    ),
    maxTotalTokensPerRequest: nullableOptionOrExisting(
      options.maxTotalTokens,
      existing?.maxTotalTokensPerRequest ?? null
    ),
    reserveTokensPerRequest: options.reserveTokens ?? existing?.reserveTokensPerRequest ?? 0,
    missingUsageCharge: options.missingUsageCharge ?? existing?.missingUsageCharge ?? "none"
  };
}

function hasTokenPolicyOption(options: {
  tokensPerMinute?: NullableIntegerOption;
  tokensPerDay?: NullableIntegerOption;
  tokensPerMonth?: NullableIntegerOption;
  maxPromptTokens?: NullableIntegerOption;
  maxTotalTokens?: NullableIntegerOption;
  reserveTokens?: number;
  missingUsageCharge?: MissingUsageCharge;
}): boolean {
  return (
    options.tokensPerMinute !== undefined ||
    options.tokensPerDay !== undefined ||
    options.tokensPerMonth !== undefined ||
    options.maxPromptTokens !== undefined ||
    options.maxTotalTokens !== undefined ||
    options.reserveTokens !== undefined ||
    options.missingUsageCharge !== undefined
  );
}

function requestedTokenPolicyParams(options: {
  tokensPerMinute?: NullableIntegerOption;
  tokensPerDay?: NullableIntegerOption;
  tokensPerMonth?: NullableIntegerOption;
  maxPromptTokens?: NullableIntegerOption;
  maxTotalTokens?: NullableIntegerOption;
  reserveTokens?: number;
  missingUsageCharge?: MissingUsageCharge;
}) {
  if (!hasTokenPolicyOption(options)) {
    return undefined;
  }
  return {
    tokens_per_minute: normalizeNullableIntegerOption(options.tokensPerMinute),
    tokens_per_day: normalizeNullableIntegerOption(options.tokensPerDay),
    tokens_per_month: normalizeNullableIntegerOption(options.tokensPerMonth),
    max_prompt_tokens: normalizeNullableIntegerOption(options.maxPromptTokens),
    max_total_tokens: normalizeNullableIntegerOption(options.maxTotalTokens),
    reserve_tokens: options.reserveTokens,
    missing_usage_charge: options.missingUsageCharge
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
    concurrent: normalizeNullableIntegerOption(options.concurrent),
    token: requestedTokenPolicyParams(options),
    clear_token_policy: Boolean(options.clearTokenPolicy),
    no_entitlement_check: Boolean(options.noEntitlementCheck)
  };
}

function requestedUpdateUserParams(options: UpdateUserOptions): Record<string, unknown> {
  return {
    label: normalizeOptionalText(options.label),
    name: options.clearName ? null : normalizeOptionalText(options.name),
    phone: options.clearPhone ? null : normalizeOptionalText(options.phone),
    clear_name: Boolean(options.clearName),
    clear_phone: Boolean(options.clearPhone)
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
    options.concurrent === undefined &&
    !hasTokenPolicyOption(options) &&
    !options.clearTokenPolicy
  ) {
    throw new Error(
      "Set at least one key field or rate/token policy option."
    );
  }
  if (options.clearTokenPolicy && hasTokenPolicyOption(options)) {
    throw new Error("Use --clear-token-policy or token policy options, not both.");
  }
}

function assertHasUpdateUserChanges(options: UpdateUserOptions): void {
  if (
    options.label === undefined &&
    options.name === undefined &&
    options.phone === undefined &&
    !options.clearName &&
    !options.clearPhone
  ) {
    throw new Error(
      "Set at least one of --label, --name, --phone, --clear-name, or --clear-phone."
    );
  }
  if (options.label !== undefined && !normalizeOptionalText(options.label)) {
    throw new Error("--label cannot be empty.");
  }
  if (options.name !== undefined && !normalizeOptionalText(options.name)) {
    throw new Error("--name cannot be empty; use --clear-name to remove it.");
  }
  if (options.phone !== undefined && !normalizeOptionalText(options.phone)) {
    throw new Error("--phone cannot be empty; use --clear-phone to remove it.");
  }
}

function updateSubjectInput(options: UpdateUserOptions) {
  return {
    label: options.label === undefined ? undefined : normalizeOptionalText(options.label) ?? undefined,
    name: options.clearName ? null : options.name === undefined ? undefined : normalizeOptionalText(options.name),
    phoneNumber: options.clearPhone
      ? null
      : options.phone === undefined
        ? undefined
        : normalizeOptionalText(options.phone)
  };
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
  if (
    options.rpm === undefined &&
    options.rpd === undefined &&
    options.concurrent === undefined &&
    !hasTokenPolicyOption(options) &&
    !options.clearTokenPolicy
  ) {
    return undefined;
  }
  const rate = rateFromOptions({
    rpm: options.rpm ?? existing.requestsPerMinute,
    rpd: nullableOptionOrExisting(options.rpd, existing.requestsPerDay),
    concurrent: nullableOptionOrExisting(options.concurrent, existing.concurrentRequests)
  });
  if (options.clearTokenPolicy) {
    rate.token = null;
  } else if (hasTokenPolicyOption(options)) {
    rate.token = tokenPolicyFromOptions(options, existing.token ?? null);
  } else {
    rate.token = existing.token ?? undefined;
  }
  return rate;
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

type CredentialStatus =
  | "active"
  | "revoked"
  | "expired"
  | "user_disabled"
  | "user_archived"
  | "user_missing";

function publicCredential(
  record: AccessCredentialRecord,
  subject?: Subject | null,
  now: Date = new Date(),
  revealedToken?: string | null
) {
  const status = credentialStatus(record, subject, now);
  const output: Record<string, unknown> = {
    id: record.id,
    prefix: record.prefix,
    user_id: record.subjectId,
    subject_id: record.subjectId,
    label: record.label,
    scope: record.scope,
    expires_at: record.expiresAt.toISOString(),
    revoked_at: record.revokedAt?.toISOString() ?? null,
    status,
    is_currently_valid: status === "active",
    token_available: Boolean(record.tokenCiphertext),
    token_unavailable_reason: record.tokenCiphertext ? null : "not_stored",
    rate: record.rate,
    created_at: record.createdAt.toISOString(),
    rotates_id: record.rotatesId,
    user: subject ? publicSubject(subject) : null
  };
  if (revealedToken !== undefined) {
    output.token = revealedToken;
  }
  return output;
}

function publicPlan(plan: Plan, includePolicy: boolean) {
  return {
    id: plan.id,
    display_name: plan.displayName,
    scope_allowlist: plan.scopeAllowlist,
    priority_class: plan.priorityClass,
    team_pool_id: plan.teamPoolId,
    state: plan.state,
    created_at: plan.createdAt.toISOString(),
    metadata: plan.metadata,
    ...(includePolicy ? { policy: plan.policy } : {})
  };
}

function publicEntitlement(entitlement: Entitlement) {
  return {
    id: entitlement.id,
    user_id: entitlement.subjectId,
    subject_id: entitlement.subjectId,
    plan_id: entitlement.planId,
    policy_snapshot: entitlement.policySnapshot,
    scope_allowlist: entitlement.scopeAllowlist,
    period_kind: entitlement.periodKind,
    period_start: entitlement.periodStart.toISOString(),
    period_end: entitlement.periodEnd?.toISOString() ?? null,
    state: entitlement.state,
    team_seat_id: entitlement.teamSeatId,
    created_at: entitlement.createdAt.toISOString(),
    cancelled_at: entitlement.cancelledAt?.toISOString() ?? null,
    cancelled_reason: entitlement.cancelledReason,
    notes: entitlement.notes
  };
}

function publicEntitlementAccess(
  access: ReturnType<ReturnType<typeof createSqliteStore>["entitlementAccessForSubject"]>
) {
  if (access.status === "active") {
    return {
      status: access.status,
      plan: access.plan ? publicPlan(access.plan, false) : null,
      entitlement: publicEntitlement(access.entitlement)
    };
  }
  return {
    status: access.status,
    ...("reason" in access ? { reason: access.reason } : {}),
    ...("entitlement" in access ? { entitlement: access.entitlement ? publicEntitlement(access.entitlement) : null } : {})
  };
}

function publicTokenPolicy(policy: TokenLimitPolicy) {
  return {
    tokensPerMinute: policy.tokensPerMinute,
    tokensPerDay: policy.tokensPerDay,
    tokensPerMonth: policy.tokensPerMonth,
    maxPromptTokensPerRequest: policy.maxPromptTokensPerRequest,
    maxTotalTokensPerRequest: policy.maxTotalTokensPerRequest
  };
}

function publicTokenUsage(usage: Awaited<ReturnType<ReturnType<typeof createSqliteTokenBudgetLimiter>["getCurrentUsage"]>>) {
  return {
    source: usage.source,
    minute: publicTokenWindow(usage.minute),
    day: publicTokenWindow(usage.day),
    month: publicTokenWindow(usage.month)
  };
}

function publicTokenWindow(input: {
  limit: number | null;
  used: number;
  reserved: number;
  remaining: number | null;
  windowStart: string;
}) {
  return {
    limit: input.limit,
    used: input.used,
    reserved: input.reserved,
    remaining: input.remaining,
    window_start: input.windowStart
  };
}

function publicSubject(subject: Subject) {
  return {
    id: subject.id,
    label: subject.label,
    name: subject.name ?? null,
    phone_number: subject.phoneNumber ?? null,
    state: subject.state,
    created_at: subject.createdAt.toISOString()
  };
}

function subjectMap(subjects: Subject[]): Map<string, Subject> {
  return new Map(subjects.map((subject) => [subject.id, subject]));
}

function resolveTokenPolicyCredential(
  store: ReturnType<typeof createSqliteStore>,
  userId: string,
  prefix?: string
): AccessCredentialRecord {
  if (prefix) {
    const credential = store.getAccessCredentialByPrefix(prefix);
    if (!credential || credential.subjectId !== userId) {
      throw new Error(`Credential prefix not found for user ${userId}: ${prefix}`);
    }
    if (!credential.rate.token) {
      throw new Error(`Credential has no token policy: ${prefix}`);
    }
    return credential;
  }

  const now = new Date();
  const subject = store.getSubject(userId);
  const credential = store
    .listAccessCredentials({ subjectId: userId, includeRevoked: false })
    .find(
      (candidate) =>
        candidate.rate.token &&
        credentialStatus(candidate, subject, now) === "active"
    );
  if (!credential) {
    throw new Error(`No active token policy credential found for user: ${userId}`);
  }
  return credential;
}

function credentialStatus(
  record: AccessCredentialRecord,
  subject: Subject | null | undefined,
  now: Date
): CredentialStatus {
  if (record.revokedAt) {
    return "revoked";
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  if (!subject) {
    return "user_missing";
  }
  if (subject.state === "disabled") {
    return "user_disabled";
  }
  if (subject.state === "archived") {
    return "user_archived";
  }
  return "active";
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

function readTokenPolicyFile(filePath: string): TokenLimitPolicy {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as TokenLimitPolicy;
  return validatePlanPolicy(parsed);
}

function resolveTokenWindowPolicy(
  store: ReturnType<typeof createSqliteStore>,
  userId: string,
  prefix?: string
): {
  credential: AccessCredentialRecord | null;
  entitlementId: string | null;
  policy: TokenLimitPolicy;
} {
  const access = store.entitlementAccessForSubject(userId);
  const credential = prefix
    ? resolveCredentialForUser(store, userId, prefix)
    : firstActiveCredential(store, userId);
  if (access.status === "active") {
    return {
      credential,
      entitlementId: access.entitlement.id,
      policy: mergeEntitlementTokenPolicy(
        access.entitlement.policySnapshot,
        credential?.rate.token ?? null
      )
    };
  }
  const tokenCredential = resolveTokenPolicyCredential(store, userId, prefix);
  return {
    credential: tokenCredential,
    entitlementId: null,
    policy: tokenCredential.rate.token as TokenLimitPolicy
  };
}

function firstActiveCredential(
  store: ReturnType<typeof createSqliteStore>,
  userId: string
): AccessCredentialRecord | null {
  const now = new Date();
  const subject = store.getSubject(userId);
  return (
    store
      .listAccessCredentials({ subjectId: userId, includeRevoked: false })
      .find((credential) => credentialStatus(credential, subject, now) === "active") ?? null
  );
}

function resolveCredentialForUser(
  store: ReturnType<typeof createSqliteStore>,
  userId: string,
  prefix: string
): AccessCredentialRecord {
  const credential = store.getAccessCredentialByPrefix(prefix);
  if (!credential || credential.subjectId !== userId) {
    throw new Error(`Credential prefix not found for user ${userId}: ${prefix}`);
  }
  return credential;
}

function entitlementEndFromOptions(
  start: Date | undefined,
  end: Date | undefined,
  durationMs: number | undefined
): Date | null | undefined {
  if (end && durationMs !== undefined) {
    throw new Error("Use --end or --duration, not both.");
  }
  if (end) {
    return end;
  }
  if (durationMs !== undefined) {
    return new Date((start ?? new Date()).getTime() + durationMs);
  }
  return undefined;
}

function entitlementGrantAuditParams(options: {
  plan: string;
  period: PeriodKind;
  start?: Date;
  end?: Date;
  duration?: number;
  replace?: boolean;
  notes?: string;
}): Record<string, unknown> {
  return {
    plan_id: options.plan,
    period: options.period,
    start: options.start?.toISOString(),
    end: options.end?.toISOString(),
    duration_ms: options.duration,
    replace: Boolean(options.replace),
    notes: normalizeOptionalText(options.notes)
  };
}

function parseScopeList(value: string): Scope[] {
  const scopes = parseCommaList(value).map(parseScope);
  if (scopes.length === 0) {
    throw new InvalidArgumentError("scope list must not be empty");
  }
  return Array.from(new Set(scopes));
}

function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePlanState(value: string): PlanState {
  if (value === "active" || value === "deprecated") {
    return value;
  }
  throw new InvalidArgumentError("plan state must be active or deprecated");
}

function parsePeriodKind(value: string): PeriodKind {
  if (value === "monthly" || value === "one_off" || value === "unlimited") {
    return value;
  }
  throw new InvalidArgumentError("period must be monthly, one_off, or unlimited");
}

function parseEntitlementState(value: string): EntitlementState {
  if (
    value === "scheduled" ||
    value === "active" ||
    value === "paused" ||
    value === "expired" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new InvalidArgumentError(
    "entitlement state must be scheduled, active, paused, expired, or cancelled"
  );
}

function parseReportGroupBy(value: string): "entitlement" {
  if (value === "entitlement") {
    return value;
  }
  throw new InvalidArgumentError("group-by must be entitlement");
}

function parseDurationMs(value: string): number {
  const match = value.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    throw new InvalidArgumentError("duration must look like 30m, 1h, or 7d");
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new InvalidArgumentError("duration amount must be a positive integer");
  }
  if (unit === "m") {
    return amount * 60_000;
  }
  if (unit === "h") {
    return amount * 60 * 60_000;
  }
  return amount * 24 * 60 * 60_000;
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
    value === "reveal-key" ||
    value === "update-user" ||
    value === "disable-user" ||
    value === "enable-user" ||
    value === "prune-events" ||
    value === "token-overrun" ||
    value === "token-reservation-expired" ||
    value === "plan-create" ||
    value === "plan-deprecate" ||
    value === "entitlement-grant" ||
    value === "entitlement-renew" ||
    value === "entitlement-cancel" ||
    value === "entitlement-pause" ||
    value === "entitlement-resume" ||
    value === "entitlement-activate" ||
    value === "entitlement-expire"
  ) {
    return value;
  }
  throw new InvalidArgumentError(
    "action must be a known admin audit action"
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

function parseNullableNonNegativeInteger(value: string): number | null {
  if (value.toLowerCase() === "null" || value.toLowerCase() === "none") {
    return null;
  }
  return parseNonNegativeInteger(value);
}

function parseMissingUsageCharge(value: string): MissingUsageCharge {
  if (value === "none" || value === "estimate" || value === "reserve") {
    return value;
  }
  throw new InvalidArgumentError("missing usage charge must be none, estimate, or reserve");
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

function normalizeOptionalText(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
