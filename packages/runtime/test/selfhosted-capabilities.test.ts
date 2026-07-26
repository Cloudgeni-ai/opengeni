import { describe, expect, test } from "bun:test";
import {
  MockAgentResponder,
  SelfhostedSession,
  type SelfhostedEnrollment,
  negotiateSelfhostedCapabilities,
  selfhostedLiveness,
} from "../src/sandbox";

const SESSION_ID = "00000000-0000-0000-0000-0000000000aa";
const NOW = new Date("2026-06-22T12:00:00.000Z");
const RELAY = { host: "relay.test", port: 443, tls: true } as const;

function enrollment(overrides: Partial<SelfhostedEnrollment> = {}): SelfhostedEnrollment {
  return {
    status: "active",
    exposure: "whole-machine",
    allowScreenControl: true,
    hasDisplay: true,
    lastSeenAt: NOW.toISOString(),
    wentOfflineAt: null,
    wentOfflineReason: null,
    ...overrides,
  };
}

function session(online: boolean): SelfhostedSession {
  return new SelfhostedSession({
    workspaceId: "ws",
    agentId: "a",
    controlRpc: new MockAgentResponder({ online }),
    relay: RELAY,
  });
}

describe("selfhostedLiveness — the online/reconnecting/offline derivation", () => {
  test("no enrollment → offline", () => {
    expect(selfhostedLiveness({ enrollment: null, probeResponded: false }).state).toBe("offline");
  });

  test("revoked enrollment → offline", () => {
    expect(
      selfhostedLiveness({ enrollment: enrollment({ status: "revoked" }), probeResponded: true })
        .state,
    ).toBe("offline");
  });

  test("probe responds → online (+ consent/display flags derived from the row)", () => {
    const live = selfhostedLiveness({ enrollment: enrollment(), probeResponded: true });
    expect(live.state).toBe("online");
    expect(live.consented).toBe(true);
    expect(live.hasDisplay).toBe(true);
  });

  test("probe missed but lastSeenAt recent → reconnecting (a transient blip)", () => {
    const live = selfhostedLiveness({
      enrollment: enrollment({ lastSeenAt: new Date(NOW.getTime() - 5_000).toISOString() }),
      probeResponded: false,
      now: NOW,
    });
    expect(live.state).toBe("reconnecting");
  });

  test("probe missed and lastSeenAt stale → offline", () => {
    const live = selfhostedLiveness({
      enrollment: enrollment({ lastSeenAt: new Date(NOW.getTime() - 120_000).toISOString() }),
      probeResponded: false,
      now: NOW,
    });
    expect(live.state).toBe("offline");
  });

  test("probe missed and never seen → offline", () => {
    const live = selfhostedLiveness({
      enrollment: enrollment({ lastSeenAt: null }),
      probeResponded: false,
      now: NOW,
    });
    expect(live.state).toBe("offline");
  });

  test("an un-cleared clean goodbye reads OFFLINE even with a fresh lastSeenAt AND a responding probe", () => {
    // The #348 fix: an announced GoingOffline must read offline immediately, taking
    // precedence over both last_seen aging (fresh) and a lingering probe (responds).
    const live = selfhostedLiveness({
      enrollment: enrollment({
        lastSeenAt: NOW.toISOString(),
        wentOfflineAt: NOW.toISOString(),
        wentOfflineReason: "GOING_OFFLINE_REASON_HOST_SHUTDOWN",
      }),
      probeResponded: true,
      now: NOW,
    });
    expect(live.state).toBe("offline");
    // consent/display flags are still derived from the row (the machine's config
    // didn't change — only its reachability).
    expect(live.consented).toBe(true);
    expect(live.hasDisplay).toBe(true);
  });

  test("revoked STILL trumps a goodbye marker (revoked + wentOfflineAt → offline, flags cleared)", () => {
    const live = selfhostedLiveness({
      enrollment: enrollment({ status: "revoked", wentOfflineAt: NOW.toISOString() }),
      probeResponded: true,
    });
    expect(live.state).toBe("offline");
    // The revoked branch returns before deriving consent/display from the row.
    expect(live.consented).toBe(false);
    expect(live.hasDisplay).toBe(false);
  });

  test("a CLEARED marker (wentOfflineAt back to null) reads ONLINE again on a probe response", () => {
    // Completes the round-trip at the derivation level: once a newer liveness signal
    // clears the marker in the row, the machine reads online again exactly as before.
    const live = selfhostedLiveness({
      enrollment: enrollment({ wentOfflineAt: null, wentOfflineReason: null }),
      probeResponded: true,
      now: NOW,
    });
    expect(live.state).toBe("online");
  });
});

describe("negotiateSelfhostedCapabilities — every cell decided correctly", () => {
  test("ONLINE + displayed + consented: full surface available, no liveness reason", async () => {
    const caps = await negotiateSelfhostedCapabilities({
      sessionId: SESSION_ID,
      leaseEpoch: 1,
      enrollment: enrollment(),
      session: session(true),
      now: NOW,
    });
    expect(caps.backend).toBe("selfhosted");
    expect(caps.FileSystem.available).toBe(true);
    expect(caps.FileSystem.reason).toBeNull();
    expect(caps.Git.available).toBe(true);
    expect(caps.Terminal.transport).toBe("pty-ws");
    // Selfhosted desktop is the RELAY framebuffer (PNG-per-frame), rendered by the
    // "frames" canvas client — never noVNC (that's Modal's x11vnc path).
    expect(caps.DesktopStream.transport).toBe("relay-frames");
    expect(caps.DesktopStream.reason).toBeNull();
    expect(caps.ComputerUse.available).toBe(true);
    expect(caps.Recording.available).toBe(true);
  });

  test("OFFLINE (no enrollment): every cell agent_offline", async () => {
    const caps = await negotiateSelfhostedCapabilities({
      sessionId: SESSION_ID,
      leaseEpoch: 1,
      enrollment: null,
      probeResponded: false,
      now: NOW,
    });
    expect(caps.FileSystem.available).toBe(false);
    expect(caps.FileSystem.reason).toBe("agent_offline");
    expect(caps.Terminal.transport).toBeNull();
    expect(caps.Terminal.reason).toBe("agent_offline");
    expect(caps.Git.reason).toBe("agent_offline");
    expect(caps.DesktopStream.transport).toBeNull();
    expect(caps.DesktopStream.reason).toBe("agent_offline");
    expect(caps.Recording.reason).toBe("agent_offline");
    expect(caps.ComputerUse.reason).toBe("agent_offline");
  });

  test("OFFLINE (enrolled but no responder, stale): every cell agent_offline", async () => {
    const caps = await negotiateSelfhostedCapabilities({
      sessionId: SESSION_ID,
      leaseEpoch: 1,
      enrollment: enrollment({ lastSeenAt: new Date(NOW.getTime() - 120_000).toISOString() }),
      session: session(false),
      now: NOW,
    });
    expect(caps.FileSystem.reason).toBe("agent_offline");
    expect(caps.DesktopStream.reason).toBe("agent_offline");
  });

  test("RECONNECTING (recent lastSeenAt, probe missed): every cell agent_reconnecting", async () => {
    const caps = await negotiateSelfhostedCapabilities({
      sessionId: SESSION_ID,
      leaseEpoch: 1,
      enrollment: enrollment({ lastSeenAt: new Date(NOW.getTime() - 5_000).toISOString() }),
      session: session(false),
      now: NOW,
    });
    expect(caps.FileSystem.reason).toBe("agent_reconnecting");
    expect(caps.Terminal.reason).toBe("agent_reconnecting");
    expect(caps.Git.reason).toBe("agent_reconnecting");
    expect(caps.DesktopStream.reason).toBe("agent_reconnecting");
    expect(caps.ComputerUse.reason).toBe("agent_reconnecting");
  });

  test("CONSENT_REQUIRED (online + displayed but not consented): VIEW (read-only) + Recording stay available, only CONTROL is gated", async () => {
    const caps = await negotiateSelfhostedCapabilities({
      sessionId: SESSION_ID,
      leaseEpoch: 1,
      enrollment: enrollment({ allowScreenControl: false }),
      session: session(true),
      now: NOW,
    });
    // The machine is reachable: FS/Terminal/Git stay available.
    expect(caps.FileSystem.available).toBe(true);
    expect(caps.Terminal.transport).toBe("pty-ws");
    expect(caps.Git.available).toBe(true);
    // VIEW decouples from CONTROL: with a display alone the screen can be VIEWED
    // (read-only stream) + RECORDED — the agent already has whole-machine exec, so
    // passive viewing adds no capability. Only INPUT (ComputerUse / an interactive
    // stream) requires the explicit allowScreenControl consent.
    expect(caps.DesktopStream.transport).toBe("relay-frames");
    expect(caps.DesktopStream.mode).toBe("read-only");
    expect(caps.DesktopStream.reason).toBeNull();
    expect(caps.Recording.available).toBe(true);
    expect(caps.Recording.reason).toBeNull();
    expect(caps.ComputerUse.available).toBe(false);
    expect(caps.ComputerUse.reason).toBe("consent_required");
  });

  test("DISPLAY_UNAVAILABLE (online but headless, no display): desktop degraded, Channel-A available", async () => {
    const caps = await negotiateSelfhostedCapabilities({
      sessionId: SESSION_ID,
      leaseEpoch: 1,
      enrollment: enrollment({ hasDisplay: false }),
      session: session(true),
      now: NOW,
    });
    expect(caps.FileSystem.available).toBe(true);
    expect(caps.Terminal.transport).toBe("pty-ws");
    expect(caps.DesktopStream.transport).toBeNull();
    expect(caps.DesktopStream.reason).toBe("display_unavailable");
    expect(caps.ComputerUse.available).toBe(false);
    expect(caps.ComputerUse.reason).toBe("display_unavailable");
    expect(caps.Recording.reason).toBe("display_unavailable");
  });

  test("display_unavailable takes precedence over consent_required when both missing", async () => {
    const caps = await negotiateSelfhostedCapabilities({
      sessionId: SESSION_ID,
      leaseEpoch: 1,
      enrollment: enrollment({ hasDisplay: false, allowScreenControl: false }),
      session: session(true),
      now: NOW,
    });
    expect(caps.DesktopStream.reason).toBe("display_unavailable");
  });

  test("desktop disabled by policy still wins over the selfhosted display gate (base reason preserved)", async () => {
    const caps = await negotiateSelfhostedCapabilities({
      sessionId: SESSION_ID,
      leaseEpoch: 1,
      enrollment: enrollment(),
      session: session(true),
      desktopEnabled: false,
      now: NOW,
    });
    // The base negotiation already degraded the desktop; we don't override it.
    expect(caps.DesktopStream.transport).toBeNull();
    expect(caps.DesktopStream.reason).toBe("disabled_by_policy");
  });

  test("every cell is present with a null-or-string reason (never absent) in every state", async () => {
    for (const e of [
      null,
      enrollment(),
      enrollment({ allowScreenControl: false }),
      enrollment({ hasDisplay: false }),
      enrollment({ lastSeenAt: new Date(NOW.getTime() - 5_000).toISOString() }),
    ]) {
      const caps = await negotiateSelfhostedCapabilities({
        sessionId: SESSION_ID,
        leaseEpoch: 2,
        enrollment: e,
        session: session(Boolean(e)),
        now: NOW,
      });
      for (const cell of [
        caps.FileSystem,
        caps.Terminal,
        caps.Git,
        caps.DesktopStream,
        caps.Recording,
        caps.ComputerUse,
      ]) {
        expect(cell.reason === null || typeof cell.reason === "string").toBe(true);
      }
      expect(caps.leaseEpoch).toBe(2);
    }
  });
});
