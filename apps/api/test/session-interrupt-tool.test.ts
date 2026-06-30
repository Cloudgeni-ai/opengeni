// session_interrupt — the first-party MCP tool that lets a manager holding
// `sessions:control` STOP (cancel turn + pause goal) or STEER (cancel turn,
// keep goal → next queued turn runs) a workspace session it spawned.
//
// A mock-deps UNIT test (no live DB / Temporal): `@opengeni/db.requireSession`
// and `@opengeni/events.appendAndPublishEvents` are replaced with RESTORABLE
// spies (spyOn + `mock.restore()` in afterAll), NOT a `mock.module` — the latter
// is process-global and sticky in bun, so with no teardown it would leak these
// mocked seams into every later test file in the suite. The workflow client's
// `signalInterrupt` is a spy too. That lets us build the real
// `buildOpenGeniMcpServer` and drive the actual tool handler, then tear the
// spies back down before any other file runs.
//
// Proves:
//   - REGISTRATION GATING: `session_interrupt` is registered iff the grant
//     carries `sessions:control` (a `sessions:read`-only grant does not see it).
//   - HANDLER: appends a `user.interrupt` event with payload {reason:"steer"}
//     for mode:"steer" and {} otherwise, then signals the interrupt with the
//     APPENDED event's id (mirroring the REST /events route).

import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import * as dbMod from "@opengeni/db";
import * as eventsMod from "@opengeni/events";
import type { ApiRouteDeps } from "@opengeni/core";

// ── recorded interactions of the mocked seams ────────────────────────────────
type AppendCall = { workspaceId: string; sessionId: string; events: Array<{ type: string; payload?: unknown }> };
type SignalCall = { accountId: string; workspaceId: string; sessionId: string; eventId: string; workflowId: string };

const appendCalls: AppendCall[] = [];
const requireSessionCalls: Array<{ workspaceId: string; sessionId: string }> = [];
const signalCalls: SignalCall[] = [];

// The id the mocked append hands back; the handler MUST thread exactly this into
// signalInterrupt (never the incoming sessionId or a fresh id).
const APPENDED_EVENT_ID = "11111111-2222-4333-8444-555555555555";

let buildOpenGeniMcpServer: (typeof import("../src/mcp/server"))["buildOpenGeniMcpServer"];

beforeAll(async () => {
  // Replace ONLY the two DB-touching seams with restorable spies. spyOn patches
  // the named export in place, so server.ts's `import { requireSession } from
  // "@opengeni/db"` (a live binding) calls through the spy — every other export
  // it and its transitive deps rely on is the real thing, untouched. Crucially,
  // spyOn is fully reverted by `mock.restore()` (see afterAll), unlike the
  // process-global, non-restoring `mock.module`.
  spyOn(dbMod, "requireSession").mockImplementation(async (_db, workspaceId, sessionId) => {
    requireSessionCalls.push({ workspaceId, sessionId });
    return { id: sessionId, workspaceId, status: "running" } as unknown as Awaited<ReturnType<typeof dbMod.requireSession>>;
  });
  spyOn(eventsMod, "appendAndPublishEvents").mockImplementation(async (_db, _bus, workspaceId, sessionId, events) => {
    appendCalls.push({ workspaceId, sessionId, events: events as AppendCall["events"] });
    // Return a persisted-event shape carrying the id the handler must reuse.
    return [{ id: APPENDED_EVENT_ID, workspaceId, sessionId, sequence: 1, type: events[0]?.type, payload: events[0]?.payload ?? {}, occurredAt: new Date().toISOString() }] as unknown as Awaited<ReturnType<typeof eventsMod.appendAndPublishEvents>>;
  });
  ({ buildOpenGeniMcpServer } = await import("../src/mcp/server"));
});

afterAll(() => {
  // Restore the real requireSession / appendAndPublishEvents BEFORE any other
  // test file in the suite runs. This is the whole point of the fix: without it
  // the mocked seams leak (a mocked appendAndPublishEvents that returns a single
  // fake event breaks the real-DB sandbox integration tests with a 500 "failed
  // to append initial user event").
  mock.restore();
});

beforeEach(() => {
  appendCalls.length = 0;
  requireSessionCalls.length = 0;
  signalCalls.length = 0;
});

const WORKSPACE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ACCOUNT_ID = "99999999-8888-4777-8666-555555555555";
const TARGET_SESSION_ID = "12121212-3434-4565-8787-909090909090";

function grantWith(permissions: Permission[]): AccessGrant {
  return {
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    subjectId: "manager-session",
    permissions,
    // No sessionId claim → set_session_title / goal / fleet tools stay off; we
    // exercise the workspace-orchestration surface only.
    metadata: {},
  };
}

function depsWithSignalSpy(): ApiRouteDeps {
  const workflowClient = {
    signalInterrupt: async (input: SignalCall) => {
      signalCalls.push(input);
    },
  };
  return {
    settings: testSettings({ productAccessMode: "managed" }),
    db: {} as unknown,
    bus: {} as unknown,
    workflowClient,
    objectStorage: undefined,
  } as unknown as ApiRouteDeps;
}

/** The SDK stores tools in a private `_registeredTools` map keyed by name. */
function registeredTools(server: unknown): Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> {
  return (server as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> })._registeredTools;
}

describe("session_interrupt registration gating", () => {
  test("is registered when the grant carries sessions:control", () => {
    const server = buildOpenGeniMcpServer(depsWithSignalSpy(), grantWith(["sessions:control"]));
    expect(registeredTools(server)["session_interrupt"]).toBeDefined();
    // Sanity: its sibling under the same gate is present too.
    expect(registeredTools(server)["session_send_message"]).toBeDefined();
  });

  test("is NOT registered when the grant lacks sessions:control", () => {
    const server = buildOpenGeniMcpServer(depsWithSignalSpy(), grantWith(["sessions:read"]));
    expect(registeredTools(server)["session_interrupt"]).toBeUndefined();
    // The read-only grant still sees its own tools — proving the gap is
    // specifically the sessions:control gate, not an empty server.
    expect(registeredTools(server)["sessions_list"]).toBeDefined();
  });
});

describe("session_interrupt handler", () => {
  test("mode:'steer' appends {reason:'steer'} and signals with the appended event id", async () => {
    const server = buildOpenGeniMcpServer(depsWithSignalSpy(), grantWith(["sessions:control"]));
    await registeredTools(server)["session_interrupt"]!.handler({ sessionId: TARGET_SESSION_ID, mode: "steer" }, {});

    expect(requireSessionCalls).toEqual([{ workspaceId: WORKSPACE_ID, sessionId: TARGET_SESSION_ID }]);
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.sessionId).toBe(TARGET_SESSION_ID);
    expect(appendCalls[0]!.events).toEqual([{ type: "user.interrupt", payload: { reason: "steer" } }]);

    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      sessionId: TARGET_SESSION_ID,
      eventId: APPENDED_EVENT_ID,
    });
    expect(typeof signalCalls[0]!.workflowId).toBe("string");
    expect(signalCalls[0]!.workflowId.length).toBeGreaterThan(0);
  });

  test("default mode (stop) appends an empty payload and still signals the interrupt", async () => {
    const server = buildOpenGeniMcpServer(depsWithSignalSpy(), grantWith(["sessions:control"]));
    await registeredTools(server)["session_interrupt"]!.handler({ sessionId: TARGET_SESSION_ID }, {});

    expect(appendCalls[0]!.events).toEqual([{ type: "user.interrupt", payload: {} }]);
    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0]!.eventId).toBe(APPENDED_EVENT_ID);
  });
});
