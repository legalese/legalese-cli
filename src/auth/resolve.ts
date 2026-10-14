// Auth-resolution order: --token → LEGALESE_TOKEN → the stored session
// (refreshed when near expiry) → not logged in. Produces the bearer token and
// the org slug for request paths.
//
// A session is bound to the org chosen at sign-in, like the VS Code
// extension's: its token only works for that org, so asking for another org
// is an error rather than a request that would fail at the server.

import type { Config } from "../config.js";
import { CliError, EXIT } from "../output.js";
import {
  discoverAuthServer,
  OAuthError,
  refreshTokens,
  type TokenSet,
} from "./oauth.js";
import {
  clearSession,
  loadInfo,
  loadSecret,
  saveSecret,
  type SessionInfo,
} from "./store.js";
import { withLock } from "./lock.js";

export interface ResolvedAuth {
  token: string;
  /** Org slug for request paths; null for an env/flag token without an org. */
  org: string | null;
  source: "flag" | "env" | "session";
  /** The stored session's identity, when source is "session". */
  session?: SessionInfo;
}

export interface ResolveOpts {
  /** `--token` global flag. */
  token?: string;
  /** `--org` global flag. */
  org?: string;
}

/** Refresh this long before the access token expires. */
const REFRESH_SKEW_SEC = 60;

const nowSec = () => Math.floor(Date.now() / 1000);
const fresh = (t: TokenSet) => t.expiresAt - REFRESH_SKEW_SEC > nowSec();

export async function resolveAuth(
  config: Config,
  opts: ResolveOpts,
): Promise<ResolvedAuth> {
  if (opts.token) {
    return {
      token: opts.token,
      org: opts.org ?? config.envOrg ?? null,
      source: "flag",
    };
  }
  if (config.envToken) {
    return {
      token: config.envToken,
      org: opts.org ?? config.envOrg ?? null,
      source: "env",
    };
  }

  const session = loadInfo(config);
  if (!session) {
    throw new CliError(
      "not logged in — run 'legalese login' (or set LEGALESE_TOKEN)",
      EXIT.UNAUTHENTICATED,
    );
  }
  if (opts.org && opts.org !== session.org.slug) {
    throw new CliError(
      `you are signed in to '${session.org.slug}', and this session can't act for ` +
        `'${opts.org}'. Run 'legalese logout' then 'legalese login' and choose ` +
        `'${opts.org}', or use an API key for it (LEGALESE_TOKEN + --org).`,
      EXIT.FORBIDDEN,
    );
  }
  const tokens = await validTokens(config, session);
  return {
    token: tokens.accessToken,
    org: session.org.slug,
    source: "session",
    session,
  };
}

/** The session's tokens, refreshed under the lock when near expiry. */
export async function validTokens(
  config: Config,
  session: SessionInfo,
): Promise<TokenSet> {
  const current = loadSecret(config, session.store);
  if (!current) {
    throw new CliError(
      "the stored session is incomplete — run 'legalese login'",
      EXIT.UNAUTHENTICATED,
    );
  }
  if (fresh(current)) return current;

  return withLock(config.configDir, async () => {
    // Another invocation may have refreshed while we waited for the lock.
    const latest = loadSecret(config, session.store);
    if (latest && fresh(latest)) return latest;
    const refreshToken = (latest ?? current).refreshToken;
    try {
      const as = await discoverAuthServer(config);
      const next = await refreshTokens(as, session.clientId, refreshToken);
      saveSecret(config, next, session.store);
      return next;
    } catch (err) {
      if (err instanceof OAuthError && err.oauthError === "invalid_grant") {
        clearSession(config);
        throw new CliError(
          "your session has ended (expired, revoked or signed out elsewhere) — run 'legalese login'",
          EXIT.UNAUTHENTICATED,
        );
      }
      throw err;
    }
  });
}

/** Resolve the org slug or fail with a clear message (for org-scoped commands). */
export function requireOrg(auth: ResolvedAuth): string {
  if (!auth.org) {
    throw new CliError(
      "no org in context — pass --org <slug> or set LEGALESE_ORG (the API key " +
        "is org-scoped, but request paths need the slug)",
      EXIT.USAGE,
    );
  }
  return auth.org;
}
