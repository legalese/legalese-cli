// WorkOS AuthKit OAuth for the CLI: endpoint discovery, browser sign-in
// (authorization code + PKCE through a 127.0.0.1 callback), the device flow,
// and token refresh.
//
// The proxy verifies the resulting JWTs (AuthKit JWKS); the CLI only obtains
// and refreshes them. Endpoints are discovered, never hardcoded.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "../config.js";
import { OAUTH_SCOPES } from "../config.js";
import { CliError, EXIT, info } from "../output.js";

export interface AuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint?: string;
}

/** What the CLI keeps secret: the rotating refresh token and the cached
 *  short-lived access token. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds when the access token expires. */
  expiresAt: number;
}

/** An error response from the token endpoint, with its OAuth error code. */
export class OAuthError extends CliError {
  constructor(
    public oauthError: string,
    description?: string,
  ) {
    super(
      `sign-in failed: ${oauthError}${description ? ` — ${description}` : ""}`,
      EXIT.UNAUTHENTICATED,
    );
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);
const b64url = (b: Buffer) => b.toString("base64url");

/** Fixed callback port tried when the WorkOS app only accepts an exact
 *  redirect URI (`http://127.0.0.1:53682/callback`). */
export const FIXED_CALLBACK_PORT = 53682;

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok)
    throw new CliError(`discovery failed: GET ${url} → ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** RFC 9728 → RFC 8414 discovery: resource metadata → authorization server. */
export async function discoverAuthServer(config: Config): Promise<AuthServer> {
  let issuer = config.authIssuer;
  try {
    const prm = await fetchJson(
      `${config.skillsBase}/.well-known/oauth-protected-resource`,
    );
    const servers = prm.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === "string") {
      issuer = servers[0];
    }
  } catch {
    /* fall back to the configured issuer */
  }
  const asm = await fetchJson(
    `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
  );
  const authorizationEndpoint = asm.authorization_endpoint as string;
  const tokenEndpoint = asm.token_endpoint as string;
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new CliError("authorization server metadata is missing endpoints");
  }
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    deviceAuthorizationEndpoint: asm.device_authorization_endpoint as
      | string
      | undefined,
  };
}

/** Read a JWT's claims without verifying it (the proxy verifies). */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* headless — the URL is printed for the user to open manually */
    });
    child.unref();
  } catch {
    /* headless — the URL is printed for the user to open manually */
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Build a TokenSet; the expiry comes from the JWT itself when present. */
export function tokenSetFrom(
  tok: TokenResponse,
  previousRefresh?: string,
): TokenSet {
  if (!tok.access_token)
    throw new CliError("token response had no access token");
  const exp = decodeJwtClaims(tok.access_token).exp;
  const refreshToken = tok.refresh_token ?? previousRefresh;
  if (!refreshToken) {
    throw new CliError(
      "the authorization server returned no refresh token (offline_access)",
    );
  }
  return {
    accessToken: tok.access_token,
    refreshToken,
    expiresAt:
      typeof exp === "number" ? exp : nowSec() + (tok.expires_in ?? 300),
  };
}

async function postForm(
  url: string,
  params: Record<string, string>,
): Promise<{ status: number; body: TokenResponse }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  return { status: res.status, body };
}

async function tokenRequest(
  as: AuthServer,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const { status, body } = await postForm(as.tokenEndpoint, params);
  if (status >= 400 || body.error) {
    throw new OAuthError(
      body.error ?? `HTTP ${status}`,
      body.error_description,
    );
  }
  return body;
}

interface Pkce {
  verifier: string;
  challenge: string;
}

function newPkce(): Pkce {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function authorizeUrl(
  as: AuthServer,
  clientId: string,
  redirectUri: string,
  state: string,
  pkce: Pkce,
): URL {
  const url = new URL(as.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

/**
 * Whether AuthKit accepts this redirect URI for the client. AuthKit answers
 * an unregistered redirect with a redirect to its error page, so asking
 * without following redirects tells us before the browser opens.
 */
export async function redirectAccepted(authUrl: URL): Promise<boolean> {
  try {
    const res = await fetch(authUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const location = res.headers.get("location") ?? "";
    return (
      !/[?&]error=invalid_redirect_uri\b/.test(location) && res.status < 400
    );
  } catch {
    return false;
  }
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const CALLBACK_PAGE = (ok: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Legalese CLI</title></head>` +
  `<body style="font-family:system-ui;padding:2rem;max-width:32rem">` +
  `<h2>${ok ? "Signed in" : "Sign-in failed"}</h2>` +
  `<p>You can close this tab and return to the terminal.</p></body></html>`;

/** How long the browser flow waits for the callback. */
const BROWSER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Browser sign-in: authorization code + PKCE through a callback on
 * 127.0.0.1. Tries an OS-assigned port first (RFC 8252), then the fixed
 * port. Returns null when the client has no matching loopback redirect
 * registered, so the caller can fall back to the device flow.
 */
export async function browserLogin(
  as: AuthServer,
  clientId: string,
  opts: { open: boolean },
): Promise<TokenSet | null> {
  for (const port of [0, FIXED_CALLBACK_PORT]) {
    let server: Server;
    try {
      server = await listen(port);
    } catch {
      continue; // fixed port busy
    }
    const { port: bound } = server.address() as AddressInfo;
    const redirectUri = `http://127.0.0.1:${bound}/callback`;
    const state = b64url(randomBytes(16));
    const pkce = newPkce();
    const url = authorizeUrl(as, clientId, redirectUri, state, pkce);

    if (!(await redirectAccepted(url))) {
      server.close();
      continue;
    }

    const code = await waitForCode(server, state, url, opts.open);
    const tok = await tokenRequest(as, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    return tokenSetFrom(tok);
  }
  return null;
}

function waitForCode(
  server: Server,
  state: string,
  url: URL,
  open: boolean,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new CliError("timed out waiting for the browser sign-in"));
    }, BROWSER_TIMEOUT_MS);

    server.on("request", (req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || reqUrl.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      // Only the request carrying our state counts: anything else (a stray
      // or forged callback) is refused and we keep waiting.
      if (reqUrl.searchParams.get("state") !== state) {
        res
          .writeHead(400, { "Content-Type": "text/plain" })
          .end("state mismatch");
        return;
      }
      const err = reqUrl.searchParams.get("error");
      const code = reqUrl.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(CALLBACK_PAGE(!err && !!code));
      clearTimeout(timer);
      server.close();
      if (err) {
        const desc = reqUrl.searchParams.get("error_description");
        reject(new OAuthError(err, desc ?? undefined));
      } else if (!code) {
        reject(new CliError("no authorization code returned"));
      } else {
        resolve(code);
      }
    });

    info(
      `Opening your browser to sign in to Legalese Cloud…\n` +
        `If it doesn't open, visit:\n  ${url}\n`,
    );
    if (open) openBrowser(url.toString());
  });
}

/** Device-authorization flow (RFC 8628): for SSH sessions and machines
 *  without a browser, and when browser sign-in isn't available. */
export async function deviceLogin(
  as: AuthServer,
  clientId: string,
  opts: { open: boolean },
): Promise<TokenSet> {
  if (!as.deviceAuthorizationEndpoint) {
    throw new CliError(
      "the authorization server does not advertise the device flow",
    );
  }
  const res = await fetch(as.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      scope: OAUTH_SCOPES.join(" "),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const da = (await res.json().catch(() => ({}))) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !da.device_code || !da.user_code || !da.verification_uri) {
    throw new OAuthError(
      da.error ?? `HTTP ${res.status}`,
      da.error_description,
    );
  }

  const link = da.verification_uri_complete ?? da.verification_uri;
  info(
    `To sign in, open:\n  ${link}\n` +
      `and check that it shows the code:  ${da.user_code}\n`,
  );
  if (opts.open) openBrowser(link);

  let intervalMs = (da.interval ?? 5) * 1000;
  const deadline = nowSec() + (da.expires_in ?? 300);
  while (nowSec() < deadline) {
    await sleep(intervalMs);
    const { status, body } = await postForm(as.tokenEndpoint, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: da.device_code,
      client_id: clientId,
    });
    if (status < 400 && body.access_token) return tokenSetFrom(body);
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (body.error === "access_denied") {
      throw new CliError(
        "sign-in was declined in the browser",
        EXIT.UNAUTHENTICATED,
      );
    }
    if (body.error === "expired_token") break;
    throw new OAuthError(
      body.error ?? `HTTP ${status}`,
      body.error_description,
    );
  }
  throw new CliError(
    "the sign-in code expired — run 'legalese login' again",
    EXIT.UNAUTHENTICATED,
  );
}

/** Exchange the refresh token. WorkOS rotates it: the caller must persist
 *  the returned set and never reuse the old refresh token. */
export async function refreshTokens(
  as: AuthServer,
  clientId: string,
  refreshToken: string,
): Promise<TokenSet> {
  const tok = await tokenRequest(as, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  return tokenSetFrom(tok, refreshToken);
}
