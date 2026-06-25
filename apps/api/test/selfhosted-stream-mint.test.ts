import { describe, expect, test } from "bun:test";
import { resolveStreamTokenSecret } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import { verifyStreamToken } from "@opengeni/runtime/sandbox";
import { mintSelfhostedStream } from "../src/sandbox/viewer";

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

const WS = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
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

describe("mintSelfhostedStream — relay stream cell fenced by active_epoch (M8b)", () => {
  const settings = testSettings({ streamTokenSecret: "selfhosted-stream-secret" });

  test("mints a relay-URL cell whose ogs_ token is fenced by the swap active_epoch", async () => {
    const activeEpoch = 9;
    const cell = await mintSelfhostedStream(
      { db: {} as never, settings },
      {
        workspaceId: WS,
        sessionId: SESSION,
        viewerId: "33333333-3333-4333-8333-333333333333",
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
        viewerId: "33333333-3333-4333-8333-333333333333",
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
        viewerId: "33333333-3333-4333-8333-333333333333",
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
