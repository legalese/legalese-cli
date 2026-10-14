import { afterEach, describe, expect, it } from "vitest";
import { loginCmd } from "../src/commands/auth.js";
import {
  evalCmd,
  evaluationBody,
  listCmd,
  schemaCmd,
  searchCmd,
} from "../src/commands/rules.js";
import { gitCredentialCmd, parseAttrs } from "../src/commands/git.js";
import { CliError, EXIT } from "../src/output.js";
import { setup, type TestEnv } from "./helpers.js";
import { Readable } from "node:stream";

let env: TestEnv;
afterEach(async () => env?.done());

const signIn = () => loginCmd(undefined, { device: true, browser: false }, {});

async function expectCliError(
  p: Promise<unknown>,
  code: number,
): Promise<CliError> {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).code).toBe(code);
  return err as CliError;
}

describe("as the signed-in user, in their org", () => {
  it("lists the org's deployments", async () => {
    env = await setup();
    await signIn();
    env.out.length = 0;
    await listCmd({});
    expect(env.stdout()).toMatch(/rent-rules\s+ready\s+1 function\s+Rent/);
    expect(env.cloud.calls).toContainEqual({ method: "GET", path: "/acme" });
  });

  it("searches, shows schemas, and evaluates", async () => {
    env = await setup();
    await signIn();
    env.out.length = 0;
    await searchCmd("rent", {}, {});
    expect(env.stdout()).toContain("rent-rules");
    expect(env.stdout()).toContain("• rentIsOverdue");

    env.out.length = 0;
    await schemaCmd("rent-rules", "rentIsOverdue", {});
    expect(JSON.parse(env.stdout())).toMatchObject({ name: "rentIsOverdue" });

    env.out.length = 0;
    await evalCmd("rent-rules", "rentIsOverdue", '{"today":"2026-06-19"}', {});
    expect(JSON.parse(env.stdout()).received).toEqual({
      arguments: { today: "2026-06-19" },
    });
  });

  it("reports a rule error with exit 7", async () => {
    env = await setup();
    await signIn();
    env.out.length = 0;
    const err = await expectCliError(
      evalCmd("rent-rules", "broken", "{}", {}),
      EXIT.EVAL_ERROR,
    );
    expect(err.message).toContain("the rule returned an error");
    expect(JSON.parse(env.stdout())).toMatchObject({ tag: "SimpleError" });
  });

  it("explains a missing permission in terms of the user's role", async () => {
    env = await setup({ user: { role: "viewer", permissions: ["l4:rules"] } });
    await signIn();
    const err = await expectCliError(
      evalCmd("rent-rules", "rentIsOverdue", "{}", {}),
      EXIT.FORBIDDEN,
    );
    expect(err.message).toBe(
      "evaluate rent-rules/rentIsOverdue: forbidden — needs l4:evaluate, which your " +
        "role 'viewer' in 'acme' doesn't grant (you have: l4:rules)",
    );
  });

  it("says not found in the user's org", async () => {
    env = await setup();
    const err = await expectCliError(
      listCmd({ token: "eyJ0.eyJzdWIiOiJ1In0.c2ln", org: "globex" }),
      EXIT.NOT_FOUND,
    );
    expect(err.message).toContain("not found in 'globex'");
  });

  it("needs a sign-in", async () => {
    env = await setup();
    await expectCliError(listCmd({}), EXIT.UNAUTHENTICATED);
  });
});

describe("evaluationBody", () => {
  it("wraps plain inputs in `arguments` and keeps a full body", () => {
    expect(evaluationBody({ a: 1 })).toEqual({ arguments: { a: 1 } });
    expect(evaluationBody({ arguments: { a: 1 }, evalBackend: "x" })).toEqual({
      arguments: { a: 1 },
      evalBackend: "x",
    });
    expect(evaluationBody({})).toEqual({ arguments: {} });
  });
});

describe("git-credential", () => {
  function withStdin(text: string, fn: () => Promise<void>) {
    const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", {
      value: Readable.from([text]),
      configurable: true,
    });
    return fn().finally(() =>
      Object.defineProperty(process, "stdin", original),
    );
  }

  it("parses git's attributes", () => {
    expect(
      parseAttrs(
        "protocol=https\nhost=skills.legalese.cloud\npath=acme/x.git\n",
      ),
    ).toEqual({
      protocol: "https",
      host: "skills.legalese.cloud",
      path: "acme/x.git",
    });
  });

  it("answers for the session's org and stays silent for another", async () => {
    env = await setup();
    await signIn();
    env.out.length = 0;
    await withStdin(
      "protocol=https\nhost=skills.legalese.cloud\npath=acme/rent.git\n\n",
      () => gitCredentialCmd("get", {}),
    );
    expect(env.stdout()).toMatch(/^username=x\npassword=eyJ/);

    env.out.length = 0;
    await withStdin(
      "protocol=https\nhost=skills.legalese.cloud\npath=globex/x.git\n\n",
      () => gitCredentialCmd("get", {}),
    );
    expect(env.stdout()).toBe("");
  });
});
