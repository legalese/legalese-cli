import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { confirm } from "../src/output.js";

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

/** Answer the prompt by typing `typed`, or by closing the input (null). */
function answer(typed: string | null, timeoutMs = 1000) {
  const input = new PassThrough();
  const result = confirm("Open it now? [Y/n] ", timeoutMs, input);
  if (typed === null) input.end();
  else if (typed) input.write(typed);
  return result;
}

describe("confirm", () => {
  it.each([
    ["\n", "yes"],
    ["y\n", "yes"],
    [" Yes \n", "yes"],
    ["n\n", "no"],
    ["NO\n", "no"],
    ["maybe\nn\n", "no"],
  ])("takes %j as %s", async (typed, expected) => {
    expect(await answer(typed)).toBe(expected);
  });

  it("takes the end of input as no", async () => {
    expect(await answer(null)).toBe("no");
  });

  it("gives up when nobody answers in time", async () => {
    expect(await answer("", 20)).toBe("timeout");
  });
});
