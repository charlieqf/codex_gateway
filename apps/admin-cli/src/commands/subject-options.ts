import type { Subject } from "@codex-gateway/core";

import type { CommandContext } from "./command-context.js";

export interface SubjectOptions {
  user?: string;
  userLabel?: string;
  name?: string;
  phone?: string;
  subjectId?: string;
  subjectLabel?: string;
}

type SubjectOptionContext = Pick<
  CommandContext,
  "defaultSubjectId" | "defaultSubjectLabel" | "normalizeOptionalText"
>;

export function subjectFromOptions(options: SubjectOptions, context: SubjectOptionContext): Subject {
  const user = resolveSubjectUserId(options, context.defaultSubjectId) ?? context.defaultSubjectId;
  const name = context.normalizeOptionalText(options.name);
  const phoneNumber = context.normalizeOptionalText(options.phone);
  const label =
    context.normalizeOptionalText(options.userLabel) ??
    name ??
    (options.user
      ? user
      : context.normalizeOptionalText(options.subjectLabel) ?? context.defaultSubjectLabel);

  return {
    id: user,
    label,
    name,
    phoneNumber,
    state: "active",
    createdAt: new Date()
  };
}

export function resolveSubjectUserId(
  options: { user?: string; subjectId?: string },
  defaultSubjectId: string
): string | undefined {
  if (options.user && options.subjectId && options.subjectId !== defaultSubjectId) {
    throw new Error("Use --user or --subject-id, not both.");
  }

  return options.user ?? options.subjectId;
}
