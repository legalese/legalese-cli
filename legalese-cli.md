# `legalese` CLI — Specification

The `legalese` CLI is the **shell / CI client** for Legalese Cloud rules — discover and run an org's deployed rules from a terminal, with the CLI brokering auth so the token never appears in a command line, env echo, or transcript.

It is one of **two clients** over the same authenticated endpoints. The **primary** path for AI agents is the **discovery MCP** bundled in the gateway plugin's `.mcp.json` — `search_rules` finds the matching deployments, each with its per-deployment MCP endpoint, with the org resolved from auth. The CLI is the equivalent where MCP isn't available.

> Status (v0.2.0): `login` / `logout` / `whoami` / `token` work against the public WorkOS Connect client "Legalese CLI"; every command runs as the signed-in user in the org chosen at sign-in. Legalese Cloud is the resource server that validates everything it does.

---

## 1. Role in the system

Two clients reach the same authenticated read-model + eval endpoints:

- **Discovery MCP** (primary; any MCP harness) — bundled in the gateway plugin at the bare `mcp.legalese.cloud` (org from auth). `search_rules` returns the matching deployments + each one's per-deployment MCP endpoint; the agent connects there to run the rule. Bounded to ~2 generic tools; evaluation stays on the per-deployment MCP.
- **`legalese` CLI** (this spec — shells / CI):

```
legalese search "<topic>"   ─▶  skills.legalese.cloud/{org}/search   (gated; same backend as search_rules)
legalese eval <dep> <fn> …  ─▶  api.legalese.cloud/{org}/{dep}/fn/{fn}/evaluation (gated)
legalese git-credential     ─▶  git clone of any gated repo
        auth ── one session from `legalese login` (or LEGALESE_TOKEN for CI)
```

- **Discovery** is progressive: `search` returns only the matching deployment(s) + function(s) + schema, bounded regardless of how many deployments the org has.
- **Execution** in the CLI is authenticated REST (`eval`); in MCP harnesses it's the per-deployment MCP's typed tools.
- **Auth** is a single OAuth session (short-lived JWT + auto-refresh) or an API key for headless use.

## 2. Distribution & runtime

- **Language/runtime:** TypeScript on Node ≥ 22.
- **Binary:** `legalese`, a single self-contained executable per platform (`bun build --compile`) for macOS and Linux (arm64, x64).
- **Install:** `curl -fsSL https://legalese.cloud/cli/install.sh | sh` downloads the platform binary and checks it against `SHA256SUMS`. Run it again to upgrade.
- **No runtime deps on the host beyond the binary.**

## 3. Command surface

All commands accept global flags: `--org <slug>`, `--json`, `--token <value>`, `--api <url>` (override base, for staging), `-q/--quiet`, `-v/--verbose`, `--version`, `--help`.

### Auth

| Command | Purpose |
|---|---|
| `legalese login [<org>] [--device] [--no-browser]` | Sign in on Legalese Cloud's AuthKit page and **choose the organization there**, as in the VS Code extension (users in several orgs pick one; one org is selected automatically). The optional `<org>` is checked after sign-in: a different org is refused and that sign-in ended. Default flow: PKCE + a `127.0.0.1` callback; falls back to the device flow when the client has no loopback redirect registered, or with `--device`. Prints user, org, role and permissions (from `GET /auth/whoami`). **One** active session at a time — logging in ends the previous one. |
| `legalese logout` | End the session server-side (`POST /auth/logout` with the access token revokes its WorkOS session) and delete it locally. |
| `legalese whoami [--json]` | Show user, org, role, permissions (live from `/auth/whoami`), token expiry and credential source. Refreshes `session.json`. Exit 4 if unauthenticated. The `--json` form is the contract for other tools. |
| `legalese token` | Print a valid access token to stdout (refreshing if needed). For piping into other tools; prints a stderr warning that the token is sensitive. |

To change org, `logout` then `login` and pick the other org. There is no `switch`/`orgs` — one session, one org. A session can't be used with `--org` for another org (exit 5); use an API key for that.

### Discovery & execution

| Command | Purpose |
|---|---|
| `legalese search <query> [--limit N] [--json]` | Authenticated discovery. Matches against deployment name + description **and** function names + `@desc` (see §7). Returns the top deployments with their matching function(s) and a schema pointer. This is what the discovery skill calls. |
| `legalese schema <deployment> [<function>] [--json]` | Fetch the JSON schema for a deployment (or one function) — inputs, types, `@desc`. |
| `legalese eval <deployment> <function> [<json-inputs>] [--json]` | Run a function. Inputs from the positional arg or stdin (`-`). Prints the decision/result; `--json` for the raw evaluation response. |
| `legalese list [--json]` | List the org's deployments (gated; the authenticated catalog). |

### Git integration

| Command | Purpose |
|---|---|
| `legalese git-credential <get\|store\|erase>` | Implements the git credential-helper protocol so `git clone` of gated `skills.legalese.cloud` repos uses the CLI session. See §6. |

## 4. Auth-resolution order

Every authenticated command resolves a bearer credential in this order, then attaches it as `Authorization: Bearer <token>`:

1. **`--token <value>`** flag → use verbatim (escape hatch; never stored).
2. **`LEGALESE_TOKEN` env** → use verbatim. This is the **CI / headless** path; the value is an `sk_…` API key (long-lived) or a JWT. No login required.
3. **Stored session** for the resolved org → if the access token is expired, refresh it via the stored refresh token; persist the rotated tokens.
4. **None** → error: `not logged in — run 'legalese login'` (exit 4).

Org resolution: when logged in, the **session's org** is used (set at `login`). With `LEGALESE_TOKEN` and no session, specify the org via `--org` or `LEGALESE_ORG` (the API key is org-scoped, but the request path still needs the slug). To change org, `logout` then `login <org>`.

These are the credentials Legalese Cloud accepts: an `sk_` API key, an AuthKit JWT, or a sealed session. The CLI just produces one of those.

## 5. Token store

Two parts, kept apart:

- **Secret** — `{ accessToken, refreshToken, expiresAt }`. In the OS keychain through the platform's own tools (no native module, so it works in the bun binaries): macOS `security` (commands piped to `security -i`, so the secret never appears in a process listing), Linux libsecret `secret-tool` (secret on stdin). Service `cloud.legalese.cli`, account `session`, value base64. Without a keychain (Windows, containers): `~/.config/legalese/credentials.json`, mode `0600`, with a warning. `LEGALESE_CREDENTIAL_STORE=keychain|file` forces one.
- **Info** — `~/.config/legalese/session.json` (0600): `{ version, issuer, clientId, user, org: { id, slug, name }, role, permissions, store, signedInAt }`. Not secret; other tools may read it.
- Access tokens are renewed when within 60 s of expiry, under a lock file (`refresh.lock`): WorkOS refresh tokens are single-use, so two invocations renewing at once would spend the same one and the loser would be signed out. The rotated refresh token is always persisted. `invalid_grant` on renewal clears the session (exit 4).
- Other tools reuse the sign-in through `legalese token` and `legalese whoami --json` — never by reading the secret, which would race the rotation.

## 6. Git credential helper

So installs of any gated repo (`skills.legalese.cloud/...`) reuse the session instead of a pasted key:

```sh
git config --global credential.https://skills.legalese.cloud.helper "legalese git-credential"
```

Protocol: git invokes `legalese git-credential get` and writes `protocol`/`host`/`path` on stdin; the CLI resolves the org from the path (`/{org}/...`), gets a valid access token (auth-resolution order, refreshing as needed), and writes:

```
username=x
password=<access-token>
```

`store` is a no-op (the CLI owns the store); `erase` clears the cached access token for that host. This makes one `legalese login` cover discovery, evaluation, **and** install.

## 7. Endpoints consumed (all on Legalese Cloud)

| CLI command | Request |
|---|---|
| `search` | `GET https://skills.legalese.cloud/{org}/search?q=<query>` — matches function names + `@desc` too, and returns the matched functions |
| `schema` | `GET https://api.legalese.cloud/{org}/{dep}/fn[/{fn}]` (the extension's function routes) |
| `eval` | `POST https://api.legalese.cloud/{org}/{dep}/fn/{fn}/evaluation` with `{ "arguments": <inputs> }` (422 = the rule returned an error → exit 7) |
| `list` | `GET https://api.legalese.cloud/{org}?functions=full` (what the extension's Deployments tab lists) |
| `login`, `whoami` | `GET https://legalese.cloud/auth/whoami` — user, org, role, permissions of an AuthKit token |
| `logout` | `POST https://legalese.cloud/auth/logout` with the access token — revokes its WorkOS session |
| OAuth discovery | `GET https://skills.legalese.cloud/.well-known/oauth-protected-resource` → AuthKit metadata |
| `git-credential` | n/a (returns a token for `git`'s own request) |

Search indexes each deployment's function names and descriptions and returns the matched function(s) per result; the discovery MCP's `search_rules` uses the same index. Search is authenticated, so these keywords never appear in a public manifest.

## 8. OAuth / WorkOS client setup

- **Authorization server:** WorkOS AuthKit (`beauteous-meridian-96.authkit.app`, discovered from `skills.legalese.cloud/.well-known/oauth-protected-resource`). It offers authorization-code + PKCE (S256), the device flow, refresh tokens with rotation, and public clients (`token_endpoint_auth_method: none`). It has no revocation endpoint, hence Legalese Cloud's token logout.
- **Client:** the WorkOS Connect OAuth application **"Legalese CLI"** — first-party, **public** (no secret, PKCE required). `client_id` `client_01M4WNG6P3025K1XEGAAC56N7T` is shipped in the CLI (`LEGALESE_CLIENT_ID` overrides).
  - **Browser flow:** `http://127.0.0.1:<port>/callback`, OS-assigned port first (RFC 8252), then the fixed `53682`. The CLI checks with AuthKit (without following redirects) whether the redirect is accepted before opening the browser, and falls back to the device flow when it isn't. Requires a loopback redirect URI registered on the client in the WorkOS dashboard.
  - **Device flow** (`--device`, or the fallback): `device_authorization_endpoint` → show the `user_code` first, then ask `[Y/n]` before opening `verification_uri_complete` (the page takes focus, so the user must have seen the terminal's code to compare it with the page's); no answer before `expires_in` → exit. Not at a terminal, over SSH (`SSH_CONNECTION`/`SSH_TTY`), on Linux without `DISPLAY`/`WAYLAND_DISPLAY`, or with `--no-browser`: print the link instead of asking → poll `token_endpoint` (`authorization_pending`, `slow_down` +5 s, `access_denied`, `expired_token`).
- **Scopes:** `openid profile email offline_access` (`offline_access` yields the refresh token). Permissions are not scopes: Legalese Cloud maps the token's `role` claim (WorkOS JWT template) to permissions, as for MCP clients.
- **Org:** chosen on the AuthKit page; the access token carries it as `org_id`. The CLI learns slug, name, role and permissions from `GET /auth/whoami`.
- **Token verification** is Legalese Cloud's job; the CLI only obtains, renews and revokes.

## 9. Output, exit codes, errors

- Human output by default; `--json` emits machine-readable objects (one JSON value to stdout). `--quiet` suppresses non-essential stderr.
- **Exit codes:** `0` ok · `1` generic error · `2` usage error · `4` unauthenticated (run `login`) · `5` forbidden (token lacks permission/org) · `6` not found (deployment/function) · `7` evaluation error (rule returned an error/contradiction).
- Errors print a one-line message to stderr; `--verbose` adds request id / underlying HTTP status. Never print tokens in errors or logs.

## 10. Gateway plugin integration

The gateway plugin bundles the **discovery MCP** (`.mcp.json` → bare `mcp.legalese.cloud`, org from auth) plus a priming `SKILL.md`. So in an MCP harness the agent gets `search_rules` (and the per-deployment MCP it points at) with **no CLI install**.

The CLI is the **shell / CI alternative** the same skill mentions in one line — `legalese search …` then `legalese eval …`. Installing the CLI is only needed for that path; the agent never handles the credential (the CLI reads it from the keychain/env).

## 11. Headless / CI

- `LEGALESE_TOKEN=sk_…` (org API key) → all commands work with no `login`, no browser, no keychain. This is the recommended CI path.
- Or `legalese login --device` in an interactive bootstrap, then the refresh token persists for the runner.
- `legalese token` lets non-Legalese tooling borrow a short-lived access token if needed.
