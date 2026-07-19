import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTPException } from "hono/http-exception";
import { ChannelAUnavailableError } from "@opengeni/runtime/sandbox";
import { mapChannelAError } from "../src/sandbox/channel-a";

// P4.4 route-discipline guards for the 13 Channel-A structured-service routes (a
// complement to the real-box runtime test + the docker e2e). The invariants the
// spec mandates for every API-direct route:
//
//   (1) AUTH-BEFORE-PARSE: the channelAPreamble (which calls requireAccessGrant)
//       runs BEFORE parseChannelABody (the Zod parse) in every handler.
//   (2) FLAG-GATE: the preamble asserts sandboxOwnershipEnabled, so the routes
//       are inert until the flag flips per-environment.
//   (3) EXPLICIT 400 ON PARSE FAIL: parseChannelABody uses safeParse + an
//       explicit HTTPException(400) — never a raw ZodError → 500.
//   (4) CORRECT PERMISSION: FS reads/Git ride files:read, FS mutations ride
//       files:write, Terminal exec + PTY ride terminal:attach.

const here = dirname(fileURLToPath(import.meta.url));
const sessionsRoute = readFileSync(resolve(here, "..", "src", "routes", "sessions.ts"), "utf8");
const channelASeam = readFileSync(resolve(here, "..", "src", "sandbox", "channel-a.ts"), "utf8");

type RouteSpec = { path: string; permission: "files:read" | "files:write" | "terminal:attach" };
const CHANNEL_A_ROUTES: RouteSpec[] = [
  { path: "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/list", permission: "files:read" },
  { path: "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/read", permission: "files:read" },
  { path: "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/write", permission: "files:write" },
  { path: "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/delete", permission: "files:write" },
  { path: "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/move", permission: "files:write" },
  { path: "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/mkdir", permission: "files:write" },
  { path: "/v1/workspaces/:workspaceId/sessions/:sessionId/git/status", permission: "files:read" },
  { path: "/v1/workspaces/:workspaceId/sessions/:sessionId/git/diff", permission: "files:read" },
  { path: "/v1/workspaces/:workspaceId/sessions/:sessionId/git/log", permission: "files:read" },
  { path: "/v1/workspaces/:workspaceId/sessions/:sessionId/git/show", permission: "files:read" },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/exec",
    permission: "terminal:attach",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty",
    permission: "terminal:attach",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty/write",
    permission: "terminal:attach",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty/resize",
    permission: "terminal:attach",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty/close",
    permission: "terminal:attach",
  },
];

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

describe("P4.4 Channel-A route discipline", () => {
  test("all 13 routes are registered", () => {
    for (const route of CHANNEL_A_ROUTES) {
      expect(
        routeRegex("post", route.path).test(sessionsRoute),
        `missing route ${route.path}`,
      ).toBe(true);
    }
  });

  for (const route of CHANNEL_A_ROUTES) {
    test(`${route.path}: grant (preamble) precedes the Zod parse + carries ${route.permission}`, () => {
      const body = handlerBody(sessionsRoute, "post", route.path);
      const preambleAt = body.indexOf("channelAPreamble");
      const parseAt = body.indexOf("parseChannelABody");
      expect(
        preambleAt,
        "handler must call channelAPreamble (auth+flag+session)",
      ).toBeGreaterThanOrEqual(0);
      // the preamble (auth) always precedes the body parse.
      if (parseAt >= 0) {
        expect(parseAt).toBeGreaterThan(preambleAt);
      }
      // the correct permission is passed to the preamble.
      expect(body).toContain(`"${route.permission}"`);
    });
  }

  test("channelAPreamble calls requireAccessGrant BEFORE the session lookup + asserts the flag", () => {
    const preamble = sessionsRoute.slice(sessionsRoute.indexOf("async function channelAPreamble"));
    const slice = preamble.slice(0, 800);
    const grantAt = slice.indexOf("requireAccessGrant");
    const flagAt = slice.indexOf("assertOwnershipEnabled");
    const sessionAt = slice.indexOf("getSession(");
    expect(grantAt).toBeGreaterThanOrEqual(0);
    expect(flagAt).toBeGreaterThan(grantAt);
    expect(sessionAt).toBeGreaterThan(grantAt);
    // a missing session is a 404.
    expect(slice).toContain("HTTPException(404");
  });

  test("parseChannelABody uses safeParse + an explicit HTTPException(400), never a raw ZodError", () => {
    const parser = sessionsRoute.slice(sessionsRoute.indexOf("async function parseChannelABody"));
    const slice = parser.slice(0, 600);
    expect(slice).toContain(".safeParse(");
    expect(slice).toContain("HTTPException(400");
  });

  test("the flag gate is a 404 (the routes are invisible while disabled)", () => {
    const gate = sessionsRoute.slice(sessionsRoute.indexOf("function assertOwnershipEnabled"));
    expect(gate.slice(0, 400)).toContain("HTTPException(404");
    expect(gate.slice(0, 400)).toContain("sandboxOwnershipEnabled");
  });

  test("the channel-a seam maps typed service errors to explicit HTTP status", () => {
    // backend:none -> 409; bad paths stay 400/404 while transient control-plane
    // failures are retryable 503s and never blame valid user input.
    expect(channelASeam).toContain('session.sandboxBackend === "none"');
    expect(channelASeam).toContain("HTTPException(409");
    // Wrap-tolerant: the formatter may break the guard onto its own line, so
    // allow whitespace between the `instanceof …)` and the mapped `return`.
    expect(channelASeam).toMatch(/ChannelAValidationError\)\s+return new HTTPException\(400/);
    expect(channelASeam).toMatch(/ChannelANotFoundError\)\s+return new HTTPException\(404/);
    expect(channelASeam).toMatch(/ChannelAConflictError\)\s+return new HTTPException\(409/);
    expect(channelASeam).toMatch(/ChannelAUnavailableError\)\s+return new HTTPException\(503/);

    const mapped = mapChannelAError(
      new ChannelAUnavailableError("Workspace files are temporarily unavailable. Retry."),
    );
    expect(mapped).toBeInstanceOf(HTTPException);
    expect((mapped as HTTPException).status).toBe(503);
    expect((mapped as HTTPException).message).toBe(
      "Workspace files are temporarily unavailable. Retry.",
    );
  });

  test("the seam never signals Temporal / routes through a worker (API-direct only)", () => {
    // The synchronous read path must not touch the workflow client or NATS req/reply.
    expect(channelASeam).not.toContain("workflowClient");
    expect(channelASeam).not.toContain("signalWithStart");
    expect(channelASeam).not.toContain("executeWorkflow");
    // it resumes the box by id IN-PROCESS via the leaf.
    expect(channelASeam).toContain("establishSandboxSessionFromEnvelope");
    expect(channelASeam).toContain("@opengeni/runtime/sandbox");
  });

  test("the PTY write route 409s when the backend lacks writeStdin (execSessionId null)", () => {
    const body = handlerBody(
      sessionsRoute,
      "post",
      "/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty/write",
    );
    expect(body).toContain("execSessionId === null");
    expect(body).toContain("interactive terminal unsupported on this backend");
  });
});
