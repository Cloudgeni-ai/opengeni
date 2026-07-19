import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// M5 route-discipline guards for the enrollment device-flow routes — a docker-free
// complement to the real-DB integration test (enrollment-routes.test.ts):
//
//   (1) FLAG-GATE: every handler asserts sandboxSelfhostedEnabled
//       (assertSelfhostedEnabled) so the routes are inert (404) until the flag flips.
//   (2) AUTH SPLIT: the USER-authenticated routes (approve / list / revoke) call
//       requireAccessGrant; the AGENT routes (start / poll) DO NOT (user-
//       unauthenticated) but ARE rate-limited.
//   (3) AUTH-BEFORE-PARSE on the user routes: requireAccessGrant precedes any
//       safeParse (a parse must never run for an unauthorized caller).
//   (4) EXPLICIT 400 ON PARSE FAIL: the mutating handlers use safeParse + an
//       explicit HTTPException(400), never a raw ZodError → 500.

const here = dirname(fileURLToPath(import.meta.url));
const routesSrc = readFileSync(resolve(here, "..", "src", "routes", "enrollments.ts"), "utf8");
const appSrc = readFileSync(resolve(here, "..", "src", "app.ts"), "utf8");

function routeRegex(method: string, path: string): RegExp {
  // Wrap-tolerant: the formatter may break a long registration across lines, so
  // allow whitespace between `app.<method>(` and the "<path>" literal. The
  // trailing quote anchors the path so a prefix can't match a longer sibling.
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`app\\.${method}\\(\\s*"${escaped}"`);
}

function handlerBody(source: string, method: string, path: string): string {
  const start = source.search(routeRegex(method, path));
  expect(start, `route not found: ${method.toUpperCase()} ${path}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced handler braces for ${method} ${path}`);
}

const AGENT_ROUTES = [
  { method: "post", path: "/v1/enrollments/device/start" },
  { method: "post", path: "/v1/enrollments/device/poll" },
  { method: "post", path: "/v1/enrollments/token/exchange" },
  { method: "post", path: "/v1/enrollments/self/refresh" },
  { method: "post", path: "/v1/enrollments/self/revoke" },
];
const USER_ROUTES = [
  { method: "post", path: "/v1/workspaces/:workspaceId/enrollments/device/approve" },
  { method: "post", path: "/v1/workspaces/:workspaceId/enrollments/device/deny" },
  { method: "post", path: "/v1/workspaces/:workspaceId/enrollments/token" },
  { method: "get", path: "/v1/workspaces/:workspaceId/enrollments" },
  { method: "post", path: "/v1/workspaces/:workspaceId/enrollments/:enrollmentId/revoke" },
];
// The enrollment-UX additions whose auth shape differs from the standard user
// routes: lookup is authenticated but has NO workspace in the path (it authorizes
// AGAINST the workspace it resolves from the code, so requireAccessGrant runs
// AFTER the parse); exchange is UNAUTHENTICATED (the `oget_` token is the auth).
const LOOKUP_ROUTE = { method: "post", path: "/v1/enrollments/device/lookup" };
const EXCHANGE_ROUTE = { method: "post", path: "/v1/enrollments/token/exchange" };
const SELF_REFRESH_ROUTE = { method: "post", path: "/v1/enrollments/self/refresh" };
const SELF_REVOKE_ROUTE = { method: "post", path: "/v1/enrollments/self/revoke" };

describe("M5 enrollment route discipline", () => {
  test("every handler asserts the selfhosted flag", () => {
    for (const route of [...AGENT_ROUTES, ...USER_ROUTES, LOOKUP_ROUTE, EXCHANGE_ROUTE]) {
      const body = handlerBody(routesSrc, route.method, route.path);
      expect(body, `${route.method} ${route.path} must gate on the flag`).toContain(
        "assertSelfhostedEnabled",
      );
    }
  });

  test("the flag gate is a 404 (the routes are invisible while disabled)", () => {
    const gate = routesSrc.slice(routesSrc.indexOf("function assertSelfhostedEnabled"));
    expect(gate.slice(0, 400)).toContain("HTTPException(404");
    expect(gate.slice(0, 400)).toContain("sandboxSelfhostedEnabled");
  });

  test("the AGENT routes (start/poll) are rate-limited and do NOT call requireAccessGrant", () => {
    for (const route of AGENT_ROUTES) {
      const body = handlerBody(routesSrc, route.method, route.path);
      expect(body, `${route.path} must be rate-limited`).toContain("rateLimit(");
      // The CALL form (not a comment mention) must be absent — these are agent routes.
      expect(body.includes("requireAccessGrant("), `${route.path} must NOT user-authenticate`).toBe(
        false,
      );
    }
  });

  test("the USER routes call requireAccessGrant BEFORE any parse", () => {
    for (const route of USER_ROUTES) {
      const body = handlerBody(routesSrc, route.method, route.path);
      const grantAt = body.indexOf("requireAccessGrant");
      expect(grantAt, `${route.path} must call requireAccessGrant`).toBeGreaterThanOrEqual(0);
      const parseAt = Math.min(
        ...[".parse(", ".safeParse("]
          .map((p) => body.indexOf(p))
          .filter((i) => i >= 0)
          .concat([Number.MAX_SAFE_INTEGER]),
      );
      if (parseAt !== Number.MAX_SAFE_INTEGER) {
        expect(parseAt, `${route.path} parse must follow auth`).toBeGreaterThan(grantAt);
      }
    }
  });

  test("approve uses the enrollments:manage permission; list uses enrollments:read", () => {
    const approve = handlerBody(
      routesSrc,
      "post",
      "/v1/workspaces/:workspaceId/enrollments/device/approve",
    );
    expect(approve).toContain('"enrollments:manage"');
    const list = handlerBody(routesSrc, "get", "/v1/workspaces/:workspaceId/enrollments");
    expect(list).toContain('"enrollments:read"');
    const revoke = handlerBody(
      routesSrc,
      "post",
      "/v1/workspaces/:workspaceId/enrollments/:enrollmentId/revoke",
    );
    expect(revoke).toContain('"enrollments:manage"');
  });

  test("the mutating agent + approve handlers use safeParse + explicit HTTPException(400)", () => {
    for (const route of [AGENT_ROUTES[0]!, AGENT_ROUTES[1]!, USER_ROUTES[0]!]) {
      const body = handlerBody(routesSrc, route.method, route.path);
      expect(body).toContain(".safeParse(");
      expect(body).toContain("HTTPException(400");
    }
  });

  test("deny + token use enrollments:manage", () => {
    const deny = handlerBody(
      routesSrc,
      "post",
      "/v1/workspaces/:workspaceId/enrollments/device/deny",
    );
    expect(deny).toContain('"enrollments:manage"');
    const token = handlerBody(routesSrc, "post", "/v1/workspaces/:workspaceId/enrollments/token");
    expect(token).toContain('"enrollments:manage"');
  });

  test("lookup is rate-limited + authorizes against the resolved workspace (enrollments:read)", () => {
    const body = handlerBody(routesSrc, LOOKUP_ROUTE.method, LOOKUP_ROUTE.path);
    expect(body).toContain("rateLimit(");
    expect(body).toContain("assertSelfhostedEnabled");
    // It DOES authorize — but against the workspace it resolves from the code, so
    // (unlike the standard user routes) the grant check follows the lookup.
    expect(body).toContain("requireAccessGrant(");
    expect(body).toContain('"enrollments:read"');
    expect(body).toContain(".safeParse(");
    expect(body).toContain("HTTPException(400");
  });

  test("exchange is UNAUTHENTICATED (the token is the auth) + rate-limited", () => {
    const body = handlerBody(routesSrc, EXCHANGE_ROUTE.method, EXCHANGE_ROUTE.path);
    expect(body).toContain("rateLimit(");
    expect(body).toContain("assertSelfhostedEnabled");
    // No user authentication — the `oget_` token verification inside the service is
    // the auth. The CALL form must be absent.
    expect(body.includes("requireAccessGrant("), "exchange must NOT user-authenticate").toBe(false);
    expect(body).toContain(".safeParse(");
    expect(body).toContain("HTTPException(400");
  });

  test("self-refresh is bearer-only, rate-limited, and deployment-auth exempt", () => {
    const body = handlerBody(routesSrc, SELF_REFRESH_ROUTE.method, SELF_REFRESH_ROUTE.path);
    expect(body).toContain("rateLimit(");
    expect(body).toContain("assertSelfhostedEnabled");
    expect(body).toContain('c.req.header("authorization")');
    expect(body).toContain("refreshEnrollmentCredentials");
    expect(body.includes("c.req.json("), "refresh must not accept a body credential").toBe(false);
    expect(body.includes("requireAccessGrant("), "refresh must NOT user-authenticate").toBe(false);
    expect(appSrc).toContain('label: "/v1/enrollments/self/refresh"');
    expect(appSrc).toContain('pathname === "/v1/enrollments/self/refresh"');
  });

  test("self-revoke is bearer-authenticated, rate-limited, and never user-authenticates", () => {
    const body = handlerBody(routesSrc, SELF_REVOKE_ROUTE.method, SELF_REVOKE_ROUTE.path);
    expect(body).toContain("rateLimit(");
    expect(body).toContain("assertSelfhostedEnabled");
    expect(body).toContain("verifyEnrollmentBearer");
    expect(body.includes("requireAccessGrant("), "self revoke must NOT user-authenticate").toBe(
      false,
    );
    expect(body).toContain("revokeEnrollmentByGeneration");
    expect(body).toContain("claims.credentialGeneration");
    expect(body).toContain("if (!result.matched)");
    expect(body).toContain("claims.subjectPrefix");
    expect(appSrc).toContain('label: "/v1/enrollments/self/revoke"');
    expect(appSrc).toContain('label: "/v1/enrollments/token/exchange"');
  });
});
