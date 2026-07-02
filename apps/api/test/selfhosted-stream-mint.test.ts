import { afterAll, describe, expect, mock, test } from "bun:test";
import { resolveStreamTokenSecret } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import { verifyStreamToken } from "@opengeni/runtime/sandbox";
import { mintSelfhostedStream, resolveActiveDesktopTransport } from "../src/sandbox/viewer";

// M8b — the SELFHOSTED relay stream-mint seam (viewer.ts mintSelfhostedStream).
//
// The CRITICAL property: the minted `ogs_` token is fenced by the swap
// `active_epoch` (NOT the Modal lease epoch). The relay's stale-viewer fence uses
// the token's leaseEpoch claim, so a viewer whose token predates a swap-away (a
// lower active_epoch) is rejected — it cannot reach the machine the session swapped
// off of. control ops are already active-epoch-fenced; this closes the STREAM side.
//
// We drive mintSelfhostedStream with a FAKE selfhosted session whose
// resolveExposedPort returns the relay endpoint shape (no live agent/relay needed),
// and assert the minted token verifies + carries active_epoch as its fence.
//
// The second suite (below) tests the selfhosted-active dispatch path in
// mintTerminalStream and mintDesktopStream via the `resolveSelfhostedSession`
// test seam + a mock.module stub for getSandbox (the sandbox kind lookup).

const WS = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const VIEWER = "33333333-3333-4333-8333-333333333333";
const ACTIVE_SANDBOX = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";

/** A fake selfhosted session: only the structural `resolveExposedPort` the relay
 *  stream-mint reads (returns the relay URL shape the real SelfhostedSession does). */
function fakeSelfhostedSession(port: number) {
  return {
    resolveExposedPort: async (p: number) => ({
      host: "relay.opengeni.test",
      port: 443,
      tls: true,
      path: "/stream",
      query: `ws=${WS}&agent=${AGENT}&port=${p}&channel=ch-abc`,
      protocol: port === 6080 ? "vnc" : "pty",
    }),
  };
}

// Mock @opengeni/db so getSandbox returns a controllable sandbox record for the
// test workspace. Spreads all real exports so other test files sharing this
// process are unaffected (only WS is intercepted).
const realDb = await import("@opengeni/db");
const realGetSandbox = realDb.getSandbox;
mock.module("@opengeni/db", () => ({
  ...realDb,
  getSandbox: async (db: never, workspaceId: string, sandboxId: string) => {
    if (workspaceId !== WS) {
      return realGetSandbox(db, workspaceId, sandboxId);
    }
    if (sandboxId === ACTIVE_SANDBOX) {
      return {
        id: ACTIVE_SANDBOX,
        accountId: "acc",
        workspaceId: WS,
        kind: "selfhosted",
        name: "test-machine",
        enrollmentId: AGENT,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    return null;
  },
}));

// Import mints AFTER the db mock is installed so the mock binding is active.
const { mintTerminalStream, mintDesktopStream } = await import("../src/sandbox/viewer");

afterAll(() => {
  mock.restore();
});

describe("mintSelfhostedStream — relay stream cell fenced by active_epoch (M8b)", () => {
  const settings = testSettings({ streamTokenSecret: "selfhosted-stream-secret" });

  test("mints a relay-URL cell whose ogs_ token is fenced by the swap active_epoch", async () => {
    const activeEpoch = 9;
    const cell = await mintSelfhostedStream(
      { db: {} as never, settings },
      {
        workspaceId: WS,
        sessionId: SESSION,
        viewerId: VIEWER,
        activeEpoch,
        port: 6080,
        session: fakeSelfhostedSession(6080),
      },
    );
    expect(cell).not.toBeNull();
    // The URL points at the relay /stream route with the channel-key routing query.
    expect(cell?.url).toBe(
      `wss://relay.opengeni.test/stream?ws=${WS}&agent=${AGENT}&port=6080&channel=ch-abc`,
    );
    // The token verifies AND its leaseEpoch claim == the swap active_epoch (the
    // relay's stale-viewer fence floor).
    const secret = resolveStreamTokenSecret(settings)!;
    const claims = await verifyStreamToken(secret, cell!.token);
    expect(claims).not.toBeNull();
    expect(claims?.leaseEpoch).toBe(activeEpoch);
    expect(claims?.workspaceId).toBe(WS);
    expect(cell?.leaseEpoch).toBe(activeEpoch);
    // The token is NEVER appended to the URL (recorded against the holder instead).
    expect(cell?.url).not.toContain(cell!.token);
  });

  test("degrades to null when the stream-token secret is unconfigured", async () => {
    const noSecret = testSettings({ streamTokenSecret: undefined, delegationSecret: undefined });
    const cell = await mintSelfhostedStream(
      { db: {} as never, settings: noSecret },
      {
        workspaceId: WS,
        sessionId: SESSION,
        viewerId: VIEWER,
        activeEpoch: 1,
        port: 7681,
        session: fakeSelfhostedSession(7681),
      },
    );
    expect(cell).toBeNull();
  });

  test("degrades to null when the session cannot resolve a relay port (agent offline)", async () => {
    const cell = await mintSelfhostedStream(
      { db: {} as never, settings },
      {
        workspaceId: WS,
        sessionId: SESSION,
        viewerId: VIEWER,
        activeEpoch: 1,
        port: 6080,
        session: {
          resolveExposedPort: async () => {
            throw new Error("agent offline");
          },
        },
      },
    );
    expect(cell).toBeNull();
  });
});

// Base session shape shared by the active-selfhosted dispatch tests.
const baseSession = {
  id: SESSION,
  workspaceId: WS,
  sandboxBackend: "modal" as const,
  sandboxOs: "linux" as const,
  sandboxGroupId: "gg-1",
  activeSandboxId: ACTIVE_SANDBOX,
  activeEpoch: 7,
  // Minimal remaining Session fields (types require them but mints don't read them).
  accountId: "acc",
  environmentId: null,
  status: "idle" as const,
  goal: null,
  goalStatus: null,
  goalUpdatedAt: null,
  repoFullName: null,
  repoBranch: null,
  repoCommitSha: null,
  repoInstallationId: null,
  title: null,
  titleSource: null,
  instructions: null,
  errorCode: null,
  errorMessage: null,
  queuedTurnId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// A `resolveSelfhostedSession` seam: returns a fake relay-resolving session
// without hitting a real NATS bus or agent.
function fakeResolveSession(port: number) {
  return async (_sandbox: unknown) => fakeSelfhostedSession(port);
}

describe("mintTerminalStream / mintDesktopStream — selfhosted-active dispatch (M8b wiring)", () => {
  const settings = testSettings({
    streamTokenSecret: "selfhosted-stream-secret",
    sandboxTerminalEnabled: true,
    sandboxDesktopEnabled: true,
  });
  const services = { db: {} as never, settings };

  test("mintTerminalStream: routes to relay when activeSandboxId is selfhosted", async () => {
    const cell = await mintTerminalStream(services, {
      accountId: "acc",
      workspaceId: WS,
      session: baseSession as never,
      viewerId: VIEWER,
      resolveSelfhostedSession: fakeResolveSession(7681),
    });
    expect(cell).not.toBeNull();
    // URL must be the relay wss:// shape (NOT a Modal tunnel URL).
    expect(cell?.url).toBe(
      `wss://relay.opengeni.test/stream?ws=${WS}&agent=${AGENT}&port=7681&channel=ch-abc`,
    );
    // Token is fenced by the session's activeEpoch (7), not a Modal lease epoch.
    const secret = resolveStreamTokenSecret(settings)!;
    const claims = await verifyStreamToken(secret, cell!.token);
    expect(claims?.leaseEpoch).toBe(7);
    expect(cell?.leaseEpoch).toBe(7);
    expect(cell?.url).not.toContain(cell!.token);
  });

  test("mintDesktopStream: routes to relay when activeSandboxId is selfhosted + attaches resolution", async () => {
    const cell = await mintDesktopStream(services, {
      accountId: "acc",
      workspaceId: WS,
      session: baseSession as never,
      viewerId: VIEWER,
      resolveSelfhostedSession: fakeResolveSession(6080),
    });
    expect(cell).not.toBeNull();
    expect(cell?.url).toBe(
      `wss://relay.opengeni.test/stream?ws=${WS}&agent=${AGENT}&port=6080&channel=ch-abc`,
    );
    const secret = resolveStreamTokenSecret(settings)!;
    const claims = await verifyStreamToken(secret, cell!.token);
    expect(claims?.leaseEpoch).toBe(7);
    expect(cell?.leaseEpoch).toBe(7);
    // Desktop cell must carry resolution.
    expect(cell?.resolution).toBeDefined();
    expect(Array.isArray(cell?.resolution)).toBe(true);
  });

  test("mintTerminalStream: no selfhosted branch when activeSandboxId is null (cold Modal path → null on absent lease)", async () => {
    const cell = await mintTerminalStream(services, {
      accountId: "acc",
      workspaceId: WS,
      session: { ...baseSession, activeSandboxId: null } as never,
      viewerId: VIEWER,
      // No lease → GATE 2 returns null (Modal path, not selfhosted).
    });
    expect(cell).toBeNull();
  });
});

// The swap-case transport advertisement invariant: the advertised wire transport MUST
// match where mintDesktopStream routed the pixels (relay IFF the active sandbox is a
// selfhosted machine), in BOTH swap directions. A mismatch is the "desktop stream
// closed before it opened" bug — the client picked the wrong renderer for the URL.
describe("resolveActiveDesktopTransport — advertisement matches active-sandbox routing (both swap directions)", () => {
  test("selfhosted-active → RELAY framebuffer (relay-frames/frames, view-only)", () => {
    // modal-HOME swapped onto a machine, OR a machine-primary session.
    expect(resolveActiveDesktopTransport(true, true)).toEqual({ transport: "relay-frames", client: "frames", mode: "read-only" });
    // interactive policy is irrelevant for the relay framebuffer (view-only in v1).
    expect(resolveActiveDesktopTransport(true, false)).toEqual({ transport: "relay-frames", client: "frames", mode: "read-only" });
  });

  test("NOT selfhosted-active → Modal noVNC (vnc-ws/novnc); THE swap-away fix", () => {
    // selfhosted-HOME swapped AWAY to the cloud group box (activeSandboxId=null or a
    // non-selfhosted active sandbox): must be the Modal noVNC tunnel, NOT relay-frames.
    expect(resolveActiveDesktopTransport(false, true)).toEqual({ transport: "vnc-ws", client: "novnc", mode: "interactive" });
    // take-control disabled by deployment policy → read-only noVNC.
    expect(resolveActiveDesktopTransport(false, false)).toEqual({ transport: "vnc-ws", client: "novnc", mode: "read-only" });
  });
});
