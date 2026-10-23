# `legalese` CLI

Find and run your organization's deployed legal & policy rules on **Legalese
Cloud** from a terminal. You sign in once, choose your organization, and every
command then acts as you, in that org, with your role's permissions — the same
view the VS Code extension gives you. The CLI owns the credential, so a token
never has to appear on a command line.

Spec: [`legalese-cli.md`](legalese-cli.md).

## Install

```sh
curl -fsSL https://legalese.cloud/cli/install.sh | sh
```

From source (Node ≥ 22):

```sh
npm ci && npm run build
node dist/index.js --help        # or: npm link  →  legalese --help
```

## Sign in

```sh
legalese login            # asks: open browser, verify with code, or cancel
legalese login acme       # same, and check that you picked 'acme'
legalese login --browser  # browser sign-in without asking (scripts, AI agents)
legalese login --device   # sign in with a code without asking (SSH, headless)
legalese whoami           # user, org, role, permissions, credential
legalese logout           # end the session on the server and remove it here
```

`login` takes you to Legalese Cloud's sign-in page (WorkOS AuthKit), where you
sign in and choose the organization, exactly as in the VS Code extension. If
you belong to several organizations, that's where you pick one. One session at
a time: to switch organization, `legalese logout` and `legalese login` again.

At a terminal, `login` asks how to sign in; with no choice in 3 minutes it
gives up. **Open browser** opens the sign-in page and needs no code.
**Verify with code** shows a short code and the sign-in page's link, and
opens nothing: open the link yourself and confirm only if the page shows the
same code. Over SSH or without a display, `login` signs in with a code without
asking; so does `--device`. `--no-browser` prints the browser sign-in link
without opening it. When not run at a terminal (scripts, AI agents), it uses
the browser unless `--device` is given.

How it works: standard OAuth for native apps against the public WorkOS client
"Legalese CLI". Open browser uses PKCE and a callback on `127.0.0.1`
(RFC 8252), and falls back to a code when that callback isn't registered for
the client. Verify with code is the device flow (RFC 8628). Access tokens last
minutes and renew automatically; the single-use refresh token rotates on every
renewal.

The session's tokens are kept in the OS keychain (macOS Keychain, or libsecret
on Linux via `secret-tool`); without one, in `~/.config/legalese/credentials.json`
(mode 0600) with a warning. `LEGALESE_CREDENTIAL_STORE=file|keychain` forces one.

## Use

```sh
legalese list                                  # your org's deployments
legalese search "is the rent overdue"
legalese schema rent-rules rentIsOverdue       # inputs of a function
legalese eval rent-rules rentIsOverdue '{"dueDate":"2026-01-01","today":"2026-06-19"}'
echo '{"today":"2026-06-19"}' | legalese eval rent-rules rentIsOverdue -
```

`eval` takes the function's inputs (it wraps them as `{"arguments": …}`; a body
that already has `arguments` is sent as is). Add `--json` to any command for
machine-readable output.

When something is refused, the message says why from your side: for example
`forbidden — needs l4:evaluate, which your role 'viewer' in 'acme' doesn't grant`.

Exit codes: `0` ok · `1` error · `2` usage · `4` not signed in / session ended ·
`5` forbidden (permission or org) · `6` not found · `7` the rule returned an error.

## Headless / CI

No login needed with an org API key:

```sh
export LEGALESE_TOKEN=sk_…
export LEGALESE_ORG=acme     # API keys carry no slug; request paths need it
legalese eval rent-rules rentIsOverdue '{…}'
```

Order for every command: `--token` → `LEGALESE_TOKEN` → the stored session.

## Other tools

Other programs (the `l4` CLI, scripts, editors) reuse your sign-in by asking
the CLI, not by reading its storage:

```sh
legalese token            # a valid access token on stdout (renewed if needed)
legalese whoami --json    # { user, organization, role, permissions, … }
```

`~/.config/legalese/session.json` (who is signed in to which org) is not
secret and may be read directly. Don't read the tokens from the keychain or
`credentials.json`: the refresh token is single-use, so two programs renewing
it would sign each other out.

For `git clone` of gated skill repos:

```sh
git config --global credential.https://skills.legalese.cloud.helper "legalese git-credential"
```

## Configuration

| Env                         | Default                                   | Purpose                                         |
| --------------------------- | ----------------------------------------- | ----------------------------------------------- |
| `LEGALESE_TOKEN`            | —                                         | bearer credential (CI/headless)                 |
| `LEGALESE_ORG`              | —                                         | org slug for the env-token path                 |
| `LEGALESE_API_URL`          | `https://api.legalese.cloud`              | deployments, functions, evaluation              |
| `LEGALESE_SKILLS_URL`       | `https://skills.legalese.cloud`           | search, OAuth discovery                         |
| `LEGALESE_AUTH_URL`         | `https://legalese.cloud`                  | `/auth/whoami`, `/auth/logout`                  |
| `LEGALESE_AUTH_ISSUER`      | `https://beauteous-meridian-96.authkit.app` | AuthKit issuer when discovery fails           |
| `LEGALESE_CLIENT_ID`        | the "Legalese CLI" WorkOS client          | another WorkOS client (e.g. staging)            |
| `LEGALESE_CREDENTIAL_STORE` | keychain when available, else file        | force `keychain` or `file`                      |
| `LEGALESE_CONFIG_DIR`       | `~/.config/legalese`                      | session.json, credentials.json, refresh lock    |

## Development

```sh
npm ci
npm run lint && npm test && npm run build
npm run build:bin     # standalone binaries (needs bun) → dist-bin/
```

Tests run against a fake AuthKit + proxy (`test/fake-cloud.ts`) and the file
store; nothing touches the keychain or Legalese Cloud.
