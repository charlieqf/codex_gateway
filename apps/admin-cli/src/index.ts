#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  issueAccessCredential,
  issueBillingAdminToken,
  issueUnifiedClientKey,
  defaultPublicModelAliasGroups,
  mergeEntitlementTokenPolicy,
  publicTokenPolicy,
  publicTokenUsage,
  validateFeaturePolicy,
  validatePlanPolicy,
  type AccessCredentialRecord,
  type AdminAuditEventRecord,
  type BillingAdminTokenKind,
  type BillingAdminTokenState,
  type Entitlement,
  type EntitlementState,
  type PeriodKind,
  type PlanState,
  type RateLimitPolicy,
  type Scope,
  type Subject,
  type SubjectState,
  type TokenLimitPolicy
} from "@codex-gateway/core";
import {
  createSqliteStore,
  createSqliteTokenBudgetLimiter,
  writeQuotaDashboard
} from "@codex-gateway/store-sqlite";
import {
  type AuditedActionResult,
  type AuditInput,
  adminAuditRecord,
  mergeAudit,
  sanitizeAuditErrorMessage
} from "./audit.js";
import {
  buildCommandContext,
  type CommandRateOptions,
  type MissingUsageCharge,
  type NullableIntegerOption
} from "./commands/command-context.js";
import {
  defaultClientEventsDbPath,
  registerClientEventQueryCommands
} from "./commands/client-event-queries.js";
import { registerIssueCommand } from "./commands/issue.js";
import { registerProvisionUserCommand } from "./commands/provision-user.js";
import { resolveSubjectUserId } from "./commands/subject-options.js";
import {
  encryptAccessCredentialToken,
  encryptGatewaySecret,
  revealAccessCredentialToken
} from "./crypto.js";
import {
  parseAdminAuditAction,
  parseAdminAuditStatus,
  parseBillingAdminTokenKind,
  parseBillingAdminTokenState,
  parseCommaList,
  parseDate,
  parseDurationMs,
  parseEntitlementState,
  parseMissingUsageCharge,
  parseNonNegativeInteger,
  parseNullableNonNegativeInteger,
  parseNullablePositiveInteger,
  parsePeriodKind,
  parsePlanState,
  parsePositiveInteger,
  parseReportGroupBy,
  parseScope,
  parseScopeList,
  parseSubjectState
} from "./parsers.js";
import {
  auditCredentialSnapshot,
  credentialStatus,
  publicAdminAuditEvent,
  publicBillingAdminToken,
  publicCredential,
  publicEntitlement,
  publicEntitlementAccess,
  publicPlan,
  publicSubject,
  publicUnifiedClientKey
} from "./serializers.js";

const defaultSubjectId = "subj_dev";
const defaultSubjectLabel = "dev-subject";

const program = new Command();

program
  .name("codex-gateway-admin")
  .description("Admin CLI for Codex Gateway")
  .version("0.1.0")
  .option("--db <path>", "SQLite database path", process.env.GATEWAY_SQLITE_PATH)
  .option(
    "--client-events-db <path>",
    "client events SQLite database path",
    process.env.GATEWAY_CLIENT_EVENTS_SQLITE_PATH
  )
  .option("--verbose", "write diagnostic logs to stderr");

const commandContext = buildCommandContext({
  defaultSubjectId,
  defaultSubjectLabel,
  withAuditedStore,
  normalizeOptionalText,
  entitlementCheckBypassed,
  rateFromOptions,
  assertCanIssueCredentialForEntitlement,
  addDays
});

registerIssueCommand(program, commandContext);
registerProvisionUserCommand(program, commandContext);
registerClientEventQueryCommands(program, {
  gatewayDbPath: requireDbPath,
  clientEventsDbPath: requireClientEventsDbPath,
  printJson,
  printText
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

const unifiedKeyCommand = program
  .command("unified-key")
  .description("Manage Gateway-brokered client unified keys.");

unifiedKeyCommand
  .command("issue")
  .description("Issue a cgu_live unified client key backed by Gateway and MedEvidence keys.")
  .requiredOption("--user <id>", "user id")
  .requiredOption("--codex-credential-prefix <prefix>", "existing Gateway API key prefix to include")
  .option("--medevidence-key <plaintext>", "MedEvidence API key plaintext; prefer --medevidence-key-env")
  .option("--medevidence-key-env <name>", "environment variable containing the MedEvidence API key")
  .option("--medevidence-key-prefix <prefix>", "public MedEvidence key prefix for support lookup")
  .option("--medevidence-base-url <url>", "MedEvidence service base URL to return from resolve")
  .option("--label <label>", "unified key label", "Desktop unified key")
  .option("--expires-days <days>", "days until unified key expiration", parsePositiveInteger)
  .option("--expires-at <iso>", "absolute unified key expiration", parseDate)
  .action((options: UnifiedKeyIssueOptions) => {
    withAuditedStore(
      {
        action: "unified-key-issue",
        targetUserId: options.user,
        targetCredentialPrefix: options.codexCredentialPrefix,
        params: {
          codex_credential_prefix: options.codexCredentialPrefix,
          label: options.label,
          expires_days: options.expiresDays,
          expires_at: options.expiresAt?.toISOString(),
          medevidence_key_prefix: options.medevidenceKeyPrefix,
          medevidence_base_url: normalizeOptionalText(options.medevidenceBaseUrl),
          medevidence_key_source: options.medevidenceKeyEnv ? "env" : options.medevidenceKey ? "argument" : null
        }
      },
      (store) => {
        if (options.expiresDays !== undefined && options.expiresAt !== undefined) {
          throw new Error("Use --expires-days or --expires-at, not both.");
        }
        const subject = store.getSubject(options.user);
        if (!subject) {
          throw new Error(`User not found: ${options.user}`);
        }
        if (subject.state !== "active") {
          throw new Error(`User is not active: ${options.user}`);
        }
        const codexCredential = store.getAccessCredentialByPrefix(options.codexCredentialPrefix);
        if (!codexCredential || codexCredential.subjectId !== options.user) {
          throw new Error(
            `Gateway credential prefix not found for user ${options.user}: ${options.codexCredentialPrefix}`
          );
        }
        if (credentialStatus(codexCredential, subject, new Date()) !== "active") {
          throw new Error(`Gateway credential is not active: ${options.codexCredentialPrefix}`);
        }
        const codexToken = revealAccessCredentialToken(codexCredential);
        if (!codexToken) {
          throw new Error(
            `Gateway credential token is not recoverable; rotate the key first: ${options.codexCredentialPrefix}`
          );
        }
        const medevidenceToken = resolveMedevidenceKeyPlaintext(options);
        const expiresAt = options.expiresAt ?? addDays(new Date(), options.expiresDays ?? 56);
        const issued = issueUnifiedClientKey({
          subjectId: options.user,
          label: options.label,
          expiresAt,
          codexCredentialId: codexCredential.id,
          codexCredentialPrefix: codexCredential.prefix,
          codexKeyCiphertext: encryptGatewaySecret(codexToken),
          medevidenceKeyCiphertext: encryptGatewaySecret(medevidenceToken),
          medevidenceKeyPrefix:
            normalizeOptionalText(options.medevidenceKeyPrefix) ?? keyPrefix(medevidenceToken),
          metadata: normalizeOptionalText(options.medevidenceBaseUrl)
            ? { medevidence_base_url: normalizeOptionalText(options.medevidenceBaseUrl) }
            : null
        });
        store.insertUnifiedClientKey(issued.record);
        return {
          output: {
            unified_key: issued.token,
            key: publicUnifiedClientKey(issued.record, subject),
            resolve: {
              method: "POST",
              path: "/gateway/unified-keys/resolve"
            }
          },
          audit: {
            targetUserId: options.user,
            targetCredentialId: issued.record.id,
            targetCredentialPrefix: issued.record.prefix,
            params: {
              codex_credential_prefix: codexCredential.prefix,
              medevidence_key_prefix: issued.record.medevidenceKeyPrefix,
              expires_at: issued.record.expiresAt.toISOString()
            }
          }
        };
      }
    );
  });

unifiedKeyCommand
  .command("list")
  .description("List unified client keys.")
  .option("--user <id>", "filter by user id")
  .option("--active-only", "hide revoked or expired keys")
  .action((options: { user?: string; activeOnly?: boolean }) => {
    withStore((store) => {
      const now = new Date();
      const subjects = subjectMap(store.listSubjects({ includeArchived: true }));
      const keys = store
        .listUnifiedClientKeys({
          subjectId: options.user,
          includeRevoked: options.activeOnly ? false : true
        })
        .filter((key) => !options.activeOnly || (!key.revokedAt && key.expiresAt.getTime() > now.getTime()));
      printJson({
        keys: keys.map((key) => publicUnifiedClientKey(key, subjects.get(key.subjectId) ?? null))
      });
    });
  });

unifiedKeyCommand
  .command("show")
  .argument("<prefix>")
  .description("Show unified client key metadata by prefix.")
  .action((prefix) => {
    withStore((store) => {
      const key = store.getUnifiedClientKeyByPrefix(prefix);
      if (!key) {
        throw new Error(`Unified key prefix not found: ${prefix}`);
      }
      printJson({
        key: publicUnifiedClientKey(key, store.getSubject(key.subjectId))
      });
    });
  });

unifiedKeyCommand
  .command("revoke")
  .argument("<prefix>")
  .description("Revoke a unified client key by prefix.")
  .action((prefix) => {
    withAuditedStore(
      { action: "unified-key-revoke", targetCredentialPrefix: prefix },
      (store) => {
        const revoked = store.revokeUnifiedClientKeyByPrefix(prefix);
        if (!revoked) {
          throw new Error(`Unified key prefix not found: ${prefix}`);
        }
        return {
          output: {
            key: publicUnifiedClientKey(revoked, store.getSubject(revoked.subjectId))
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

const billingTokenCommand = program
  .command("billing-token")
  .description("Manage billing admin Bearer tokens.");

billingTokenCommand
  .command("issue")
  .description("Issue a one-time visible billing admin token.")
  .requiredOption("--label <label>", "billing admin token label")
  .option("--kind <kind>", "token kind: test or live", parseBillingAdminTokenKind, "test")
  .option("--expires-days <days>", "days until token expiration", parsePositiveInteger)
  .option("--expires-at <iso>", "absolute token expiration", parseDate)
  .option("--metadata <json>", "non-secret JSON object stored with token metadata")
  .action((options: BillingTokenIssueOptions) => {
    withAuditedStore(
      {
        action: "billing-token-issue",
        params: {
          label: options.label,
          kind: options.kind,
          expires_days: options.expiresDays,
          expires_at: options.expiresAt?.toISOString()
        }
      },
      (store) => {
        if (options.expiresDays !== undefined && options.expiresAt !== undefined) {
          throw new Error("Use --expires-days or --expires-at, not both.");
        }
        const label = normalizeOptionalText(options.label);
        if (!label) {
          throw new Error("Token label must not be empty.");
        }
        const expiresAt = options.expiresAt ?? addDays(new Date(), options.expiresDays ?? 14);
        const issued = issueBillingAdminToken({
          label,
          kind: options.kind,
          expiresAt,
          metadata: parseJsonObjectOption(options.metadata, "metadata")
        });
        store.insertBillingAdminToken(issued.record);
        return {
          output: {
            token: issued.token,
            billing_token: publicBillingAdminToken(issued.record)
          },
          audit: {
            targetCredentialId: issued.record.id,
            targetCredentialPrefix: issued.record.prefix,
            params: {
              label,
              kind: issued.record.kind,
              expires_at: issued.record.expiresAt.toISOString()
            }
          }
        };
      }
    );
  });

billingTokenCommand
  .command("list")
  .description("List billing admin tokens.")
  .option("--active-only", "hide revoked or expired tokens")
  .option("--state <state>", "filter by state: active or revoked", parseBillingAdminTokenState)
  .option("--limit <count>", "maximum tokens to return", parsePositiveInteger, 100)
  .action((options: BillingTokenListOptions) => {
    withStore((store) => {
      const tokens = store.listBillingAdminTokens({
        activeOnly: Boolean(options.activeOnly),
        state: options.activeOnly ? undefined : options.state,
        limit: options.limit
      });
      printJson({
        billing_tokens: tokens.map((token) => publicBillingAdminToken(token))
      });
    });
  });

billingTokenCommand
  .command("show")
  .argument("<token-prefix>")
  .description("Show billing admin token metadata by full public prefix.")
  .action((prefix) => {
    const normalizedPrefix = normalizeBillingAdminTokenPrefix(prefix);
    withStore((store) => {
      const token = store.getBillingAdminTokenByPrefix(normalizedPrefix);
      if (!token) {
        throw new Error(`Billing admin token prefix not found: ${normalizedPrefix}`);
      }
      printJson({
        billing_token: publicBillingAdminToken(token)
      });
    });
  });

billingTokenCommand
  .command("revoke")
  .argument("<token-prefix>")
  .description("Revoke a billing admin token by full public prefix.")
  .option("--reason <reason>", "non-secret revocation reason")
  .action((prefix, options: { reason?: string }) => {
    const normalizedPrefix = normalizeBillingAdminTokenPrefix(prefix);
    withAuditedStore(
      {
        action: "billing-token-revoke",
        targetCredentialPrefix: normalizedPrefix,
        params: { reason: normalizeOptionalText(options.reason) }
      },
      (store) => {
        const revoked = store.revokeBillingAdminTokenByPrefix(normalizedPrefix);
        if (!revoked) {
          throw new Error(`Billing admin token prefix not found: ${normalizedPrefix}`);
        }
        return {
          output: {
            billing_token: publicBillingAdminToken(revoked)
          },
          audit: {
            targetCredentialId: revoked.id,
            targetCredentialPrefix: revoked.prefix,
            params: { reason: normalizeOptionalText(options.reason) }
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
  .option("--feature-policy-file <path>", "JSON feature policy file")
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
          team_pool_id: options.teamPoolId ?? null,
          feature_policy_file: options.featurePolicyFile ?? null
        }
      },
      (store) => {
        const plan = store.createPlan({
          id: options.id,
          displayName: options.displayName ?? options.id,
          policy: readTokenPolicyFile(options.policyFile),
          featurePolicy: options.featurePolicyFile
            ? readFeaturePolicyFile(options.featurePolicyFile)
            : undefined,
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
  .option("--reason <text>", "pause reason")
  .action((id, options) => {
    const reason = normalizeOptionalText(options.reason);
    withStore((store) => {
      const entitlement = store.pauseEntitlement({ id, reason });
      printJson({ entitlement: publicEntitlement(entitlement) });
    });
  });

entitlementCommand
  .command("resume")
  .argument("<entitlement-id>")
  .description("Resume a paused entitlement.")
  .action((id) => {
    withStore((store) => {
      const entitlement = store.resumeEntitlement({ id });
      printJson({ entitlement: publicEntitlement(entitlement) });
    });
  });

entitlementCommand
  .command("cancel")
  .argument("<entitlement-id>")
  .description("Cancel an entitlement.")
  .option("--reason <text>", "cancellation reason")
  .action((id, options) => {
    withStore((store) => {
      const entitlement = store.cancelEntitlement({
        id,
        reason: normalizeOptionalText(options.reason)
      });
      printJson({ entitlement: publicEntitlement(entitlement) });
    });
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
          entitlementCheckBypassed(options)
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
          public_model_id: event.publicModelId ?? null,
          upstream_runtime: event.upstreamRuntime ?? null,
          upstream_model: event.upstreamModel ?? null,
          reasoning_effort: event.reasoningEffort ?? null,
          client_turn_id: event.clientTurnId ?? null,
          turn_code: event.turnCode ?? null,
          client_session_id: event.clientSessionId ?? null,
          client_message_id: event.clientMessageId ?? null,
          client_app_version: event.clientAppVersion ?? null,
          tool_choice: event.toolChoice ?? null,
          upstream_finish_reason: event.upstreamFinishReason ?? null,
          upstream_request_id: event.upstreamRequestId ?? null,
          upstream_http_status: event.upstreamHttpStatus ?? null,
          upstream_content_chars: event.upstreamContentChars ?? null,
          upstream_tool_call_count: event.upstreamToolCallCount ?? null,
          upstream_tool_names: event.upstreamToolNames ?? null,
          upstream_raw_response_hash: event.upstreamRawResponseHash ?? null,
          upstream_raw_response_chars: event.upstreamRawResponseChars ?? null,
          upstream_empty_stop: event.upstreamEmptyStop ?? null,
          upstream_attempt_count: event.upstreamAttemptCount ?? null,
          upstream_attempts: event.upstreamAttempts ?? null,
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
  .option("--model <public_model_id>", "filter by public model id; aliases such as medcode are folded into max")
  .option("--runtime <runtime>", "filter by upstream runtime such as codex or openrouter")
  .option("--provider <provider>", "filter by provider kind")
  .option("--days <days>", "days to report when --since is omitted", parsePositiveInteger, 7)
  .option("--since <iso>", "inclusive ISO start time", parseDate)
  .option("--until <iso>", "exclusive ISO end time", parseDate)
  .option(
    "--group-by <dimension>",
    "optional grouping dimension: entitlement, model, user-model, or entitlement-model",
    parseReportGroupBy
  )
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
        publicModelId: options.model,
        upstreamRuntime: options.runtime,
        provider: options.provider,
        since,
        until,
        groupBy: options.groupBy,
        publicModelAliases: defaultPublicModelAliasGroups
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
          public_model_id: row.publicModelId,
          model_display_name: modelDisplayName(row.publicModelId),
          upstream_runtime: row.upstreamRuntime,
          upstream_model: row.upstreamModel,
          reasoning_effort: row.reasoningEffort ?? null,
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
          reasoning_tokens: row.reasoningTokens,
          usage_missing: row.usageMissing,
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
        entitlementPeriodStart: resolved.entitlement?.periodStart ?? null,
        entitlementPeriodEnd: resolved.entitlement?.periodEnd ?? null,
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
  .command("quota-dashboard")
  .description("Generate a static HTML dashboard for user plans and token quota windows.")
  .option("--out <path>", "HTML output path", "quota-dashboard.html")
  .option("--include-inactive", "include disabled and archived users")
  .action(async (options: { out: string; includeInactive?: boolean }) => {
    await withStoreAsync(async (store) => {
      const result = await writeQuotaDashboard(store, {
        outputPath: options.out,
        includeInactive: Boolean(options.includeInactive)
      });
      printJson({
        output_path: result.outputPath,
        generated_at: result.generatedAt,
        users: result.users,
        active_entitlements: result.activeEntitlements,
        legacy_users: result.legacyUsers,
        users_without_quota: result.usersWithoutQuota
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
          public_model_id: reservation.publicModelId,
          upstream_runtime: reservation.upstreamRuntime,
          upstream_model: reservation.upstreamModel,
          reasoning_effort: reservation.reasoningEffort,
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
          final_reasoning_tokens: reservation.finalReasoningTokens,
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
  entitlementCheck?: boolean;
}

interface UnifiedKeyIssueOptions {
  user: string;
  codexCredentialPrefix: string;
  medevidenceKey?: string;
  medevidenceKeyEnv?: string;
  medevidenceKeyPrefix?: string;
  medevidenceBaseUrl?: string;
  label: string;
  expiresDays?: number;
  expiresAt?: Date;
}

interface BillingTokenIssueOptions {
  label: string;
  kind: BillingAdminTokenKind;
  expiresDays?: number;
  expiresAt?: Date;
  metadata?: string;
}

interface BillingTokenListOptions {
  activeOnly?: boolean;
  state?: BillingAdminTokenState;
  limit: number;
}

interface UpdateUserOptions {
  label?: string;
  name?: string;
  phone?: string;
  clearName?: boolean;
  clearPhone?: boolean;
}

interface TrialCheckOptions {
  maxActiveUsers: number;
}

type TrialCheckStatus = "ok" | "info" | "warning" | "error";

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

function requireClientEventsDbPath(): string {
  const dbPath = program.opts<{ clientEventsDb?: string }>().clientEventsDb;
  return dbPath ?? defaultClientEventsDbPath(requireDbPath());
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
  const revokedCredentials = credentials.filter(
    (credential) =>
      credentialStatus(credential, subjectsById.get(credential.subjectId), generatedAt) === "revoked"
  );
  const expiredCredentials = credentials.filter(
    (credential) =>
      credentialStatus(credential, subjectsById.get(credential.subjectId), generatedAt) === "expired"
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
        !store
          .listEntitlements({ planId: plan.id })
          .some((entitlement) => entitlement.createdAt.getTime() >= cutoff.getTime())
    );
  if (idlePlans.length === 0) {
    return {
      name: "active_plan_usage",
      status: "ok",
      message: "Active plans have recent entitlement usage or are still inside the 90-day window."
    };
  }
  return {
    name: "active_plan_usage",
    status: "info",
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

function entitlementCheckBypassed(options: { entitlementCheck?: boolean }): boolean {
  return options.entitlementCheck === false;
}

function resolveUserId(options: { user?: string; subjectId?: string }): string | undefined {
  return resolveSubjectUserId(options, defaultSubjectId);
}

function rateFromOptions(options: CommandRateOptions): RateLimitPolicy {
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
    no_entitlement_check: entitlementCheckBypassed(options)
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

function readTokenPolicyFile(filePath: string): TokenLimitPolicy {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as TokenLimitPolicy;
  return validatePlanPolicy(parsed);
}

function readFeaturePolicyFile(filePath: string) {
  return validateFeaturePolicy(JSON.parse(readFileSync(filePath, "utf8")));
}

function resolveTokenWindowPolicy(
  store: ReturnType<typeof createSqliteStore>,
  userId: string,
  prefix?: string
): {
  credential: AccessCredentialRecord | null;
  entitlementId: string | null;
  entitlement: { periodStart: Date; periodEnd: Date | null } | null;
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
      entitlement: access.entitlement,
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
    entitlement: null,
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

function resolveMedevidenceKeyPlaintext(options: UnifiedKeyIssueOptions): string {
  const fromArgument = normalizeOptionalText(options.medevidenceKey);
  const envName = normalizeOptionalText(options.medevidenceKeyEnv);
  if (fromArgument && envName) {
    throw new Error("Use --medevidence-key or --medevidence-key-env, not both.");
  }

  const token = envName ? normalizeOptionalText(process.env[envName]) : fromArgument;
  if (!token) {
    throw new Error("Set --medevidence-key-env or --medevidence-key.");
  }
  if (/\s/.test(token)) {
    throw new Error("MedEvidence key cannot contain whitespace.");
  }
  return token;
}

function keyPrefix(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.startsWith("mev2_live_")) {
    return trimmed.slice(0, Math.min(trimmed.length, 24));
  }
  return null;
}

function parseJsonObjectOption(
  value: string | undefined,
  name: string
): Record<string, unknown> | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  const json = JSON.stringify(parsed);
  if (json.length > 4_096) {
    throw new Error(`${name} is too large.`);
  }
  if (/bat_(?:test|live)_[A-Za-z0-9._-]+/.test(json)) {
    throw new Error(`${name} must not contain billing admin tokens.`);
  }
  const sensitivePath = findSensitiveJsonPath(parsed, []);
  if (sensitivePath) {
    throw new Error(`${name} contains sensitive field: ${sensitivePath}.`);
  }
  return parsed as Record<string, unknown>;
}

function findSensitiveJsonPath(value: unknown, pathParts: string[]): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitiveJsonPath(value[index], [...pathParts, String(index)]);
      if (found) {
        return found;
      }
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|authorization|bearer|password|card|cvv|cvc|pan/i.test(key)) {
      return [...pathParts, key].join(".");
    }
    const found = findSensitiveJsonPath(child, [...pathParts, key]);
    if (found) {
      return found;
    }
  }
  return null;
}

function normalizeBillingAdminTokenPrefix(value: string): string {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(".");
  return separator >= 0 ? trimmed.slice(0, separator) : trimmed;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function modelDisplayName(publicModelId: string | null): string | null {
  if (!publicModelId) {
    return null;
  }
  const known: Record<string, string> = {
    max: "Max",
    expert: "Expert",
    pro: "Pro",
    standard: "Standard"
  };
  return known[publicModelId] ?? publicModelId;
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

function printText(value: string): void {
  process.stdout.write(value);
}
