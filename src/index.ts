#!/usr/bin/env node
// legalese — Legalese Cloud CLI. Auth broker + execution surface for an
// account's deployed legal & policy decision rules.

import { Command } from "commander";
import { CliError, EXIT, setQuiet, warn } from "./output.js";
import type { GlobalOpts } from "./context.js";
import { loginCmd, logoutCmd, whoamiCmd, tokenCmd } from "./commands/auth.js";
import { searchCmd, schemaCmd, evalCmd, listCmd } from "./commands/rules.js";
import { gitCredentialCmd } from "./commands/git.js";

const program = new Command();

program
  .name("legalese")
  .description(
    "Legalese Cloud — discover and run your organization's deployed rules.\n\n" +
      "Sign in with 'legalese login': every command then acts as you, in the\n" +
      "org you chose, with your role's permissions.\n" +
      "Auth: --token > LEGALESE_TOKEN env > stored session.",
  )
  .version("0.2.0")
  .option(
    "--org <slug>",
    "org slug for an API key (a session is bound to its org)",
  )
  .option("--token <value>", "bearer credential (overrides session / env)")
  .option("--json", "machine-readable JSON output")
  .option("-q, --quiet", "suppress non-essential output")
  .option("-v, --verbose", "extra diagnostics");

/** Global options, read off the root program. */
const g = (): GlobalOpts => program.opts<GlobalOpts>();

program.hook("preAction", () => setQuiet(Boolean(g().quiet)));

program
  .command("login")
  .argument(
    "[org]",
    "org slug you expect to sign in to (checked after sign-in)",
  )
  .option(
    "--device",
    "sign in with a code instead of a browser callback (SSH, headless)",
  )
  .option("--no-browser", "print the sign-in link instead of opening a browser")
  .description("Sign in to Legalese Cloud and choose your organization.")
  .action(
    (org: string | undefined, opts: { device?: boolean; browser?: boolean }) =>
      loginCmd(org, opts, g()),
  );

program
  .command("logout")
  .description("Sign out: end the session on the server and remove it here.")
  .action(() => logoutCmd(g()));

program
  .command("whoami")
  .description("Show who you are signed in as: user, org, role, permissions.")
  .action(() => whoamiCmd(g()));

program
  .command("token")
  .description(
    "Print a valid access token, renewing it if needed (for other tools).",
  )
  .action(() => tokenCmd(g()));

program
  .command("search")
  .argument("<query>", "what you're looking for")
  .option("--limit <n>", "max results")
  .description("Find a deployed rule (matches function names + descriptions).")
  .action((query: string, opts: { limit?: string }) =>
    searchCmd(query, opts, g()),
  );

program
  .command("schema")
  .argument("<deployment>")
  .argument("[function]")
  .description("Show a deployment's function schema(s).")
  .action((deployment: string, fn: string | undefined) =>
    schemaCmd(deployment, fn, g()),
  );

program
  .command("eval")
  .argument("<deployment>")
  .argument("<function>")
  .argument("[inputs]", "JSON inputs (or '-' / omit to read stdin)")
  .description("Evaluate a deployed function.")
  .action((deployment: string, fn: string, inputs: string | undefined) =>
    evalCmd(deployment, fn, inputs, g()),
  );

program
  .command("list")
  .description(
    "List your org's deployments (as the VS Code Deployments tab shows them).",
  )
  .action(() => listCmd(g()));

program
  .command("git-credential")
  .argument("<action>", "get | store | erase")
  .description("git credential-helper bridge for gated skill repos.")
  .action((action: string) => gitCredentialCmd(action, g()));

program.parseAsync(process.argv).catch((err: unknown) => {
  const code = err instanceof CliError ? err.code : EXIT.ERROR;
  const message = err instanceof Error ? err.message : String(err);
  warn(`error: ${message}`);
  process.exit(code);
});
