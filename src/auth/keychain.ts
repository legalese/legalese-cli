// OS keychain access through the platform's own tools, so the CLI needs no
// native module (and works in the bun-compiled binaries):
//
//   macOS  `security` (login keychain), commands piped to `security -i` so
//          the secret never appears in a process listing
//   Linux  `secret-tool` (libsecret / Secret Service), secret on stdin
//
// Values are stored base64-encoded. Windows has no built-in equivalent; it
// uses the file store.

import { spawnSync } from "node:child_process";

const SERVICE = "cloud.legalese.cli";
const ACCOUNT = "session";

export interface Keychain {
  get(): string | null;
  /** Returns false when the keychain refused (locked, no D-Bus, …). */
  set(value: string): boolean;
  delete(): void;
}

function run(cmd: string, args: string[], input?: string) {
  return spawnSync(cmd, args, {
    input,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

const macos: Keychain = {
  get() {
    const r = run("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      ACCOUNT,
      "-w",
    ]);
    if (r.status !== 0 || !r.stdout) return null;
    return Buffer.from(r.stdout.trim(), "base64").toString("utf8");
  },
  set(value) {
    const b64 = Buffer.from(value, "utf8").toString("base64");
    const r = run(
      "security",
      ["-i"],
      `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "Legalese CLI" -w ${b64}\n`,
    );
    return r.status === 0 && this.get() === value;
  },
  delete() {
    run("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
  },
};

const libsecret: Keychain = {
  get() {
    const r = run("secret-tool", [
      "lookup",
      "service",
      SERVICE,
      "account",
      ACCOUNT,
    ]);
    if (r.status !== 0 || !r.stdout) return null;
    return Buffer.from(r.stdout.trim(), "base64").toString("utf8");
  },
  set(value) {
    const b64 = Buffer.from(value, "utf8").toString("base64");
    const r = run(
      "secret-tool",
      ["store", "--label=Legalese CLI", "service", SERVICE, "account", ACCOUNT],
      b64,
    );
    return r.status === 0 && this.get() === value;
  },
  delete() {
    run("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT]);
  },
};

/** The platform keychain, or null where there is none. */
export function platformKeychain(): Keychain | null {
  if (process.platform === "darwin") return macos;
  if (process.platform === "linux") {
    const probe = spawnSync("secret-tool", ["--version"], { stdio: "ignore" });
    return probe.error ? null : libsecret;
  }
  return null;
}
