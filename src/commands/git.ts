// `legalese git-credential <get|store|erase>` — the git credential-helper
// protocol, so `git clone` of gated skills.legalese.cloud repos reuses the CLI
// session. Configure once:
//
//   git config --global credential.https://skills.legalese.cloud.helper \
//     "legalese git-credential"

import { loadConfig } from "../config.js";
import type { GlobalOpts } from "../context.js";
import { readStdin } from "../context.js";
import { CliError } from "../output.js";
import { resolveAuth } from "../auth/resolve.js";

/** Parse git's key=value credential attributes from stdin. */
export function parseAttrs(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) attrs[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return attrs;
}

export async function gitCredentialCmd(
  action: string,
  globals: GlobalOpts,
): Promise<void> {
  // `store` is a no-op (the CLI owns its credential); `erase` too: git calls
  // it after a rejected credential, and `legalese logout` is how to sign out.
  if (action !== "get") return;

  const attrs = parseAttrs(await readStdin());
  // Gated repo paths are /{org}/{deployment}.git/… — the org comes from there.
  const orgFromPath = (attrs.path ?? "").split("/").filter(Boolean)[0];

  try {
    const auth = await resolveAuth(loadConfig(), {
      token: globals.token,
      org: globals.org ?? orgFromPath,
    });
    // Username is ignored by the proxy; the token is the password.
    process.stdout.write(`username=x\npassword=${auth.token}\n`);
  } catch (err) {
    // No credential for this repo (not signed in, or a different org): print
    // nothing so git falls back to its other helpers or a prompt.
    if (globals.verbose && err instanceof CliError) {
      process.stderr.write(`legalese: ${err.message}\n`);
    }
  }
}
