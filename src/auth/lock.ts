// A lock file around token refresh. WorkOS refresh tokens are single-use, so
// two invocations refreshing at once (git calling `git-credential` in
// parallel, a script running several commands) would spend the same refresh
// token twice and the loser would be signed out.

import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CliError } from "../output.js";

/** A lock older than this is from a crashed process and is taken over. */
const STALE_MS = 30_000;
const WAIT_MS = 20_000;

export async function withLock<T>(
  dir: string,
  fn: () => Promise<T>,
): Promise<T> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "refresh.lock");
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(path, "wx", 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_MS) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        continue; // released between our open and stat
      }
      if (Date.now() > deadline) {
        throw new CliError(`timed out waiting for ${path}`);
      }
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}
