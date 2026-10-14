import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  loginCmd,
  logoutCmd,
  tokenCmd,
  whoamiCmd,
} from "../src/commands/auth.js";
import { resolveAuth, validTokens } from "../src/auth/resolve.js";
import { loadConfig } from "../src/config.js";
import { loadInfo, loadSecret, saveSecret } from "../src/auth/store.js";
import { CliError, EXIT } from "../src/output.js";
import { approveBrowserSignIn, fakeJwt } from "./fake-cloud.js";
import { setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(async () => env?.done());

const device = { device: true, browser: false };
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

async function expectCliError(
  p: Promise<unknown>,
  code: number,
): Promise<CliError> {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).code).toBe(code);
  return err as CliError;
}

describe("login", () => {
  it("signs in with a device code and stores the session for the chosen org", async () => {
    env = await setup();
    await loginCmd(undefined, device, {});

    const info = readJson(join(env.dir, "session.json"));
    expect(info.org).toEqual({ id: "org_1", slug: "acme", name: "Acme" });
    expect(info.user.email).toBe("ada@example.com");
    expect(info.role).toBe("member");
    expect(info.permissions).toEqual(["l4:rules", "l4:evaluate"]);
    expect(info.store).toBe("file");
    // session.json is not secret; the tokens live elsewhere.
    expect(JSON.stringify(info)).not.toContain("refresh_");

    const cred = join(env.dir, "credentials.json");
    expect(statSync(cred).mode & 0o777).toBe(0o600);
    expect(readJson(cred).refreshToken).toBe("refresh_1");
    expect(env.stderr()).toContain(
      "Signed in as Ada Lovelace <ada@example.com>",
    );
    expect(env.stderr()).toContain("Org:          Acme (acme)");
  });

  it("falls back to a device code when no browser callback is registered", async () => {
    env = await setup({ loopbackRedirects: false });
    await loginCmd(undefined, { browser: false }, {});
    expect(
      env.cloud.calls.some((c) => c.path === "/oauth2/device_authorization"),
    ).toBe(true);
    expect(env.stderr()).toContain("using a sign-in code");
  });

  it("signs in through the browser with PKCE and ignores forged callbacks", async () => {
    env = await setup({ loopbackRedirects: true });
    const login = loginCmd(undefined, { browser: false }, {});

    while (!env.cloud.lastAuthorize) await new Promise((r) => setTimeout(r, 5));
    const a = env.cloud.lastAuthorize;
    const redirect = a.searchParams.get("redirect_uri")!;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(a.searchParams.get("code_challenge_method")).toBe("S256");

    // A callback without our state is refused, and the CLI keeps waiting.
    const forged = await fetch(`${redirect}?code=attacker&state=wrong`);
    expect(forged.status).toBe(400);

    const code = approveBrowserSignIn(env.cloud);
    const ok = await fetch(
      `${redirect}?code=${code}&state=${a.searchParams.get("state")}`,
    );
    expect(ok.status).toBe(200);
    await login;

    expect(loadInfo(loadConfig())?.org.slug).toBe("acme");
  });

  it("refuses a different org than asked for, and ends that sign-in", async () => {
    env = await setup();
    const err = await expectCliError(
      loginCmd("globex", device, {}),
      EXIT.FORBIDDEN,
    );
    expect(err.message).toContain("you signed in to 'acme', not 'globex'");
    expect(env.cloud.revoked).toEqual(["session_1"]);
    expect(existsSync(join(env.dir, "session.json"))).toBe(false);
  });

  it("refuses a sign-in without an organization", async () => {
    env = await setup({ user: { orgId: null, orgSlug: null } });
    const err = await expectCliError(
      loginCmd(undefined, device, {}),
      EXIT.FORBIDDEN,
    );
    expect(err.message).toContain(
      "no Legalese Cloud organization was selected",
    );
    expect(env.cloud.revoked).toHaveLength(1);
  });

  it("needs the org argument when the server has no /auth/whoami", async () => {
    env = await setup({ whoami: false });
    await expectCliError(loginCmd(undefined, device, {}), EXIT.USAGE);
    await loginCmd("acme", device, {});
    expect(loadInfo(loadConfig())?.org.slug).toBe("acme");
  });

  it("ends the previous session when signing in again", async () => {
    env = await setup();
    await loginCmd(undefined, device, {});
    await loginCmd(undefined, device, {});
    expect(env.cloud.revoked).toContain("session_1");
  });
});

describe("logout", () => {
  it("ends the session on the server and removes it here", async () => {
    env = await setup();
    await loginCmd(undefined, device, {});
    await logoutCmd({});
    expect(env.cloud.revoked).toEqual(["session_1"]);
    expect(existsSync(join(env.dir, "session.json"))).toBe(false);
    expect(existsSync(join(env.dir, "credentials.json"))).toBe(false);
    expect(env.stderr()).toContain("the session is ended on the server too");
  });

  it("leaves the OS keychain alone with the file store", async () => {
    // The keychain item is shared by every config directory: signing in and
    // out of a file-store session (as every test does) must not delete the
    // developer's real sign-in.
    env = await setup();
    await loginCmd(undefined, device, {});
    await loginCmd(undefined, device, {});
    await logoutCmd({});
    expect(env.keychainCalls().filter((c) => !c.endsWith("--version"))).toEqual(
      [],
    );
  });

  it("says so when the server can't end CLI sessions", async () => {
    env = await setup();
    await loginCmd(undefined, device, {});
    // An older proxy redirects a token logout like a cookie logout.
    const config = loadConfig();
    const info = loadInfo(config)!;
    saveSecret(
      config,
      {
        ...loadSecret(config, "file")!,
        accessToken: fakeJwt({ sub: "u", exp: 4e9 }),
      },
      info.store,
    );
    await logoutCmd({});
    expect(env.stderr()).toContain("The server can't end CLI sessions yet");
  });

  it("is a no-op when not signed in", async () => {
    env = await setup();
    await logoutCmd({});
    expect(env.stderr()).toContain("Not signed in.");
  });
});

describe("whoami and token", () => {
  it("shows the live identity and keeps session.json current", async () => {
    env = await setup();
    await loginCmd(undefined, device, {});
    env.cloud.user.role = "admin";
    env.cloud.user.permissions = [
      "widgets:sso:manage",
      "l4:rules",
      "l4:evaluate",
      "l4:deploy",
      "ai:chat",
    ];
    await whoamiCmd({});
    expect(env.stderr()).toContain("Role:         admin");
    // Only the l4: permissions are shown; session.json keeps them all.
    expect(env.stderr()).toContain(
      "Permissions:  l4:rules, l4:evaluate, l4:deploy\n",
    );
    expect(loadInfo(loadConfig())?.permissions).toContain("ai:chat");
  });

  it("prints JSON for other tools", async () => {
    env = await setup();
    await loginCmd(undefined, device, {});
    env.out.length = 0;
    await whoamiCmd({ json: true });
    const body = JSON.parse(env.stdout());
    expect(body).toMatchObject({
      source: "session",
      store: "file",
      organization: { slug: "acme" },
      role: "member",
    });
    expect(env.stdout()).not.toContain("refresh_");
  });

  it("fails with exit 4 when not signed in", async () => {
    env = await setup();
    await expectCliError(whoamiCmd({}), EXIT.UNAUTHENTICATED);
  });

  it("prints a valid access token", async () => {
    env = await setup();
    await loginCmd(undefined, device, {});
    env.out.length = 0;
    await tokenCmd({});
    expect(env.stdout().trim()).toBe(
      loadSecret(loadConfig(), "file")!.accessToken,
    );
  });
});

describe("resolveAuth", () => {
  it("prefers --token, then LEGALESE_TOKEN, then the session", async () => {
    env = await setup();
    await loginCmd(undefined, device, {});
    const config = loadConfig();
    expect(
      (await resolveAuth(config, { token: "sk_flag", org: "x" })).source,
    ).toBe("flag");
    process.env.LEGALESE_TOKEN = "sk_env";
    expect((await resolveAuth(loadConfig(), {})).source).toBe("env");
    delete process.env.LEGALESE_TOKEN;
    const s = await resolveAuth(loadConfig(), {});
    expect(s).toMatchObject({ source: "session", org: "acme" });
  });

  it("won't use a session for another org", async () => {
    env = await setup();
    await loginCmd(undefined, device, {});
    const err = await expectCliError(
      resolveAuth(loadConfig(), { org: "globex" }),
      EXIT.FORBIDDEN,
    );
    expect(err.message).toContain("signed in to 'acme'");
  });

  it("renews an expiring access token and stores the rotated refresh token", async () => {
    env = await setup({ ttl: 30 }); // inside the 60 s renewal window
    await loginCmd(undefined, device, {});
    const config = loadConfig();
    await resolveAuth(config, {});
    expect(env.cloud.refreshCount).toBe(1);
    expect(env.cloud.spent.has("refresh_1")).toBe(true);
    expect(loadSecret(config, "file")!.refreshToken).toBe("refresh_2");
  });

  it("renews once when several invocations need it at the same time", async () => {
    env = await setup({ ttl: 30, refreshTtl: 300 });
    await loginCmd(undefined, device, {});
    const config = loadConfig();
    const info = loadInfo(config)!;
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => validTokens(config, info)),
    );
    // One renewal, shared: the others waited for the lock and reused it.
    expect(env.cloud.refreshCount).toBe(1);
    expect(new Set(results.map((t) => t.refreshToken))).toEqual(
      new Set(["refresh_2"]),
    );
  });

  it("signs out locally when the server has ended the session", async () => {
    env = await setup({ ttl: 30 });
    await loginCmd(undefined, device, {});
    env.cloud.spent.add("refresh_1"); // revoked elsewhere
    const err = await expectCliError(
      resolveAuth(loadConfig(), {}),
      EXIT.UNAUTHENTICATED,
    );
    expect(err.message).toContain("your session has ended");
    expect(existsSync(join(env.dir, "session.json"))).toBe(false);
  });
});
