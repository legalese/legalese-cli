// Discovery + execution: list, search, schema, eval. Every request carries
// the caller's credential, so results are the org as you see it — the same
// deployments the VS Code extension's Deployments tab shows, including ones
// that aren't public.

import { loadConfig } from "../config.js";
import type { GlobalOpts } from "../context.js";
import { readStdin } from "../context.js";
import { CliError, EXIT, info, printJson } from "../output.js";
import { requireOrg, resolveAuth } from "../auth/resolve.js";
import { getJson, httpError, postJson } from "../http.js";

const enc = encodeURIComponent;

async function orgContext(globals: GlobalOpts) {
  const config = loadConfig();
  const auth = await resolveAuth(config, {
    token: globals.token,
    org: globals.org,
  });
  const org = requireOrg(auth);
  return { config, auth, org };
}

interface Deployment {
  id: string;
  status?: string;
  error?: string;
  metadata?: {
    description?: string;
    functions?: Array<{ name: string; description?: string }>;
  };
}

export async function listCmd(globals: GlobalOpts): Promise<void> {
  const { config, auth, org } = await orgContext(globals);
  const res = await getJson<Deployment[] | { deployments?: Deployment[] }>(
    `${config.apiBase}/${enc(org)}?functions=full`,
    { auth, what: `list deployments in '${org}'` },
  );
  const deployments = Array.isArray(res) ? res : (res?.deployments ?? []);
  if (globals.json) return printJson(deployments);

  if (deployments.length === 0) {
    info(`No deployments in '${org}'.`);
    return;
  }
  const width = Math.max(...deployments.map((d) => d.id.length));
  for (const d of deployments) {
    const fns = d.metadata?.functions?.length ?? 0;
    const desc = d.metadata?.description ? `  ${d.metadata.description}` : "";
    process.stdout.write(
      `${d.id.padEnd(width)}  ${(d.status ?? "?").padEnd(9)}  ${fns} function${fns === 1 ? "" : "s"}${desc}\n`,
    );
    if (d.status === "failed" && d.error)
      info(`${" ".repeat(width)}  error: ${d.error}`);
  }
}

interface SearchResult {
  data?: Array<{
    slug: string;
    name?: string;
    description?: string;
    matchedFunctions?: Array<{ name: string; description?: string }>;
  }>;
}

export async function searchCmd(
  query: string,
  opts: { limit?: string },
  globals: GlobalOpts,
): Promise<void> {
  const { config, auth, org } = await orgContext(globals);
  const res = await getJson<SearchResult>(
    `${config.skillsBase}/${enc(org)}/search?q=${enc(query)}`,
    { auth, what: `search '${org}'` },
  );
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;
  const data = (res.data ?? []).slice(
    0,
    limit && limit > 0 ? limit : undefined,
  );
  if (globals.json) return printJson({ ...res, data });

  if (!data.length) {
    info(
      `No matching rules in '${org}'. Broaden the query, or run 'legalese list'.`,
    );
    return;
  }
  for (const d of data) {
    process.stdout.write(
      `${d.slug}${d.description ? ` — ${d.description}` : ""}\n`,
    );
    for (const f of d.matchedFunctions ?? []) {
      process.stdout.write(
        `  • ${f.name}${f.description ? ` — ${f.description}` : ""}\n`,
      );
    }
  }
  info(`\nInputs:  legalese schema <deployment> <function>`);
  info(`Run:     legalese eval <deployment> <function> '<json-inputs>'`);
}

export async function schemaCmd(
  deployment: string,
  fn: string | undefined,
  globals: GlobalOpts,
): Promise<void> {
  const { config, auth, org } = await orgContext(globals);
  const path = fn
    ? `/${enc(deployment)}/fn/${enc(fn)}`
    : `/${enc(deployment)}/fn`;
  const res = await getJson(`${config.apiBase}/${enc(org)}${path}`, {
    auth,
    what: fn ? `schema of ${deployment}/${fn}` : `functions of ${deployment}`,
  });
  printJson(res);
}

/** The evaluation API takes `{ "arguments": { … } }`. Plain inputs are
 *  wrapped; a body that already has `arguments` is sent as is. */
export function evaluationBody(inputs: unknown): Record<string, unknown> {
  if (
    inputs &&
    typeof inputs === "object" &&
    !Array.isArray(inputs) &&
    "arguments" in inputs
  ) {
    return inputs as Record<string, unknown>;
  }
  return { arguments: inputs ?? {} };
}

export async function evalCmd(
  deployment: string,
  fn: string,
  inputs: string | undefined,
  globals: GlobalOpts,
): Promise<void> {
  const raw = !inputs || inputs === "-" ? await readStdin() : inputs;
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new CliError("inputs must be valid JSON", EXIT.USAGE);
  }

  const { config, auth, org } = await orgContext(globals);
  const ctx = { auth, what: `evaluate ${deployment}/${fn}` };
  const { status, body } = await postJson(
    `${config.apiBase}/${enc(org)}/${enc(deployment)}/fn/${enc(fn)}/evaluation`,
    evaluationBody(parsed),
    ctx,
  );
  if (status === 422) {
    // The rule ran and reported an error: print it, exit 7.
    printJson(body);
    throw new CliError(
      `${ctx.what}: the rule returned an error`,
      EXIT.EVAL_ERROR,
    );
  }
  if (status < 200 || status >= 300) {
    throw httpError(
      status,
      typeof body === "string" ? body : JSON.stringify(body ?? ""),
      ctx,
    );
  }
  printJson(body);
}
