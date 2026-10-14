// Who a token belongs to, from the proxy's GET /auth/whoami: the user, the
// org chosen at sign-in, the role there and the permissions the API derives
// from it. The proxy is the authority; the CLI never decides permissions.

import type { Config } from "../config.js";
import { CliError, EXIT } from "../output.js";

export interface Identity {
  user: {
    id: string;
    email?: string;
    firstName?: string | null;
    lastName?: string | null;
  };
  organization: { id: string; slug: string; name?: string } | null;
  role: string | null;
  permissions: string[];
  expiresAt: number | null;
}

/**
 * The permissions worth showing: the token also carries WorkOS widget
 * permissions and other products' (`ai:…`), which mean nothing to this CLI.
 * JSON output and session.json keep the full list.
 */
export function rulePermissions(permissions: string[]): string[] {
  return permissions.filter((p) => p.startsWith("l4:"));
}

/**
 * Fetch the identity behind an AuthKit access token. Returns null when the
 * server doesn't offer /auth/whoami (an older proxy).
 */
export async function fetchIdentity(
  config: Config,
  accessToken: string,
): Promise<Identity | null> {
  let res: Response;
  try {
    res = await fetch(`${config.authBase}/auth/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new CliError(
      `could not reach ${config.authBase}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 404) return null;
  if (res.status === 401) {
    throw new CliError(
      "the server rejected the sign-in token — run 'legalese login'",
      EXIT.UNAUTHENTICATED,
    );
  }
  if (!res.ok) {
    throw new CliError(`whoami failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as Identity;
  return {
    user: body.user,
    organization: body.organization ?? null,
    role: body.role ?? null,
    permissions: Array.isArray(body.permissions) ? body.permissions : [],
    expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null,
  };
}

/** "Ada Lovelace <ada@example.com>", or whatever parts exist. */
export function describeUser(user: Identity["user"]): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  if (name && user.email) return `${name} <${user.email}>`;
  return name || user.email || user.id;
}

/** "Acme (acme)" or "acme". */
export function describeOrg(org: { slug: string; name?: string }): string {
  return org.name && org.name !== org.slug
    ? `${org.name} (${org.slug})`
    : org.slug;
}
