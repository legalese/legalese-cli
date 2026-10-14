// Session storage: one active session at a time; logging in replaces it.
//
// Two parts, kept apart on purpose:
//
//   secret   the token set (rotating refresh token + cached access token),
//            in the OS keychain, or {configDir}/credentials.json (0600)
//            where there is none or LEGALESE_CREDENTIAL_STORE=file.
//   info     {configDir}/session.json: who is signed in to which org, with
//            which role and permissions. Nothing secret, so other tools may
//            read it to show the signed-in identity. For a token they must
//            run `legalese token` instead: reading the secret directly would
//            race the refresh-token rotation and sign the CLI out.

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Config, CredentialStore } from "../config.js";
import type { TokenSet } from "./oauth.js";
import { platformKeychain } from "./keychain.js";
import { CliError, EXIT } from "../output.js";

export interface SessionInfo {
  version: 1;
  issuer: string;
  clientId: string;
  user: {
    id: string;
    email?: string;
    firstName?: string | null;
    lastName?: string | null;
  };
  org: { id: string; slug: string; name?: string };
  role: string | null;
  permissions: string[];
  /** Where the secret lives. */
  store: CredentialStore;
  signedInAt: string;
}

const infoPath = (dir: string) => join(dir, "session.json");
const secretPath = (dir: string) => join(dir, "credentials.json");

function writePrivate(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
  // Ensure 0600 even if the file pre-existed with looser permissions.
  chmodSync(path, 0o600);
}

export function loadInfo(config: Config): SessionInfo | null {
  try {
    const info = JSON.parse(readFileSync(infoPath(config.configDir), "utf8"));
    return info && info.version === 1 && info.org?.slug ? info : null;
  } catch {
    return null;
  }
}

export function saveInfo(config: Config, info: SessionInfo): void {
  mkdirSync(config.configDir, { recursive: true, mode: 0o700 });
  writePrivate(
    infoPath(config.configDir),
    JSON.stringify(info, null, 2) + "\n",
  );
}

function parseSecret(raw: string | null): TokenSet | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as TokenSet;
    return typeof s.refreshToken === "string" &&
      typeof s.accessToken === "string" &&
      typeof s.expiresAt === "number"
      ? s
      : null;
  } catch {
    return null;
  }
}

export function loadSecret(
  config: Config,
  store: CredentialStore,
): TokenSet | null {
  if (store === "keychain")
    return parseSecret(platformKeychain()?.get() ?? null);
  try {
    return parseSecret(readFileSync(secretPath(config.configDir), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Save the token set where `preferred` says (or the keychain when available
 * and nothing is forced). Returns the store actually used.
 */
export function saveSecret(
  config: Config,
  tokens: TokenSet,
  preferred?: CredentialStore,
): CredentialStore {
  const wanted = preferred ?? config.credentialStore;
  const value = JSON.stringify(tokens);
  if (wanted !== "file") {
    const keychain = platformKeychain();
    if (keychain?.set(value)) {
      rmSync(secretPath(config.configDir), { force: true });
      return "keychain";
    }
    if (wanted === "keychain") {
      throw new CliError(
        "could not write to the OS keychain (LEGALESE_CREDENTIAL_STORE=keychain)",
        EXIT.ERROR,
      );
    }
  }
  mkdirSync(config.configDir, { recursive: true, mode: 0o700 });
  writePrivate(secretPath(config.configDir), value + "\n");
  return "file";
}

/** Remove the session from every store. */
export function clearSession(config: Config): void {
  platformKeychain()?.delete();
  rmSync(secretPath(config.configDir), { force: true });
  rmSync(infoPath(config.configDir), { force: true });
}
