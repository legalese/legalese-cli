// A fake AuthKit + Legalese Cloud proxy on one local HTTP server, for tests.
// It plays the authorization server (discovery, authorize, token, device),
// the proxy's /auth/whoami and /auth/logout, and the API/skills hosts.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

export function fakeJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.c2ln`;
}

export interface FakeUser {
  sub: string;
  email: string;
  orgId: string | null;
  orgSlug: string | null;
  role: string;
  permissions: string[];
}

export interface FakeCloudOptions {
  user?: Partial<FakeUser>;
  /** Accept loopback redirect URIs at /oauth2/authorize. */
  loopbackRedirects?: boolean;
  /** Serve /auth/whoami (false = an older proxy, 404). */
  whoami?: boolean;
  /** Access-token lifetime in seconds (tokens from sign-in). */
  ttl?: number;
  /** Lifetime of tokens from a refresh (default: ttl). */
  refreshTtl?: number;
}

export interface FakeCloud {
  base: string;
  close(): Promise<void>;
  calls: Array<{ method: string; path: string }>;
  /** Refresh tokens that have been spent (single-use, like WorkOS). */
  spent: Set<string>;
  revoked: string[];
  refreshCount: number;
  /** Pending device code becomes approved after this many polls. */
  approveAfterPolls: number;
  deviceOutcome: "approve" | "deny";
  /** Simulate the user's browser following an authorize redirect. */
  lastAuthorize?: URL;
  user: FakeUser;
}

export async function startFakeCloud(
  opts: FakeCloudOptions = {},
): Promise<FakeCloud> {
  const user: FakeUser = {
    sub: "user_1",
    email: "ada@example.com",
    orgId: "org_1",
    orgSlug: "acme",
    role: "member",
    permissions: ["l4:rules", "l4:evaluate"],
    ...opts.user,
  };
  const ttl = opts.ttl ?? 300;
  let seq = 0;
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  let devicePolls = 0;

  const state: FakeCloud = {
    base: "",
    close: async () => {},
    calls: [],
    spent: new Set(),
    revoked: [],
    refreshCount: 0,
    approveAfterPolls: 1,
    deviceOutcome: "approve",
    user,
  };

  const issue = (lifetime = ttl) => {
    seq++;
    return {
      access_token: fakeJwt({
        sub: user.sub,
        org_id: user.orgId ?? undefined,
        role: user.role,
        sid: `session_${seq}`,
        exp: Math.floor(Date.now() / 1000) + lifetime,
      }),
      refresh_token: `refresh_${seq}`,
      expires_in: lifetime,
    };
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", state.base);
    state.calls.push({ method: req.method ?? "GET", path: url.pathname });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const form = new URLSearchParams(raw);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const claims = (() => {
      try {
        return JSON.parse(
          Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString(),
        );
      } catch {
        return null;
      }
    })();

    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource":
        return json(200, { authorization_servers: [state.base] });
      case "/.well-known/oauth-authorization-server":
        return json(200, {
          issuer: state.base,
          authorization_endpoint: `${state.base}/oauth2/authorize`,
          token_endpoint: `${state.base}/oauth2/token`,
          device_authorization_endpoint: `${state.base}/oauth2/device_authorization`,
        });
      case "/oauth2/authorize": {
        const redirect = url.searchParams.get("redirect_uri") ?? "";
        if (
          !opts.loopbackRedirects &&
          redirect.startsWith("http://127.0.0.1")
        ) {
          res.writeHead(302, {
            Location: `${state.base}/oauth2/error?error=invalid_redirect_uri`,
          });
          return res.end();
        }
        state.lastAuthorize = url;
        res.writeHead(302, { Location: `${state.base}/login` });
        return res.end();
      }
      case "/oauth2/device_authorization":
        return json(200, {
          device_code: "dev_1",
          user_code: "ABCD-EFGH",
          verification_uri: `${state.base}/device`,
          verification_uri_complete: `${state.base}/device?user_code=ABCD-EFGH`,
          interval: 0.01,
          expires_in: 60,
        });
      case "/oauth2/token": {
        const grant = form.get("grant_type");
        if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
          devicePolls++;
          if (state.deviceOutcome === "deny")
            return json(400, { error: "access_denied" });
          if (devicePolls <= state.approveAfterPolls)
            return json(400, { error: "authorization_pending" });
          return json(200, issue());
        }
        if (grant === "authorization_code") {
          const c = codes.get(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256")
            .update(verifier)
            .digest("base64url");
          if (
            !c ||
            c.challenge !== challenge ||
            c.redirectUri !== form.get("redirect_uri")
          )
            return json(400, { error: "invalid_grant" });
          return json(200, issue());
        }
        if (grant === "refresh_token") {
          const rt = form.get("refresh_token") ?? "";
          if (!rt.startsWith("refresh_") || state.spent.has(rt))
            return json(400, { error: "invalid_grant" });
          state.spent.add(rt);
          state.refreshCount++;
          return json(200, issue(opts.refreshTtl ?? ttl));
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      case "/auth/whoami": {
        if (opts.whoami === false) return json(404, { error: "Not found" });
        if (!claims?.sub) return json(401, { error: "unauthenticated" });
        return json(200, {
          authenticated: true,
          user: {
            id: user.sub,
            email: user.email,
            firstName: "Ada",
            lastName: "Lovelace",
          },
          organization: user.orgId
            ? { id: user.orgId, slug: user.orgSlug, name: "Acme" }
            : null,
          role: user.role,
          permissions: user.orgId ? user.permissions : [],
          expiresAt: claims.exp,
        });
      }
      case "/auth/logout":
        if (req.method === "POST" && claims?.sid) {
          state.revoked.push(claims.sid);
          return json(200, { revoked: true });
        }
        res.writeHead(302, { Location: "https://example.com" });
        return res.end();
    }

    // API host: /{org}?functions=full, /{org}/{dep}/fn[/{fn}[/evaluation]]
    const parts = url.pathname.split("/").filter(Boolean);
    if (!claims?.sub) return json(401, { error: "unauthenticated" });
    if (parts[0] !== user.orgSlug) return json(404, { error: "Not found" });
    if (parts.length === 1) {
      return json(200, [
        {
          id: "rent-rules",
          status: "ready",
          metadata: {
            description: "Rent",
            functions: [{ name: "rentIsOverdue" }],
          },
        },
      ]);
    }
    if (parts[1] === "search") {
      return json(200, {
        data: [
          { slug: "rent-rules", matchedFunctions: [{ name: "rentIsOverdue" }] },
        ],
      });
    }
    if (parts[2] === "fn" && parts[4] === "evaluation") {
      if (!user.permissions.includes("l4:evaluate"))
        return json(403, { error: "Forbidden", required: "l4:evaluate" });
      const body = JSON.parse(raw || "{}");
      if (parts[3] === "broken")
        return json(422, { tag: "SimpleError", contents: "boom" });
      return json(200, { tag: "SimpleResponse", received: body });
    }
    if (parts[2] === "fn")
      return json(200, { name: parts[3] ?? null, parameters: {} });
    return json(404, { error: "Not found" });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));

  // Hand out an authorization code the way AuthKit would after sign-in.
  (state as FakeCloud & { approve: () => string }).approve = () => {
    const a = state.lastAuthorize!;
    const code = `code_${++seq}`;
    codes.set(code, {
      challenge: a.searchParams.get("code_challenge")!,
      redirectUri: a.searchParams.get("redirect_uri")!,
    });
    return code;
  };
  return state;
}

/** Issue a code for the last authorize request (browser sign-in). */
export function approveBrowserSignIn(cloud: FakeCloud): string {
  return (cloud as FakeCloud & { approve: () => string }).approve();
}
