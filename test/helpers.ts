import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
] as const;

export interface TestEnv {
  cloud: FakeCloud;
  dir: string;
  out: string[];
  err: string[];
  stdout(): string;
  stderr(): string;
  done(): Promise<void>;
}

/** A fake cloud, a temp config dir with the file store, and captured output. */
export async function setup(opts: FakeCloudOptions = {}): Promise<TestEnv> {
  const cloud = await startFakeCloud(opts);
  const dir = mkdtempSync(join(tmpdir(), "legalese-cli-"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
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
    async done() {
      so.mockRestore();
      se.mockRestore();
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(dir, { recursive: true, force: true });
      await cloud.close();
    },
  };
}
