// Output + error helpers. Exit codes mirror the CLI spec.

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

/** Like info, but shown even with --quiet. */
export function warn(msg: string): void {
  process.stderr.write(msg + "\n");
}
