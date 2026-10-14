// Static configuration + environment overrides. Base URLs default to prod and
// can be pointed at staging via env.

import { homedir } from "node:os";
import { join } from "node:path";

function env(key: string, fallback = ""): string {
  return process.env[key] || fallback;
}

/**
 * The CLI's WorkOS client: a public, first-party WorkOS Connect OAuth
 * application ("Legalese CLI"). Public clients have no secret — sign-in is
 * bound to this machine by PKCE (browser) or the device code — so the id is
 * safe to ship. Override with LEGALESE_CLIENT_ID (e.g. a staging app).
 */
export const DEFAULT_CLIENT_ID = "client_01M4WNG6P3025K1XEGAAC56N7T";

export type CredentialStore = "keychain" | "file";

export interface Config {
  /** Skills host — search + OAuth protected-resource metadata. */
  skillsBase: string;
  /** REST API host — deployments, functions, evaluation. */
  apiBase: string;
  /** Bare service host — /auth/whoami and /auth/logout. */
  authBase: string;
  /** AuthKit issuer, used when discovery via the skills host fails. */
  authIssuer: string;
  clientId: string;
  /** Directory for session.json (and credentials.json without a keychain). */
  configDir: string;
  /** Force a credential store; unset = OS keychain when available, else file. */
  credentialStore?: CredentialStore;
  /** Bearer credential for headless/CI use (an `sk_…` API key or a JWT). */
  envToken?: string;
  /** Org slug for the env-token path (API keys carry no slug). */
  envOrg?: string;
}

export function loadConfig(): Config {
  const configDir =
    env("LEGALESE_CONFIG_DIR") ||
    join(env("XDG_CONFIG_HOME", join(homedir(), ".config")), "legalese");
  const store = env("LEGALESE_CREDENTIAL_STORE");

  return {
    skillsBase: env("LEGALESE_SKILLS_URL", "https://skills.legalese.cloud"),
    apiBase: env("LEGALESE_API_URL", "https://api.legalese.cloud"),
    authBase: env("LEGALESE_AUTH_URL", "https://legalese.cloud"),
    authIssuer: env(
      "LEGALESE_AUTH_ISSUER",
      "https://beauteous-meridian-96.authkit.app",
    ),
    clientId: env("LEGALESE_CLIENT_ID", DEFAULT_CLIENT_ID),
    configDir,
    credentialStore:
      store === "keychain" || store === "file" ? store : undefined,
    envToken: process.env.LEGALESE_TOKEN || undefined,
    envOrg: process.env.LEGALESE_ORG || undefined,
  };
}

/** OAuth scopes requested at login. `offline_access` yields the refresh
 *  token. Permissions are not scopes: the proxy derives them from the user's
 *  role in the org chosen at sign-in. */
export const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"];
