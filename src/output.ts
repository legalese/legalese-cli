// Output + error helpers. Exit codes mirror the CLI spec.

import { createInterface } from "node:readline";

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  UNAUTHENTICATED: 4,
  FORBIDDEN: 5,
  NOT_FOUND: 6,
  EVAL_ERROR: 7,
} as const;

/** A controlled error that maps to a specific exit code + clean message. */
export class CliError extends Error {
  constructor(
    message: string,
    public code: number = EXIT.ERROR,
  ) {
    super(message);
    this.name = "CliError";
  }
}

let quiet = false;
export function setQuiet(value: boolean): void {
  quiet = value;
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** Human-facing messages go to stderr so stdout stays pipeable. */
export function info(msg: string): void {
  if (!quiet) process.stderr.write(msg + "\n");
}

/** Bold on a terminal; plain when stderr is piped or NO_COLOR is set. */
export function bold(s: string): string {
  return process.stderr.isTTY && !process.env.NO_COLOR
    ? `\x1b[1m${s}\x1b[22m`
    : s;
}

/** Whether someone is at a terminal to answer a prompt. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

/**
 * Ask a yes/no question on stderr; Enter means yes, anything unclear asks
 * again. Ctrl+C or end of input counts as no, and no answer within
 * timeoutMs as "timeout".
 */
export function confirm(
  question: string,
  timeoutMs: number,
  input: NodeJS.ReadableStream = process.stdin,
): Promise<"yes" | "no" | "timeout"> {
  const rl = createInterface({ input, output: process.stderr });
  return new Promise((resolve) => {
    let settled = false;
    const done = (answer: "yes" | "no" | "timeout", newline = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (newline) process.stderr.write("\n");
      rl.close();
      resolve(answer);
    };
    const timer = setTimeout(() => done("timeout", true), timeoutMs);
    rl.on("SIGINT", () => done("no", true));
    rl.on("close", () => done("no"));
    const ask = () =>
      rl.question(question, (line) => {
        const answer = line.trim().toLowerCase();
        if (answer === "" || answer === "y" || answer === "yes") done("yes");
        else if (answer === "n" || answer === "no") done("no");
        else ask();
      });
    ask();
  });
}

/** Like info, but shown even with --quiet. */
export function warn(msg: string): void {
  process.stderr.write(msg + "\n");
}
