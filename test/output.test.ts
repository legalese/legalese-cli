import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { select } from "../src/output.js";

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe("select", () => {
  const choices = [
    ["browser", "Open browser"],
    ["code", "Verify with code"],
    ["cancel", "Cancel"],
  ] as const;

  /** Pick by pressing `keys`, or by closing the input (null). */
  function pick(keys: string | null, timeoutMs = 1000) {
    const input = new PassThrough();
    const result = select("How?", choices, timeoutMs, input);
    if (keys === null) input.end();
    else if (keys) input.write(keys);
    return result;
  }

  it.each([
    ["Enter", "\r", "browser"],
    ["Down, Enter", "\x1b[B\r", "code"],
    ["Up from the top, Enter", "\x1b[A\r", "cancel"],
    ["j, j, k, Enter", "jjk\r", "code"],
    ["2", "2", "code"],
    ["Ctrl+C", "\x03", "cancel"],
  ])("takes %s as %s", async (_, keys, expected) => {
    expect(await pick(keys)).toBe(expected);
  });

  it("takes the end of input as cancel", async () => {
    expect(await pick(null)).toBe("cancel");
  });

  it("gives up when nothing is chosen in time", async () => {
    expect(await pick("", 20)).toBe("timeout");
  });

  it("leaves the question and the answer on screen", async () => {
    await pick("\x1b[B\r");
    const written = vi
      .mocked(process.stderr.write)
      .mock.calls.map((c) => String(c[0]))
      .join("");
    expect(written).toMatch(/\x1b\[0JHow\? Verify with code\n/);
  });
});
