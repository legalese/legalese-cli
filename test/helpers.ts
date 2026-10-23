import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { vi } from "vitest";
import {
  startFakeCloud,
  type FakeCloud,
  type FakeCloudOptions,
} from "./fake-cloud.js";

const ENV_KEYS = [
  "LEGALESE_CONFIG_DIR",
  "LEGALESE_CREDENTIAL_STORE",
  "LEGALESE_SKILLS_URL",
  "LEGALESE_API_URL",
  "LEGALESE_AUTH_URL",
  "LEGALESE_AUTH_ISSUER",
  "LEGALESE_CLIENT_ID",
  "LEGALESE_TOKEN",
  "LEGALESE_ORG",
  // Whether a browser can open: cleared so the developer's session can't
  // change what login does.
  "SSH_CONNECTION",
  "SSH_TTY",
  "DISPLAY",
  "WAYLAND_DISPLAY",
] as const;

export interface TestEnv {
  cloud: FakeCloud;
  dir: string;
  out: string[];
  err: string[];
  stdout(): string;
  stderr(): string;
  /** Calls that reached the stand-in `security` / `secret-tool`. */
  keychainCalls(): string[];
  done(): Promise<void>;
}

/**
 * Stand-ins for the OS keychain tools, first on PATH: they record the call
 * and fail, so no test can read, overwrite or delete the developer's real
 * sign-in.
 */
function fakeKeychainTools(dir: string): { bin: string; log: string } {
  const bin = join(dir, "bin");
  const log = join(dir, "keychain-calls.log");
  mkdirSync(bin);
  for (const tool of ["security", "secret-tool"]) {
    const file = join(bin, tool);
    writeFileSync(
      file,
      `#!/bin/sh\necho "${tool} $*" >> "${log}"\ncat > /dev/null\nexit 1\n`,
    );
    chmodSync(file, 0o755);
  }
  return { bin, log };
}

/** A fake cloud, a temp config dir with the file store, and captured output. */
export async function setup(opts: FakeCloudOptions = {}): Promise<TestEnv> {
  const cloud = await startFakeCloud(opts);
  const dir = mkdtempSync(join(tmpdir(), "legalese-cli-"));
  const keychain = fakeKeychainTools(dir);
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const savedPath = process.env.PATH;
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    PATH: `${keychain.bin}${delimiter}${savedPath ?? ""}`,
    LEGALESE_CONFIG_DIR: dir,
    LEGALESE_CREDENTIAL_STORE: "file",
    LEGALESE_SKILLS_URL: cloud.base,
    LEGALESE_API_URL: cloud.base,
    LEGALESE_AUTH_URL: cloud.base,
    LEGALESE_AUTH_ISSUER: cloud.base,
    LEGALESE_CLIENT_ID: "client_test",
  });

  const out: string[] = [];
  const err: string[] = [];
  const so = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  const se = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    err.push(String(s));
    return true;
  });

  return {
    cloud,
    dir,
    out,
    err,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    keychainCalls: () =>
      existsSync(keychain.log)
        ? readFileSync(keychain.log, "utf8").split("\n").filter(Boolean)
        : [],
    async done() {
      so.mockRestore();
      se.mockRestore();
      process.env.PATH = savedPath;
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(dir, { recursive: true, force: true });
      await cloud.close();
    },
  };
}
