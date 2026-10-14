// Global CLI options + small shared utilities.

export interface GlobalOpts {
  org?: string;
  token?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

/** Read all of stdin to a string (used for `eval -` and git-credential). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer),
    );
  }
  return Buffer.concat(chunks).toString("utf8");
}
