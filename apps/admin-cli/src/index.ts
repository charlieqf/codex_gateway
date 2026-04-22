import { Command } from "commander";

const program = new Command();

program
  .name("codex-gateway-admin")
  .description("Admin CLI for Codex Gateway")
  .version("0.1.0");

program
  .command("issue")
  .description("Issue an access credential. Not implemented in scaffold.")
  .option("--label <label>")
  .option("--scope <scope>", "medical or code")
  .action(() => {
    throw new Error("issue is planned for Phase 2.");
  });

program
  .command("revoke")
  .argument("<credential-prefix>")
  .description("Revoke an access credential. Not implemented in scaffold.")
  .action(() => {
    throw new Error("revoke is planned for Phase 2.");
  });

await program.parseAsync();

