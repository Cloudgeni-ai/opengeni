import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTPException } from "hono/http-exception";
import { SandboxProviderReadLockUnavailableError } from "@opengeni/db";
import {
  ChannelAConflictError,
  ChannelAUnavailableError,
  ChannelAValidationError,
} from "@opengeni/runtime/sandbox";
import {
  channelAOperationFailureDiagnostic,
  isChannelAHandleCacheEntryFresh,
  isChannelAProcessHandleCacheEntryFresh,
  isChannelARequestCancellation,
  mapChannelAError,
  runChannelAReadWithFreshHandleRetry,
  runConcurrentChannelAReads,
  shouldEvictChannelAHandleAfterError,
} from "../src/sandbox/channel-a";

// P4.4 route-discipline guards for all Channel-A structured-service routes (a
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

type RouteSpec = {
  path: string;
  permission: "files:read" | "files:write" | "terminal:attach";
  operation: string;
};
const CHANNEL_A_ROUTES: RouteSpec[] = [
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/list",
    permission: "files:read",
    operation: "fs.list",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/list-batch",
    permission: "files:read",
    operation: "fs.list-batch",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/read",
    permission: "files:read",
    operation: "fs.read",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/write",
    permission: "files:write",
    operation: "fs.write",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/delete",
    permission: "files:write",
    operation: "fs.delete",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/move",
    permission: "files:write",
    operation: "fs.move",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/mkdir",
    permission: "files:write",
    operation: "fs.mkdir",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/git/status",
    permission: "files:read",
    operation: "git.status",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/git/diff",
    permission: "files:read",
    operation: "git.diff",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/git/read-batch",
    permission: "files:read",
    operation: "git.read-batch",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/git/log",
    permission: "files:read",
    operation: "git.log",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/git/show",
    permission: "files:read",
    operation: "git.show",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/exec",
    permission: "terminal:attach",
    operation: "terminal.exec",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty",
    permission: "terminal:attach",
    operation: "terminal.pty.open",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty/write",
    permission: "terminal:attach",
    operation: "terminal.pty.write",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty/resize",
    permission: "terminal:attach",
    operation: "terminal.pty.resize",
  },
  {
    path: "/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty/close",
    permission: "terminal:attach",
    operation: "terminal.pty.close",
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
  test("all 17 routes are registered", () => {
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
      expect(body).toContain(`"${route.operation}"`);
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

  test("request aborts map to a distinct 499 cancellation diagnostic", () => {
    const controller = new AbortController();
    const abort = new DOMException("client disconnected", "AbortError");
    controller.abort(abort);
    expect(isChannelARequestCancellation(abort, controller.signal)).toBe(true);
    expect(channelAOperationFailureDiagnostic(abort, controller.signal)).toEqual({
      reason: "request_cancelled",
      status: 499,
      errorCode: "sandbox_channel_a_cancelled",
    });
    const mapped = mapChannelAError(abort, controller.signal);
    expect(mapped).toBeInstanceOf(HTTPException);
    expect((mapped as HTTPException).status).toBe(499);
    expect((mapped as HTTPException).message).toBe("request cancelled");
  });

  test("an unrelated provider AbortError is not misreported as a client cancellation", () => {
    const abort = new DOMException("provider aborted", "AbortError");
    const liveRequest = new AbortController();
    expect(isChannelARequestCancellation(abort, liveRequest.signal)).toBe(false);
    expect(channelAOperationFailureDiagnostic(abort, liveRequest.signal)).toEqual({
      reason: "unexpected",
      status: 500,
      errorCode: "sandbox_channel_a_operation_failed",
    });
    expect(mapChannelAError(abort, liveRequest.signal)).toBe(abort);
  });

  test("provider contention and provider unavailability remain distinguishable", () => {
    expect(
      channelAOperationFailureDiagnostic(new SandboxProviderReadLockUnavailableError()),
    ).toEqual({
      reason: "provider_read_busy",
      status: 503,
      errorCode: "sandbox_channel_a_provider_busy",
    });
    expect(channelAOperationFailureDiagnostic(new ChannelAUnavailableError("temporary"))).toEqual({
      reason: "provider_unavailable",
      status: 503,
      errorCode: "sandbox_channel_a_provider_unavailable",
    });
  });

  test("concurrent reads settle before one bounded transient retry", async () => {
    let transientCalls = 0;
    let siblingSettled = false;
    const values = await runConcurrentChannelAReads([
      async () => {
        transientCalls += 1;
        if (transientCalls === 1) {
          throw new ChannelAUnavailableError("temporary provider wake race");
        }
        expect(siblingSettled).toBe(true);
        return "recovered";
      },
      async () => {
        await Bun.sleep(5);
        siblingSettled = true;
        return "sibling";
      },
    ]);

    expect(values).toEqual(["recovered", "sibling"]);
    expect(transientCalls).toBe(2);
  });

  test("both concurrent batch routes use the settled read helper", () => {
    for (const route of ["fs/list-batch", "git/read-batch"]) {
      const body = handlerBody(
        sessionsRoute,
        "post",
        `/v1/workspaces/:workspaceId/sessions/:sessionId/${route}`,
      );
      expect(body).toContain("runConcurrentChannelAReads(");
      expect(body).not.toContain("Promise.all(");
    }
  });

  test("every side-effect-free point read uses the coordinated recovery seam", () => {
    for (const route of [
      "fs/list",
      "fs/list-batch",
      "fs/read",
      "git/status",
      "git/diff",
      "git/read-batch",
      "git/log",
      "git/show",
    ]) {
      const body = handlerBody(
        sessionsRoute,
        "post",
        `/v1/workspaces/:workspaceId/sessions/:sessionId/${route}`,
      );
      expect(body).toContain("withChannelARead(");
    }

    for (const route of ["fs/write", "fs/delete", "fs/move", "fs/mkdir", "terminal/exec"]) {
      const body = handlerBody(
        sessionsRoute,
        "post",
        `/v1/workspaces/:workspaceId/sessions/:sessionId/${route}`,
      );
      expect(body).toContain("withChannelA(");
      expect(body).not.toContain("withChannelARead(");
    }
  });

  test("read and process wrappers are isolated and idle-bounded", () => {
    const lastUsedAt = 1_000;
    expect(isChannelAHandleCacheEntryFresh(lastUsedAt, lastUsedAt + 299_999)).toBe(true);
    expect(isChannelAHandleCacheEntryFresh(lastUsedAt, lastUsedAt + 300_000)).toBe(false);
    expect(isChannelAProcessHandleCacheEntryFresh(lastUsedAt, lastUsedAt + 299_999)).toBe(true);
    expect(isChannelAProcessHandleCacheEntryFresh(lastUsedAt, lastUsedAt + 300_000)).toBe(false);
    expect(channelASeam).toContain("establishedReadHandleCache");
    expect(channelASeam).toContain("establishedProcessHandleCache");
    expect(channelASeam).toContain("lastUsedAtMonotonicMs");
  });

  test("Modal reads rebuild across a second rollover unavailable result", async () => {
    const order: string[] = [];
    let calls = 0;
    const value = await runChannelAReadWithFreshHandleRetry(
      async () => {
        calls += 1;
        order.push(`run:${calls}`);
        if (calls <= 2) throw new ChannelAUnavailableError("provider rollover still settling");
        return "fresh";
      },
      async (attempt) => {
        order.push(`refresh:${attempt}`);
      },
      { maxFreshHandleRetries: 2 },
    );
    expect(value).toBe("fresh");
    expect(order).toEqual(["run:1", "refresh:1", "run:2", "refresh:2", "run:3"]);
  });

  test("provider-neutral recovery defaults to one retry and never replays non-transient errors", async () => {
    let unavailableCalls = 0;
    await expect(
      runChannelAReadWithFreshHandleRetry(
        async () => {
          unavailableCalls += 1;
          throw new ChannelAUnavailableError("provider still unavailable");
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(ChannelAUnavailableError);
    expect(unavailableCalls).toBe(2);

    let validationCalls = 0;
    let refreshCalls = 0;
    const validation = new ChannelAValidationError("bad path");
    await expect(
      runChannelAReadWithFreshHandleRetry(
        async () => {
          validationCalls += 1;
          throw validation;
        },
        async () => {
          refreshCalls += 1;
        },
      ),
    ).rejects.toBe(validation);
    expect(validationCalls).toBe(1);
    expect(refreshCalls).toBe(0);

    let mixedCalls = 0;
    let mixedRefreshes = 0;
    const conflict = new ChannelAConflictError("lease changed");
    await expect(
      runChannelAReadWithFreshHandleRetry(
        async () => {
          mixedCalls += 1;
          if (mixedCalls === 1) {
            throw new ChannelAUnavailableError("provider rollover started");
          }
          throw conflict;
        },
        async () => {
          mixedRefreshes += 1;
        },
        { maxFreshHandleRetries: 2 },
      ),
    ).rejects.toBe(conflict);
    expect(mixedCalls).toBe(2);
    expect(mixedRefreshes).toBe(1);
  });

  test("Modal recovery stops after exactly two fresh handles", async () => {
    const refreshAttempts: number[] = [];
    let calls = 0;
    await expect(
      runChannelAReadWithFreshHandleRetry(
        async () => {
          calls += 1;
          throw new ChannelAUnavailableError("provider remains unavailable");
        },
        async (attempt) => {
          refreshAttempts.push(attempt);
        },
        { maxFreshHandleRetries: 2 },
      ),
    ).rejects.toBeInstanceOf(ChannelAUnavailableError);
    expect(calls).toBe(3);
    expect(refreshAttempts).toEqual([1, 2]);
  });

  test("request cancellation prevents another handle refresh or provider command", async () => {
    const controller = new AbortController();
    const cancelled = new DOMException("request ended", "AbortError");
    let runs = 0;
    let refreshes = 0;
    await expect(
      runChannelAReadWithFreshHandleRetry(
        async () => {
          runs += 1;
          controller.abort(cancelled);
          throw new ChannelAUnavailableError("provider unavailable during disconnect");
        },
        async () => {
          refreshes += 1;
        },
        { maxFreshHandleRetries: 2, waitSignal: controller.signal },
      ),
    ).rejects.toBe(cancelled);
    expect(runs).toBe(1);
    expect(refreshes).toBe(0);

    const duringRefresh = new AbortController();
    const cancelledDuringRefresh = new DOMException("request ended during refresh", "AbortError");
    runs = 0;
    refreshes = 0;
    await expect(
      runChannelAReadWithFreshHandleRetry(
        async () => {
          runs += 1;
          throw new ChannelAUnavailableError("provider unavailable");
        },
        async () => {
          refreshes += 1;
          duringRefresh.abort(cancelledDuringRefresh);
        },
        { maxFreshHandleRetries: 2, waitSignal: duringRefresh.signal },
      ),
    ).rejects.toBe(cancelledDuringRefresh);
    expect(runs).toBe(1);
    expect(refreshes).toBe(1);
  });

  test("transport failures evict disposable reads but preserve process-capable wrappers", () => {
    const unavailable = new ChannelAUnavailableError("provider transport unavailable");
    expect(shouldEvictChannelAHandleAfterError(unavailable, "read")).toBe(true);
    expect(shouldEvictChannelAHandleAfterError(unavailable, "process")).toBe(false);
    expect(shouldEvictChannelAHandleAfterError(unavailable, "none")).toBe(false);
    expect(
      shouldEvictChannelAHandleAfterError(new ChannelAValidationError("bad path"), "read"),
    ).toBe(false);
  });

  test("near-identical non-transient reads are never retried", async () => {
    let calls = 0;
    const failure = new ChannelAValidationError("bad path");
    await expect(
      runConcurrentChannelAReads([
        async () => {
          calls += 1;
          throw failure;
        },
        async () => "sibling",
      ]),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
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

  test("Channel-A commands select the session-specific Toolspace token pointer", () => {
    const credentialAt = channelASeam.indexOf("withRunCredentialsSession(");
    const deriveAt = channelASeam.indexOf("toolspaceTokenFileFromEnvironment(");
    const decorateAt = channelASeam.indexOf("withToolspaceTokenSession(");
    const serviceAt = channelASeam.indexOf("new SandboxChannelAService(");

    expect(credentialAt).toBeGreaterThanOrEqual(0);
    expect(deriveAt).toBeGreaterThan(credentialAt);
    expect(decorateAt).toBeGreaterThan(credentialAt);
    expect(decorateAt).toBeLessThan(serviceAt);
    expect(channelASeam.slice(decorateAt, serviceAt)).toContain("session.id");
    expect(channelASeam.slice(serviceAt, serviceAt + 300)).toContain("session: scopedSession");
  });

  test("the PTY write route adopts the exact durable process identity", () => {
    const body = handlerBody(
      sessionsRoute,
      "post",
      "/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty/write",
    );
    expect(body).toContain("getOpenPtySession");
    expect(body).toContain("adoptPtyProcess");
    expect(body).toContain("pty.execSessionId");
    expect(sessionsRoute).toContain("pty retained-process identity is stale; reopen the terminal");
    expect(body).not.toContain("execSessionId === null");
  });
});
