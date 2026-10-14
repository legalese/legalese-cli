// Authenticated requests to the proxy hosts, with errors explained from the
// caller's point of view: which org, which role, which permission is missing.

import type { ResolvedAuth } from "./auth/resolve.js";
import { CliError, EXIT } from "./output.js";

export interface RequestContext {
  auth: ResolvedAuth;
  /** What the user asked for, e.g. "evaluate rent-rules/rentIsOverdue". */
  what: string;
}

async function send(url: string, init: RequestInit, ctx: RequestContext) {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${ctx.auth.token}`,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new CliError(
      `${ctx.what}: could not reach ${new URL(url).host} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const text = await res.text();
  return { res, text };
}

function parse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** GET JSON; throws a CliError explaining any non-2xx. */
export async function getJson<T = unknown>(
  url: string,
  ctx: RequestContext,
): Promise<T> {
  const { res, text } = await send(url, {}, ctx);
  if (!res.ok) throw httpError(res.status, text, ctx);
  return parse(text) as T;
}

/** POST JSON; returns the status and parsed body for the caller to judge. */
export async function postJson(
  url: string,
  body: unknown,
  ctx: RequestContext,
): Promise<{ status: number; body: unknown }> {
  const { res, text } = await send(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    ctx,
  );
  return { status: res.status, body: parse(text) };
}

/** Map a failed response to a CliError worded for the signed-in user. */
export function httpError(
  status: number,
  text: string,
  ctx: RequestContext,
): CliError {
  const { auth, what } = ctx;
  const body = parse(text) as
    | { required?: string; error?: string }
    | string
    | undefined;
  const orgLabel = auth.org ? `'${auth.org}'` : "this org";

  if (status === 401) {
    return new CliError(
      auth.source === "session"
        ? `${what}: your session was not accepted — run 'legalese login'`
        : `${what}: the ${auth.source === "env" ? "LEGALESE_TOKEN" : "--token"} credential was rejected`,
      EXIT.UNAUTHENTICATED,
    );
  }
  if (status === 403) {
    const required = typeof body === "object" ? body?.required : undefined;
    const session = auth.session;
    const holder = session
      ? `your role${session.role ? ` '${session.role}'` : ""} in ${orgLabel}`
      : `this credential for ${orgLabel}`;
    const has = session
      ? ` (you have: ${session.permissions.length ? session.permissions.join(", ") : "no permissions"})`
      : "";
    return new CliError(
      required
        ? `${what}: forbidden — needs ${required}, which ${holder} doesn't grant${has}`
        : `${what}: forbidden for ${holder}${has}`,
      EXIT.FORBIDDEN,
    );
  }
  if (status === 404) {
    return new CliError(
      `${what}: not found in ${orgLabel} (or not visible to you)`,
      EXIT.NOT_FOUND,
    );
  }
  if (status === 429) {
    return new CliError(`${what}: rate limited — ${detail(body)}`);
  }
  return new CliError(
    `${what} failed: HTTP ${status}${detail(body) ? " — " + detail(body) : ""}`,
  );
}

function detail(body: unknown): string {
  if (!body) return "";
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return s.slice(0, 300).replace(/\s+/g, " ").trim();
}
