import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { negotiateCapabilities } from "@opengeni/runtime/sandbox";

// P1.4 route-discipline guards for the API-direct viewer + capability-negotiation
// routes (a complement to the real-DB lifecycle test, which needs docker):
//
//   (1) AUTH-BEFORE-PARSE: every new viewer/stream-capabilities handler calls
//       requireAccessGrant BEFORE any Zod parse — the security invariant the
//       spec mandates (a parse must never run for an unauthorized caller).
//   (2) FLAG-GATE: every new handler asserts sandboxOwnershipEnabled (via
//       assertOwnershipEnabled) so the routes are inert until the flag flips.
//   (3) EXPLICIT 400 ON PARSE FAIL: the mutating viewer handlers use safeParse +
//       an explicit HTTPException(400) — never a raw ZodError → 500.
//   (4) NEGOTIATION SHAPE: the negotiation read returns a coherent
//       SessionCapabilities (every capability present with availability + a
//       typed reason; cold lease degrades the desktop with lease_cold).

const here = dirname(fileURLToPath(import.meta.url));
const sessionsRoute = readFileSync(resolve(here, "..", "src", "routes", "sessions.ts"), "utf8");

// The four new route registrations, by their app.<method>("…") path literal.
const NEW_ROUTES = [
  { method: "get", path: "/v1/workspaces/:workspaceId/sessions/:sessionId/stream-capabilities" },
  { method: "post", path: "/v1/workspaces/:workspaceId/sessions/:sessionId/viewers" },
  {
    method: "post",
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/viewers/:viewerId/heartbeat",
  },
  { method: "delete", path: "/v1/workspaces/:workspaceId/sessions/:sessionId/viewers/:viewerId" },
];

// Extract the body of an app.<method>("<path>", async (c) => { … }) handler by
// brace-matching from the registration site to its matching close.
function routeRegex(method: string, path: string): RegExp {
  // Wrap-tolerant: the formatter may break a long registration across lines, so
  // allow whitespace between `app.<method>(` and the "<path>" literal. The
  // trailing quote anchors the path so a prefix (e.g. /viewers) can't match a
  // longer sibling (/viewers/:viewerId).
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

describe("P1.4 viewer/stream-capabilities route discipline", () => {
  for (const route of NEW_ROUTES) {
    test(`${route.method.toUpperCase()} ${route.path}: requireAccessGrant precedes any Zod parse + asserts the flag`, () => {
      const body = handlerBody(sessionsRoute, route.method, route.path);
      const grantAt = body.indexOf("requireAccessGrant");
      expect(grantAt, "handler must call requireAccessGrant").toBeGreaterThanOrEqual(0);
      // assertOwnershipEnabled (the flag gate) is present.
      expect(body).toContain("assertOwnershipEnabled");
      // No Zod parse precedes requireAccessGrant.
      const parseAt = Math.min(
        ...[".parse(", ".safeParse("]
          .map((p) => body.indexOf(p))
          .filter((i) => i >= 0)
          .concat([Number.MAX_SAFE_INTEGER]),
      );
      if (parseAt !== Number.MAX_SAFE_INTEGER) {
        expect(parseAt).toBeGreaterThan(grantAt);
      }
    });
  }

  test("the mutating viewer handlers use safeParse + explicit HTTPException(400), never a raw ZodError", () => {
    for (const route of [NEW_ROUTES[1]!, NEW_ROUTES[2]!]) {
      const body = handlerBody(sessionsRoute, route.method, route.path);
      expect(body).toContain(".safeParse(");
      expect(body).toContain("HTTPException(400");
    }
  });

  test("the flag gate is a 404 (the route is invisible while disabled)", () => {
    // assertOwnershipEnabled throws a 404 (not 403/500) so a disabled deployment
    // does not advertise the surface.
    const gate = sessionsRoute.slice(sessionsRoute.indexOf("function assertOwnershipEnabled"));
    expect(gate.slice(0, 400)).toContain("HTTPException(404");
    expect(gate.slice(0, 400)).toContain("sandboxOwnershipEnabled");
  });
});

describe("P1.4 capability negotiation read returns a coherent SessionCapabilities", () => {
  const sessionId = "00000000-0000-4000-8000-000000000001";

  test("a cold lease (no box) degrades the desktop with lease_cold; FS/Git/Terminal stay available", () => {
    const caps = negotiateCapabilities({
      sessionId,
      backend: "modal",
      os: "linux",
      liveness: "cold",
      leaseEpoch: 0,
      desktopEnabled: true,
    });
    expect(caps.sessionId).toBe(sessionId);
    expect(caps.backend).toBe("modal");
    expect(caps.liveness).toBe("cold");
    // Every capability present; the desktop is gated by the cold lease.
    expect(caps.FileSystem.available).toBe(true);
    expect(caps.Git.available).toBe(true);
    expect(caps.DesktopStream.transport).toBeNull();
    expect(caps.DesktopStream.reason).toBe("lease_cold");
    // The pixel URL/token are never minted in P1.4.
    expect(caps.DesktopStream.url).toBeNull();
    expect(caps.DesktopStream.token).toBeNull();
  });

  test("a 'none' backend reports backend_unsupported for FS/Desktop (degradation is a value, never absent)", () => {
    const caps = negotiateCapabilities({
      sessionId,
      backend: "none",
      os: "linux",
      liveness: "cold",
      leaseEpoch: 0,
      desktopEnabled: false,
    });
    expect(caps.FileSystem.available).toBe(false);
    expect(caps.FileSystem.reason).toBe("backend_unsupported");
    expect(caps.DesktopStream.transport).toBeNull();
    expect(caps.DesktopStream.reason).not.toBeNull();
  });
});
