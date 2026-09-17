import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Command } from "commander";
import { releaseExternalSubjectRegistration } from "@codex-gateway/store-sqlite";

export function registerRegistrationReleaseCommand(program: Command, context: {
  dbPath(): string;
  printJson(value: unknown): void;
}): void {
  program.command("release-registration <provider> <external-user-id>")
    .description("Preview a registration release; writes require --apply and a fresh preview revision.")
    .requiredOption("--actor <id>", "Audited operator ID")
    .requiredOption("--reason <text>", "Audited release reason")
    .option("--dry-run", "Read-only preview (default)")
    .option("--apply", "Apply after backup through the R760 control wrapper")
    .option("--expected-revision <hash>", "Exact revision from preview")
    .action((provider: string, externalUserId: string, options: {
      actor: string; reason: string; dryRun?: boolean; apply?: boolean; expectedRevision?: string;
    }) => {
      if (options.apply && options.dryRun) throw new Error("--apply and --dry-run are mutually exclusive.");
      if (options.apply && !/^[a-f0-9]{64}$/.test(options.expectedRevision ?? "")) {
        throw new Error("Apply requires the exact --expected-revision from a read-only preview.");
      }
      const dbPath = context.dbPath();
      if (!existsSync(dbPath)) throw new Error("Existing migrated Gateway database is required.");
      const db = new DatabaseSync(dbPath, {readOnly: !options.apply});
      try {
        db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
        if (!options.apply) db.exec("PRAGMA query_only = ON;");
        // This command must never migrate or initialize a production database.
        if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 33").get()) {
          throw new Error("Registration release requires migration 33; use the controlled deployment process first.");
        }
        context.printJson(releaseExternalSubjectRegistration(db, {
          provider, externalUserId, actor: options.actor, reason: options.reason,
          dryRun: !options.apply, ...(options.expectedRevision ? {expectedRevision: options.expectedRevision} : {})
        }));
      } finally {
        db.close();
      }
    });
}
