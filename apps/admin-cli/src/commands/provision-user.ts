import type { Command } from "commander";

import {
  issueAccessCredential,
  type AccessCredentialRecord,
  type Entitlement,
  type PeriodKind,
  type Scope,
  type Subject
} from "@codex-gateway/core";
import type { SqliteGatewayStore } from "@codex-gateway/store-sqlite";

import { encryptAccessCredentialToken } from "../crypto.js";
import {
  parseDate,
  parseDurationMs,
  parseNullablePositiveInteger,
  parsePeriodKind,
  parsePositiveInteger,
  parseScope
} from "../parsers.js";
import {
  publicCredential,
  publicEntitlement,
  publicPlan,
  publicSubject
} from "../serializers.js";
import type { CommandContext, CommandRateOptions } from "./command-context.js";

interface ProvisionUserOptions extends CommandRateOptions {
  user: string;
  name: string;
  phone: string;
  userLabel?: string;
  plan: string;
  period: PeriodKind;
  start?: Date;
  end?: Date;
  duration?: number;
  replace?: boolean;
  renew?: boolean;
  notes?: string;
  externalId?: string;
  keyLabel?: string;
  scope: Scope;
  expiresDays: number;
}

export function registerProvisionUserCommand(program: Command, deps: CommandContext): void {
  program
    .command("provision-user")
    .description("Create or update a user, grant or renew plan quota, and optionally issue an API key.")
    .requiredOption("--user <id>", "user id")
    .requiredOption("--name <name>", "user real name")
    .requiredOption("--phone <phone>", "user phone number")
    .requiredOption("--plan <id>", "plan id")
    .option("--user-label <label>", "user display label")
    .option("--period <kind>", "monthly, one_off, or unlimited", parsePeriodKind, "monthly")
    .option("--start <iso>", "entitlement period start", parseDate)
    .option("--duration <duration>", "one_off duration such as 1h, 30m, or 30d", parseDurationMs)
    .option("--end <iso>", "one_off entitlement period end", parseDate)
    .option("--replace", "cancel conflicting current/scheduled entitlement before grant")
    .option("--renew", "create a scheduled monthly renewal instead of granting an immediate entitlement")
    .option("--notes <text>", "operator notes copied to the entitlement")
    .option("--external-id <id>", "external registration, payment, or CRM id for audit correlation")
    .option("--key-label <label>", "issue a new API key with this label; omit to skip key issue")
    .option("--scope <scope>", "new API key scope: code or medical", parseScope, "code")
    .option("--expires-days <days>", "days until a newly issued API key expires", parsePositiveInteger, 365)
    .option("--rpm <n>", "new API key requests per minute", parsePositiveInteger, 60)
    .option("--rpd <n>", "new API key requests per day; use none for unlimited", parseNullablePositiveInteger, 5000)
    .option("--concurrent <n>", "new API key concurrent requests; use none for unlimited", parseNullablePositiveInteger, 4)
    .action((options: ProvisionUserOptions) => {
      deps.withAuditedStore(
        {
          action: "provision-user",
          targetUserId: options.user,
          params: provisionAuditParams(options, deps)
        },
        (store) => {
          assertProvisionOptions(options, deps);
          const issued = options.keyLabel ? prepareCredential(options.user, options, deps) : null;
          const selectedPlan = store.getPlan(options.plan);
          if (!selectedPlan) {
            throw new Error(`Plan not found: ${options.plan}`);
          }
          if (selectedPlan.state !== "active") {
            throw new Error(`Plan is deprecated and cannot grant new entitlements: ${options.plan}`);
          }
          if (issued && !selectedPlan.scopeAllowlist.includes(options.scope)) {
            throw new Error(`API key scope is not allowed by selected plan: ${options.scope}`);
          }
          const subject = upsertProvisionedSubject(store, options, deps);
          const entitlement = options.renew
            ? store.renewEntitlement({
                subjectId: subject.id,
                planId: options.plan,
                replace: Boolean(options.replace)
              })
            : store.grantEntitlement({
                subjectId: subject.id,
                planId: options.plan,
                periodKind: options.period,
                periodStart: options.start,
                periodEnd: entitlementEndFromOptions(options.start, options.end, options.duration),
                replace: Boolean(options.replace),
                notes: deps.normalizeOptionalText(options.notes)
              });

          if (issued) {
            store.insertAccessCredential(issued.record);
          }

          const credential = issued ? publicCredential(issued.record, subject, new Date(), issued.token) : null;
          return {
            output: {
              user: publicSubject(subject),
              plan: publicPlan(selectedPlan, false),
              entitlement: publicEntitlement(entitlement),
              credential,
              credential_issued: Boolean(issued),
              mode: options.renew ? "renew" : "grant"
            },
            audit: {
              targetUserId: subject.id,
              targetCredentialId: issued?.record.id ?? null,
              targetCredentialPrefix: issued?.record.prefix ?? null,
              params: {
                entitlement_id: entitlement.id,
                plan_id: entitlement.planId,
                credential_issued: Boolean(issued),
                credential_prefix: issued?.record.prefix ?? null,
                mode: options.renew ? "renew" : "grant"
              }
            }
          };
        }
      );
    });
}

function assertProvisionOptions(options: ProvisionUserOptions, deps: CommandContext): void {
  if (!deps.normalizeOptionalText(options.name)) {
    throw new Error("--name cannot be empty.");
  }
  if (!deps.normalizeOptionalText(options.phone)) {
    throw new Error("--phone cannot be empty.");
  }
  if (options.renew && (options.start || options.end || options.duration !== undefined || options.period !== "monthly")) {
    throw new Error("--renew only creates a scheduled monthly renewal; do not combine it with period/start/end/duration options.");
  }
  if (!options.renew && options.period === "one_off" && !options.end && options.duration === undefined) {
    throw new Error("one_off provisioning requires --end or --duration.");
  }
  if (options.end && options.duration !== undefined) {
    throw new Error("Use --end or --duration, not both.");
  }
}

function upsertProvisionedSubject(
  store: SqliteGatewayStore,
  options: ProvisionUserOptions,
  deps: CommandContext
): Subject {
  const existing = store.getSubject(options.user);
  if (existing && existing.state !== "active") {
    throw new Error(`User is ${existing.state}; enable the user before provisioning.`);
  }
  const subject: Subject = {
    id: options.user,
    label:
      deps.normalizeOptionalText(options.userLabel) ??
      deps.normalizeOptionalText(options.name) ??
      options.user,
    name: deps.normalizeOptionalText(options.name),
    phoneNumber: deps.normalizeOptionalText(options.phone),
    state: "active",
    createdAt: existing?.createdAt ?? new Date()
  };
  store.upsertSubject(subject);
  return store.getSubject(options.user) ?? subject;
}

function prepareCredential(
  userId: string,
  options: ProvisionUserOptions,
  deps: CommandContext
): { token: string; record: AccessCredentialRecord } {
  const issued = issueAccessCredential({
    subjectId: userId,
    label: options.keyLabel as string,
    scope: options.scope,
    expiresAt: deps.addDays(new Date(), options.expiresDays),
    rate: deps.rateFromOptions(options)
  });
  return {
    token: issued.token,
    record: {
      ...issued.record,
      tokenCiphertext: encryptAccessCredentialToken(issued.token)
    }
  };
}

function entitlementEndFromOptions(
  start: Date | undefined,
  end: Date | undefined,
  durationMs: number | undefined
): Date | null | undefined {
  if (end) {
    return end;
  }
  if (durationMs !== undefined) {
    return new Date((start ?? new Date()).getTime() + durationMs);
  }
  return undefined;
}

function provisionAuditParams(options: ProvisionUserOptions, deps: CommandContext): Record<string, unknown> {
  return {
    user_id: options.user,
    user_name: deps.normalizeOptionalText(options.name),
    user_phone: deps.normalizeOptionalText(options.phone),
    user_label: deps.normalizeOptionalText(options.userLabel),
    plan_id: options.plan,
    period: options.period,
    start: options.start?.toISOString(),
    end: options.end?.toISOString(),
    duration_ms: options.duration,
    replace: Boolean(options.replace),
    renew: Boolean(options.renew),
    notes: deps.normalizeOptionalText(options.notes),
    external_id: deps.normalizeOptionalText(options.externalId),
    key_label: deps.normalizeOptionalText(options.keyLabel),
    key_scope: options.scope,
    key_expires_days: options.expiresDays,
    key_rate: options.keyLabel ? deps.rateFromOptions(options) : undefined
  };
}
