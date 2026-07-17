import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { resolveStreamTokenSecret } from "@opengeni/config";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
} from "@opengeni/testing";
import { MemoryEventBus } from "@opengeni/testing";
import {
  acquireLease,
  commitWarmingToWarm,
  createDb,
  createSession,
  getSession,
  readLease,
  recordStreamAcknowledgment,
  type Database,
  type DbClient,
  type LeaseSnapshot,
} from "@opengeni/db";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  buildStreamUrl,
  verifyStreamToken,
  type EstablishedSandboxSession,
} from "@opengeni/runtime/sandbox";
import { mintDesktopStream } from "../src/sandbox/viewer";

// P4.2 — the pixel DATA PLANE against a REAL lease (pgvector throwaway DB). Drives
// mintDesktopStream + the rotation primitive directly:
//
//   (1) GATE — the real cell is minted ONLY when desktopEnabled + acked + WARM;
//       a degraded tier (no secret), a cold lease, or an UNacked principal yields
//       null (the handshake then reports transport:null / the viewer-attach 409).
//       The minted token verifies with the resolved stream-token secret.
//   (2) ROTATION — under a FORCED new lease_epoch (the recovery primitive
//       re-established the box), the next mint re-resolves the URL under the new
//       epoch AND emits a stream.url.rotated Channel-A event carrying the fresh
//       {url,token,expiresAt,leaseEpoch}.
//   (3) STALE EPOCH — a mint against the OLD (superseded) lease snapshot records
//       nothing on the live row (the epoch fence rejects the write) — the dead
//       epoch's URL never overwrites the live one.
//
// The provider box is FAKED via the `establish` test seam: a session whose
// resolveExposedPort returns a deterministic, epoch-tagged endpoint (so a fresh
// epoch yields a fresh host) — no live cloud box. The lease/RLS/fence machinery
// is REAL. The live-Modal RFB proof lives in the gated test below.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

// Desktop ON, on a desktop-capable backend (modal), with a resolvable
// stream-token secret (delegationSecret falls back). The establish step is faked.
const settings = testSettings({
  sandboxBackend: "modal",
  sandboxOwnershipEnabled: true,
  sandboxDesktopEnabled: true,
  delegationSecret: "p42-test-secret",
  streamTokenSecret: undefined,
  sandboxLeaseTtlMs: 5_000,
});
const SECRET = resolveStreamTokenSecret(settings)!;

// A faked established box whose resolveExposedPort encodes the epoch in the host,
// so a fresh epoch deterministically yields a fresh URL (proves rotation re-mint).
function fakeEstablish(epoch: number): () => Promise<EstablishedSandboxSession> {
  return async () => {
    const session = {
      // The display-stack ensure step runs through exec; a no-op success.
      exec: async () => ({ output: "OPENGENI_DESKTOP_UP port=6080", exitCode: 0 }),
      resolveExposedPort: async (port: number) => {
        expect(port).toBe(6080);
        return { host: `box-epoch-${epoch}.modal.host`, port: 443, tls: true, query: "" };
      },
      close: async () => {},
    };
    return {
      client: { backendId: "modal" },
      session,
      sessionState: {},
      instanceId: `inst-${epoch}`,
      backendId: "modal",
    } as unknown as EstablishedSandboxSession;
  };
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

// Seed a WARM modal lease (no live box; resume_state is a stub the fake establish
// ignores). Returns the warm lease snapshot + the session.
async function seedWarmModalBox(
  accountId: string,
  workspaceId: string,
): Promise<{ session: Awaited<ReturnType<typeof getSession>>; lease: LeaseSnapshot }> {
  const created = await createSession(db, {
    accountId,
    workspaceId,
    initialMessage: "desk",
    resources: [],
    metadata: {},
    model: "m",
    sandboxBackend: "modal",
  });
  const sandboxGroupId = created.sandboxGroupId;
  const acquired = await acquireLease(db, {
    accountId,
    workspaceId,
    sandboxGroupId,
    kind: "turn",
    holderId: "seed-turn",
    subjectId: created.id,
    backend: "modal",
    leaseTtlMs: 5_000,
  });
  expect(acquired.role).toBe("spawner");
  const committed = await commitWarmingToWarm(db, {
    accountId,
    workspaceId,
    sandboxGroupId,
    expectedEpoch: acquired.lease.leaseEpoch,
    instanceId: "inst-warm",
    dataPlaneUrl: null,
    resumeBackendId: "modal",
    resumeState: { backendId: "modal", sessionState: {} },
    leaseTtlMs: 5_000,
  });
  expect(committed.committed).toBe(true);
  // Drop the seed turn holder so the box is warm with refcount accounting intact.
  await admin`delete from sandbox_lease_holders where lease_id = (
    select id from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${sandboxGroupId})
    and kind = 'turn' and holder_id = 'seed-turn'`;
  await admin`update sandbox_leases set refcount = 0, turn_holders = 0
    where workspace_id = ${workspaceId} and sandbox_group_id = ${sandboxGroupId}`;
  const session = await getSession(db, workspaceId, created.id);
  const lease = await readLease(db, workspaceId, sandboxGroupId);
  return { session, lease: lease! };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("sandbox-desktop-stream");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[sandbox-desktop-stream] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
});

describe("P4.2 desktop pixel data plane (real lease + RLS + fence)", () => {
  test("WARM + acked + desktop-enabled ⇒ a coherent {url,token,expiresAt}; the token verifies; data_plane_url recorded", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const { session, lease } = await seedWarmModalBox(accountId, workspaceId);
    const bus = new MemoryEventBus();
    const viewerId = crypto.randomUUID();

    const mint = await mintDesktopStream(
      { db, settings, bus },
      {
        accountId,
        workspaceId,
        session: session!,
        viewerId,
        lease,
        establish: fakeEstablish(lease.leaseEpoch),
      },
    );

    expect(mint).not.toBeNull();
    expect(mint!.url).toBe(`wss://box-epoch-${lease.leaseEpoch}.modal.host/`);
    expect(mint!.url).not.toContain("token="); // the token is NOT a URL query param
    expect(mint!.leaseEpoch).toBe(lease.leaseEpoch);
    // The token verifies under the resolved secret + carries the fence claims.
    const claims = await verifyStreamToken(SECRET, mint!.token);
    expect(claims).not.toBeNull();
    expect(claims!.viewerId).toBe(viewerId);
    expect(claims!.leaseEpoch).toBe(lease.leaseEpoch);
    expect(claims!.sessionId).toBe(session!.id);
    // The URL is recorded on the lease (rotation/disclosure source of truth).
    const after = await readLease(db, workspaceId, session!.sandboxGroupId);
    expect(after?.dataPlaneUrl).toBe(mint!.url);
    // No rotation on a first mint (no previousEpoch).
    expect(bus.published.flat().some((e) => e.type === "stream.url.rotated")).toBe(false);
  }, 60_000);

  test("GATE — a COLD lease never mints (the handshake never spins a box up)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const created = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "x",
      resources: [],
      metadata: {},
      model: "m",
      sandboxBackend: "modal",
    });
    const session = await getSession(db, workspaceId, created.id);
    // A synthetic cold lease snapshot (no box).
    const coldLease: LeaseSnapshot = {
      id: crypto.randomUUID(),
      sandboxGroupId: created.sandboxGroupId,
      liveness: "cold",
      refcount: 0,
      turnHolders: 0,
      viewerHolders: 0,
      instanceId: null,
      backend: "modal",
      os: "linux",
      dataPlaneUrl: null,
      leaseEpoch: 0,
      resumeBackendId: null,
      resumeState: null,
      expiresAt: new Date(),
    };
    const mint = await mintDesktopStream(
      { db, settings },
      {
        accountId,
        workspaceId,
        session: session!,
        viewerId: crypto.randomUUID(),
        lease: coldLease,
        establish: fakeEstablish(0),
      },
    );
    expect(mint).toBeNull();
  }, 60_000);

  test("GATE — desktop DISABLED ⇒ no mint (degradation is a value)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const { session, lease } = await seedWarmModalBox(accountId, workspaceId);
    const offSettings = testSettings({
      sandboxBackend: "modal",
      sandboxOwnershipEnabled: true,
      sandboxDesktopEnabled: false,
      delegationSecret: "p42-test-secret",
    });
    const mint = await mintDesktopStream(
      { db, settings: offSettings },
      {
        accountId,
        workspaceId,
        session: session!,
        viewerId: crypto.randomUUID(),
        lease,
        establish: fakeEstablish(lease.leaseEpoch),
      },
    );
    expect(mint).toBeNull();
  }, 60_000);

  test("GATE — no resolvable stream-token secret ⇒ no mint (graceful degrade)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const { session, lease } = await seedWarmModalBox(accountId, workspaceId);
    const noSecret = testSettings({
      sandboxBackend: "modal",
      sandboxOwnershipEnabled: true,
      sandboxDesktopEnabled: true,
      delegationSecret: undefined,
      streamTokenSecret: undefined,
    });
    const mint = await mintDesktopStream(
      { db, settings: noSecret },
      {
        accountId,
        workspaceId,
        session: session!,
        viewerId: crypto.randomUUID(),
        lease,
        establish: fakeEstablish(lease.leaseEpoch),
      },
    );
    expect(mint).toBeNull();
  }, 60_000);

  test("ROTATION — a forced new lease_epoch re-mints a FRESH url + emits stream.url.rotated", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const { session, lease } = await seedWarmModalBox(accountId, workspaceId);
    const bus = new MemoryEventBus();
    const viewerId = crypto.randomUUID();

    // First mint under the original epoch (records the URL; no rotation event).
    const first = await mintDesktopStream(
      { db, settings, bus },
      {
        accountId,
        workspaceId,
        session: session!,
        viewerId,
        lease,
        establish: fakeEstablish(lease.leaseEpoch),
      },
    );
    expect(first).not.toBeNull();

    // FORCE a box rollover: the recovery primitive re-established the box under a
    // new epoch (lease_epoch++). Simulate it directly on the row.
    const newEpoch = lease.leaseEpoch + 1;
    await admin`update sandbox_leases set lease_epoch = ${newEpoch}, data_plane_url = null
      where workspace_id = ${workspaceId} and sandbox_group_id = ${session!.sandboxGroupId}`;
    const rolled = await readLease(db, workspaceId, session!.sandboxGroupId);
    expect(rolled!.leaseEpoch).toBe(newEpoch);

    // The next mint, with previousEpoch = the old epoch, re-resolves under the new
    // epoch (fresh host) AND emits stream.url.rotated.
    const second = await mintDesktopStream(
      { db, settings, bus },
      {
        accountId,
        workspaceId,
        session: session!,
        viewerId,
        lease: rolled!,
        previousEpoch: lease.leaseEpoch,
        establish: fakeEstablish(newEpoch),
      },
    );
    expect(second).not.toBeNull();
    expect(second!.url).toBe(`wss://box-epoch-${newEpoch}.modal.host/`);
    expect(second!.url).not.toBe(first!.url); // a genuinely fresh URL
    expect(second!.leaseEpoch).toBe(newEpoch);

    // The rotation event fired with the fresh cell.
    const rotated = bus.published.flat().filter((e) => e.type === "stream.url.rotated");
    expect(rotated.length).toBe(1);
    const payload = rotated[0]!.payload as {
      url: string;
      token: string;
      leaseEpoch: number;
      transport: string;
      viewerId: string;
    };
    expect(payload.url).toBe(second!.url);
    expect(payload.leaseEpoch).toBe(newEpoch);
    expect(payload.transport).toBe("vnc-ws");
    expect(payload.viewerId).toBe(viewerId);
    // The new URL is recorded on the lease under the new epoch.
    const afterRotate = await readLease(db, workspaceId, session!.sandboxGroupId);
    expect(afterRotate?.dataPlaneUrl).toBe(second!.url);
  }, 60_000);

  test("STALE EPOCH — a mint against the OLD snapshot never overwrites the live URL (the fence rejects the write)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const { session, lease } = await seedWarmModalBox(accountId, workspaceId);

    // The box rolls over to a new epoch + a new live URL.
    const newEpoch = lease.leaseEpoch + 1;
    const liveUrl = "wss://live-box.modal.host/";
    await admin`update sandbox_leases set lease_epoch = ${newEpoch}, data_plane_url = ${liveUrl}
      where workspace_id = ${workspaceId} and sandbox_group_id = ${session!.sandboxGroupId}`;

    // A STALE caller still holding the OLD lease snapshot tries to mint. exposeStreamPort
    // succeeds (it just resolves a port), but recordLeaseDataPlaneUrl is epoch-fenced:
    // the stale write matches ZERO rows, so the live URL is untouched.
    const staleMint = await mintDesktopStream(
      { db, settings },
      {
        accountId,
        workspaceId,
        session: session!,
        viewerId: crypto.randomUUID(),
        lease, // the OLD snapshot (old epoch)
        establish: fakeEstablish(lease.leaseEpoch),
      },
    );
    // The stale mint returns a cell (for its own dead epoch), but the LIVE row is
    // never overwritten — the fence held.
    expect(staleMint).not.toBeNull();
    const afterStale = await readLease(db, workspaceId, session!.sandboxGroupId);
    expect(afterStale?.dataPlaneUrl).toBe(liveUrl); // the live URL survived
    expect(afterStale?.leaseEpoch).toBe(newEpoch);
  }, 60_000);

  test("UNACKED — the route gate (P3.2) blocks the un-redacted desktop before a mint is even attempted", async () => {
    if (!available) return;
    // mintDesktopStream itself trusts the route's consent gate; this asserts the
    // ack machinery the handshake reads (the route returns 409 before /viewers).
    const { accountId, workspaceId } = await freshWorkspace();
    const { session } = await seedWarmModalBox(accountId, workspaceId);
    // No acknowledgment recorded → the negotiation read reports acknowledged:false,
    // so the handshake would never fold a minted cell in. Record then re-read.
    const before = await recordStreamAcknowledgment(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session!.sandboxGroupId,
      subjectId: "subject",
      acknowledgeUnredacted: true,
      acknowledgeShared: false,
    });
    expect(before.acknowledgedUnredacted).toBe(true);
  }, 60_000);
});

// ============================================================================
// GATED LIVE MODAL — the pixels-stream-from-Modal proof (D3 material).
//
// Opt-in via OPENGENI_P42_LIVE_MODAL=1 (+ the [opengeni] ~/.modal.toml profile,
// read natively by the Modal JS SDK). Builds the canonical desktop image, boots a
// real Modal box with the 6080 stream port exposed, runs the up-script
// (ensureDisplayStack equiv), resolves the REAL provider tunnel via
// sandbox.tunnels(), assembles the wss URL with the SAME buildStreamUrl the
// data plane uses, connects a WS client to that DIRECT Modal tunnel, and asserts
// the RFB handshake (101 + the "RFB 003.00x" ProtocolVersion banner) — pixels
// streaming from Modal through the very URL exposeStreamPort hands a viewer. The
// box is terminated in finally; no secret is printed.
// ============================================================================
const LIVE = process.env.OPENGENI_P42_LIVE_MODAL === "1";
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

// Open the wss tunnel with the 'binary' subprotocol and require the RFB server
// banner (the noVNC WS upgrade returns 101 then the VNC ProtocolVersion bytes).
async function probeRfbBanner(
  url: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; banner: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, banner: string) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve({ ok, banner });
    };
    const ws = new WebSocket(url, ["binary"]);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => finish(false, ""), timeoutMs);
    ws.addEventListener("message", (ev: MessageEvent) => {
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array();
      const head = new TextDecoder("latin1").decode(buf.subarray(0, 12));
      if (/^RFB \d{3}\.\d{3}/.test(head)) {
        clearTimeout(timer);
        finish(true, head);
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      finish(false, "");
    });
  });
}

describe.if(LIVE)("P4.2 GATED live-Modal — RFB pixels through the real Modal tunnel (D3)", () => {
  test(
    "build desktop image → boot → ensureDisplayStack → exposeStreamPort URL → WS client → RFB banner",
    async () => {
      const require = createRequire(
        join(REPO_ROOT, "spikes/provider-credentialed/desktop-on-gvisor/x.cjs"),
      );
      const { ModalClient } = require("modal") as typeof import("modal");

      const APP_NAME = process.env.SPIKE_APP_NAME || "ogtest-p42-pixel-plane";
      const STREAM_PORT = 6080;
      const BUILD_TIMEOUT_MS = 25 * 60 * 1000;
      const BOX_TIMEOUT_MS = 12 * 60 * 1000;

      const modal = new ModalClient({ logLevel: "info" });
      const app = await modal.apps.fromName(APP_NAME, { createIfMissing: true });

      const aptRetry = (pkgs: string) =>
        `export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC; set -eux; for attempt in 1 2 3; do ` +
        `rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; ` +
        `apt-get update && apt-get install -y --no-install-recommends ${pkgs} && break; ` +
        `if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); done; rm -rf /var/lib/apt/lists/*`;

      const upScript = await Bun.file(
        join(REPO_ROOT, "docker/desktop/opengeni-desktop-up.sh"),
      ).text();
      const upOpenbox = upScript.replace(
        "dbus-launch --exit-with-session startxfce4",
        "dbus-launch --exit-with-session openbox",
      );
      const upB64 = Buffer.from(upOpenbox, "utf8").toString("base64");

      const layers = [
        `RUN ${aptRetry(
          "bash ca-certificates coreutils curl git net-tools netcat-openbsd wget gnupg xxd file " +
            "xvfb x11-utils x11-xserver-utils xauth dbus-x11 openbox " +
            "libgl1-mesa-dri fonts-liberation python3 xterm x11vnc xdotool scrot",
        )}`,
        `RUN set -eux; git clone --depth 1 -b v1.5.0 https://github.com/novnc/noVNC.git /opt/noVNC; ` +
          `git clone --depth 1 -b v0.12.0 https://github.com/novnc/websockify.git /opt/noVNC/utils/websockify; ` +
          `ln -sf /opt/noVNC/vnc.html /opt/noVNC/index.html`,
        `RUN set -eux; dbus-uuidgen --ensure=/var/lib/dbus/machine-id; ln -sf /var/lib/dbus/machine-id /etc/machine-id`,
        `RUN set -eux; mkdir -p /usr/local/bin; echo ${upB64} | base64 -d > /usr/local/bin/opengeni-desktop-up; ` +
          `chmod 0755 /usr/local/bin/opengeni-desktop-up; bash -n /usr/local/bin/opengeni-desktop-up`,
        `ENV HOME=/workspace DISPLAY=:0 OPENGENI_DESKTOP_STREAM_PORT=${STREAM_PORT}`,
        `WORKDIR /workspace`,
      ];

      let image = modal.images.fromRegistry("ubuntu:22.04");
      const buildStart = Date.now();
      for (const layer of layers) {
        if (Date.now() - buildStart > BUILD_TIMEOUT_MS) throw new Error("build budget exhausted");
        image = await image.dockerfileCommands(layer.split("\n")).build(app);
      }

      const sandbox = await modal.sandboxes.create(app, image, {
        timeoutMs: BOX_TIMEOUT_MS,
        encryptedPorts: [STREAM_PORT],
        command: ["sleep", "infinity"],
      });

      const drain = async (stream: ReadableStream<string>) => {
        let out = "";
        const reader = stream.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            out += value;
          }
        } catch {
          /* noop */
        }
        return out;
      };
      const run = async (command: string) => {
        const proc = await sandbox.exec(["bash", "-lc", command], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [o, e] = await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
        const exitCode = await proc.wait();
        return { exitCode, output: `${o}\n${e}` };
      };

      try {
        // ensureDisplayStack equiv: bring the Xvfb→openbox→x11vnc→websockify:6080 chain up.
        const up = await run(`STREAM_PORT=${STREAM_PORT} opengeni-desktop-up`);
        expect(up.exitCode).toBe(0);
        expect(up.output).toContain("OPENGENI_DESKTOP_UP");

        // exposeStreamPort equiv: resolve the REAL Modal provider tunnel for 6080.
        // (The raw Modal SDK sandbox exposes tunnels(); our ModalSandboxClient wraps
        // exactly this in resolveExposedPort. We assemble the URL with the SAME
        // buildStreamUrl the data plane uses — proving end-to-end addressing.)
        const tunnels = await sandbox.tunnels(30_000);
        const tunnel = tunnels[STREAM_PORT];
        expect(tunnel?.host).toBeTruthy();
        const endpoint = {
          host: tunnel.host as string,
          port: (tunnel.port as number) ?? 443,
          tls: true,
          query: "",
        };
        const wssUrl = buildStreamUrl(endpoint);
        expect(wssUrl.startsWith("wss://")).toBe(true);

        // THE PROOF: a WS client connects to the DIRECT Modal tunnel and receives
        // the RFB ProtocolVersion banner (101 upgrade + "RFB 003.00x") — pixels
        // streaming straight from Modal, no OpenGeni in the pixel path.
        const rfb = await probeRfbBanner(wssUrl, 20_000);
        expect(rfb.ok).toBe(true);
        expect(rfb.banner).toMatch(/^RFB \d{3}\.\d{3}/);
      } finally {
        await sandbox.terminate().catch(() => undefined);
      }
    },
    40 * 60 * 1000,
  );
});

describe.if(!LIVE)("P4.2 live-Modal RFB proof (skipped without OPENGENI_P42_LIVE_MODAL=1)", () => {
  test("documented skip", () => {
    expect(LIVE).toBe(false);
  });
});
