// Auth commands: login, logout, whoami, token.
//
// Sign-in works like the VS Code extension's: you sign in to Legalese Cloud
// in the browser and pick the organization there; from then on every command
// acts as you, in that org, with your role's permissions. Underneath it is
// standard OAuth for native apps — PKCE with a 127.0.0.1 callback, or the
// device flow — so no long-lived token ever travels in a URL.

import { loadConfig, type Config } from "../config.js";
import type { GlobalOpts } from "../context.js";
import {
  CliError,
  EXIT,
  info,
  isInteractive,
  printJson,
  select,
  warn,
} from "../output.js";
import {
  browserLogin,
  canOpenBrowser,
  decodeJwtClaims,
  deviceLogin,
  discoverAuthServer,
  noAnswer,
  PROMPT_TIMEOUT_MS,
  signInCancelled,
  type TokenSet,
} from "../auth/oauth.js";
import {
  clearSession,
  loadInfo,
  saveInfo,
  saveSecret,
  type SessionInfo,
} from "../auth/store.js";
import { resolveAuth, validTokens } from "../auth/resolve.js";
import {
  describeOrg,
  describeUser,
  fetchIdentity,
  rulePermissions,
  type Identity,
} from "../auth/identity.js";

type Revocation = "revoked" | "unsupported" | "failed";

/** End a session server-side (POST /auth/logout with its access token). */
async function revokeRemote(
  config: Config,
  accessToken: string,
): Promise<Revocation> {
  try {
    const res = await fetch(`${config.authBase}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 200) {
      const body = (await res.json().catch(() => ({}))) as {
        revoked?: boolean;
      };
      return body.revoked ? "revoked" : "failed";
    }
    // An older proxy answers a token logout with its cookie-logout redirect.
    return res.status >= 300 && res.status < 400 ? "unsupported" : "failed";
  } catch {
    return "failed";
  }
}

/** The identity for fresh tokens; falls back to the token's own claims when
 *  the server has no /auth/whoami yet (then the org slug must be given). */
async function identityFor(
  config: Config,
  tokens: TokenSet,
  orgArg: string | undefined,
): Promise<Identity> {
  const identity = await fetchIdentity(config, tokens.accessToken);
  if (identity) return identity;

  const claims = decodeJwtClaims(tokens.accessToken);
  if (!orgArg) {
    throw new CliError(
      "this server can't report which org you signed in to yet — run 'legalese login <org>'",
      EXIT.USAGE,
    );
  }
  warn(
    `note: the server can't confirm your org yet; using '${orgArg}' as given.`,
  );
  return {
    user: {
      id: String(claims.sub ?? ""),
      email: typeof claims.email === "string" ? claims.email : undefined,
    },
    organization:
      typeof claims.org_id === "string"
        ? { id: claims.org_id, slug: orgArg }
        : null,
    role: typeof claims.role === "string" ? claims.role : null,
    permissions: [],
    expiresAt: typeof claims.exp === "number" ? claims.exp : null,
  };
}

/** Best-effort: end the session being replaced, then forget it. */
async function endCurrentSession(config: Config): Promise<Revocation | null> {
  const current = loadInfo(config);
  if (!current) {
    clearSession(config);
    return null;
  }
  let result: Revocation = "failed";
  try {
    const tokens = await validTokens(config, current);
    result = await revokeRemote(config, tokens.accessToken);
  } catch {
    /* already expired or revoked */
  }
  clearSession(config);
  return result;
}

function printIdentity(
  identity: Identity,
  extra: { credential: string; expiresAt?: number | null },
): void {
  info(`Signed in as ${describeUser(identity.user)}`);
  if (identity.organization)
    info(`Org:          ${describeOrg(identity.organization)}`);
  info(`Role:         ${identity.role ?? "(none)"}`);
  const permissions = rulePermissions(identity.permissions);
  info(
    `Permissions:  ${permissions.length ? permissions.join(", ") : "(none)"}`,
  );
  info(`Credential:   ${extra.credential}`);
}

function storeLabel(store: SessionInfo["store"]): string {
  if (store === "file")
    return "a file in the config directory (plaintext, mode 0600)";
  return process.platform === "darwin"
    ? "the macOS keychain"
    : "the OS keychain";
}

/**
 * How to sign in: as a flag says (--device; --browser or --no-browser);
 * otherwise with a code where no browser can open here (SSH), through the
 * browser when nobody is at a terminal to ask, and else as the user picks.
 */
async function signInMethod(opts: {
  device?: boolean;
  browser?: boolean;
}): Promise<"browser" | "code"> {
  if (opts.device) return "code";
  if (opts.browser !== undefined) return "browser";
  if (!canOpenBrowser()) return "code";
  if (!isInteractive()) return "browser";
  const choice = await select(
    "How do you want to sign in?",
    [
      ["browser", "Open browser"],
      ["code", "Verify with code"],
      ["cancel", "Cancel"],
    ],
    PROMPT_TIMEOUT_MS,
  );
  if (choice === "timeout") throw noAnswer();
  if (choice === "cancel") throw signInCancelled();
  return choice;
}

export async function loginCmd(
  org: string | undefined,
  opts: { device?: boolean; browser?: boolean },
  globals: GlobalOpts,
): Promise<void> {
  const config = loadConfig();
  const wantedOrg = org ?? globals.org;
  if (config.envToken) {
    warn(
      "note: LEGALESE_TOKEN is set and takes precedence over this session until unset.",
    );
  }

  if (opts.device && opts.browser === true) {
    throw new CliError(
      "use either --browser or --device, not both",
      EXIT.USAGE,
    );
  }

  const method = await signInMethod(opts);
  const as = await discoverAuthServer(config);
  const open = opts.browser !== false;
  let tokens: TokenSet | null = null;
  if (method === "browser") {
    tokens = await browserLogin(as, config.clientId, { open });
    if (!tokens)
      info(
        "Browser sign-in isn't set up for this client; using a sign-in code.\n",
      );
  }
  // Offer to open the sign-in page only to someone at a terminal, on a
  // screen a browser can open on; otherwise print its link.
  tokens ??= await deviceLogin(as, config.clientId, {
    prompt: open && isInteractive() && canOpenBrowser(),
  });

  const identity = await identityFor(config, tokens, wantedOrg);
  if (!identity.organization) {
    await revokeRemote(config, tokens.accessToken);
    throw new CliError(
      `signed in as ${describeUser(identity.user)}, but no Legalese Cloud organization ` +
        "was selected. Run 'legalese login' again and choose an organization.",
      EXIT.FORBIDDEN,
    );
  }
  if (wantedOrg && identity.organization.slug !== wantedOrg) {
    await revokeRemote(config, tokens.accessToken);
    throw new CliError(
      `you signed in to '${identity.organization.slug}', not '${wantedOrg}'. ` +
        `Run 'legalese login ${wantedOrg}' again and choose '${wantedOrg}' on the sign-in page.`,
      EXIT.FORBIDDEN,
    );
  }

  // One session at a time: end the one being replaced.
  await endCurrentSession(config);
  const store = saveSecret(config, tokens);
  const session: SessionInfo = {
    version: 1,
    issuer: as.issuer,
    clientId: config.clientId,
    user: identity.user,
    org: identity.organization,
    role: identity.role,
    permissions: identity.permissions,
    store,
    signedInAt: new Date().toISOString(),
  };
  saveInfo(config, session);

  if (globals.json) {
    printJson({ ...identity, store });
    return;
  }
  info("");
  printIdentity(identity, {
    credential: `session stored in ${storeLabel(store)}`,
  });
  if (store === "file") {
    warn(
      "warning: no OS keychain available — the session is stored unencrypted " +
        `in ${config.configDir}/credentials.json (mode 0600).`,
    );
  }
}

export async function logoutCmd(globals: GlobalOpts): Promise<void> {
  const config = loadConfig();
  const current = loadInfo(config);
  const result = await endCurrentSession(config);
  if (globals.json) {
    printJson({ signedOut: result !== null, server: result });
    return;
  }
  if (!current || result === null) {
    info("Not signed in.");
  } else if (result === "revoked") {
    info(
      `Signed out of ${describeOrg(current.org)}; the session is ended on the server too.`,
    );
  } else if (result === "unsupported") {
    info(
      `Signed out of ${describeOrg(current.org)} on this machine. The server can't end ` +
        "CLI sessions yet; the sign-in expires on its own.",
    );
  } else {
    info(
      `Signed out of ${describeOrg(current.org)} on this machine, but the server could ` +
        "not be told to end the session.",
    );
  }
  if (config.envToken)
    info("note: LEGALESE_TOKEN is still set in this environment.");
}

export async function whoamiCmd(globals: GlobalOpts): Promise<void> {
  const config = loadConfig();
  const auth = await resolveAuth(config, {
    token: globals.token,
    org: globals.org,
  });
  const isJwt = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(auth.token);

  if (auth.source === "session" && auth.session) {
    const live = await fetchIdentity(config, auth.token);
    const s = auth.session;
    const identity: Identity = live ?? {
      user: s.user,
      organization: s.org,
      role: s.role,
      permissions: s.permissions,
      expiresAt: null,
    };
    if (live && live.organization?.slug === s.org.slug) {
      // Keep session.json current (roles and permissions change).
      saveInfo(config, {
        ...s,
        user: live.user,
        role: live.role,
        permissions: live.permissions,
      });
    }
    const exp = decodeJwtClaims(auth.token).exp;
    const mins =
      typeof exp === "number"
        ? Math.max(0, Math.round((exp - Date.now() / 1000) / 60))
        : null;
    if (globals.json) {
      printJson({
        source: "session",
        store: s.store,
        ...identity,
        accessTokenExpiresAt: exp ?? null,
      });
      return;
    }
    printIdentity(identity, {
      credential: `session in ${storeLabel(s.store)}${mins !== null ? `; access token valid ~${mins} min, renewed automatically` : ""}`,
    });
    return;
  }

  const from = auth.source === "env" ? "LEGALESE_TOKEN" : "--token";
  const identity = isJwt ? await fetchIdentity(config, auth.token) : null;
  if (globals.json) {
    printJson({ source: auth.source, org: auth.org, ...(identity ?? {}) });
    return;
  }
  if (identity) {
    printIdentity(identity, { credential: `access token from ${from}` });
  } else {
    info(
      `Authenticated with ${isJwt ? "an access token" : "an API key"} from ${from}.`,
    );
    info(
      `Org:          ${auth.org ?? "(not set — pass --org or LEGALESE_ORG)"}`,
    );
    if (!isJwt)
      info(
        "API keys have no user; their permissions are set on the key itself.",
      );
  }
}

export async function tokenCmd(globals: GlobalOpts): Promise<void> {
  const config = loadConfig();
  const auth = await resolveAuth(config, {
    token: globals.token,
    org: globals.org,
  });
  info("warning: this is a sensitive credential — do not log or share it");
  process.stdout.write(auth.token + "\n");
}
