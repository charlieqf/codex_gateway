import type { Command } from "commander";

import {
  issueAccessCredential,
  type Scope,
  type Subject
} from "@codex-gateway/core";
import type { SqliteGatewayStore } from "@codex-gateway/store-sqlite";

import { encryptAccessCredentialToken } from "../crypto.js";
import {
  parseMissingUsageCharge,
  parseNonNegativeInteger,
  parseNullableNonNegativeInteger,
  parseNullablePositiveInteger,
  parsePositiveInteger,
  parseScope
} from "../parsers.js";
import { publicCredential } from "../serializers.js";
import type { CommandContext, CommandRateOptions } from "./command-context.js";
import {
  resolveSubjectUserId,
  subjectFromOptions,
  type SubjectOptions
} from "./subject-options.js";

interface IssueOptions extends SubjectOptions, CommandRateOptions {
  label: string;
  scope: Scope;
  expiresDays: number;
  entitlementCheck?: boolean;
}

export function registerIssueCommand(program: Command, deps: CommandContext): void {
  program
    .command("issue")
    .description("Issue an API key.")
    .requiredOption("--label <label>", "credential label")
    .requiredOption("--scope <scope>", "credential scope: code or medical", parseScope)
    .option("--user <id>", "user id; preferred alias for --subject-id")
    .option("--user-label <label>", "user label; preferred alias for --subject-label")
    .option("--name <name>", "user real name")
    .option("--phone <phone>", "user phone number")
    .option("--subject-id <id>", "subject id", deps.defaultSubjectId)
    .option("--subject-label <label>", "subject label", deps.defaultSubjectLabel)
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
    .action((options: IssueOptions) => {
      const targetUserId = issueTargetUserId(options, deps.defaultSubjectId);
      deps.withAuditedStore(
        {
          action: "issue",
          targetUserId,
          params: {
            label: options.label,
            scope: options.scope,
            user_id: targetUserId,
            user_name: deps.normalizeOptionalText(options.name),
            user_phone: deps.normalizeOptionalText(options.phone),
            expires_days: options.expiresDays,
            no_entitlement_check: deps.entitlementCheckBypassed(options),
            rate: deps.rateFromOptions(options)
          }
        },
        (store) => {
          const subject = issueSubject(store, options, deps);
          store.upsertSubject(subject);
          deps.assertCanIssueCredentialForEntitlement(
            store,
            subject.id,
            options.scope,
            deps.entitlementCheckBypassed(options)
          );

          const issued = issueAccessCredential({
            subjectId: subject.id,
            label: options.label,
            scope: options.scope,
            expiresAt: deps.addDays(new Date(), options.expiresDays),
            rate: deps.rateFromOptions(options)
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
}

function issueTargetUserId(options: { user?: string; subjectId?: string }, defaultSubjectId: string): string {
  return resolveSubjectUserId(options, defaultSubjectId) ?? defaultSubjectId;
}

function issueSubject(
  store: SqliteGatewayStore,
  options: SubjectOptions,
  deps: Pick<CommandContext, "defaultSubjectId" | "defaultSubjectLabel" | "normalizeOptionalText">
): Subject {
  const requested = subjectFromOptions(options, deps);
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
