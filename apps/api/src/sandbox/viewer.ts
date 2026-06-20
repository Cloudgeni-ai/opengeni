// apps/api/src/sandbox/viewer.ts — the API-DIRECT viewer-holder lifecycle (P1.4).
//
// A viewer (a human watching a session's box) acquires a `viewer` holder on the
// GROUP lease so the box stays warm WHILE WATCHED — liveness = turn OR viewer
// (the §C group-refcount win). All IN-PROCESS: the API runs the cold->warming
// CAS as a Postgres txn it owns, resumes the box BY ID via the leaf
// (@opengeni/runtime/sandbox), and never signals Temporal or a worker.
//
//   attach  -> acquireLease(kind:'viewer') under FOR UPDATE + cold->warming CAS.
//              spawner role  -> establish the box in-process + commitWarmingToWarm.
//              attached/rearmed -> the holder alone keeps the box warm.
//              fenced -> release + surface a 409 (a newer epoch re-established it).
//   heartbeat -> heartbeatLeaseHolder (epoch-fenced) refreshes the holder TTL.
//   detach  -> releaseLeaseHolder (idempotent); the reaper (P1.3) stop()s the
//              box at refcount 0 past the drain grace.
//
// The desktop pixel tunnel-URL mint + the un-redacted acknowledgment + the
// scoped token are P3/P4. Here we surface only the holder lifecycle + the
// lease's recorded data_plane_url (null until P4 mints it).

import { resolveStreamTokenSecret } from "@opengeni/config";
import type { Settings } from "@opengeni/config";
import { type Session, type StreamUrlRotatedPayload } from "@opengeni/contracts";
import {
  acquireLease,
  commitWarmingToWarm,
  failWarmingToCold,
  getSandboxSessionEnvelope,
  heartbeatLeaseHolder,
  readLease,
  recordLeaseDataPlaneUrl,
  releaseLeaseHolder,
  SandboxLeaseSupersededError,
  type Database,
  type LeaseSnapshot,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import { HTTPException } from "hono/http-exception";

// The leaf — agent-loop-free. apps/api imports sandbox symbols ONLY from here
// (enforced by sandbox-access-import-guard.test.ts).
import {
  ensureDisplayStack,
  establishSandboxSessionFromEnvelope,
  exposeStreamPort,
  desktopCapableBackend,
  DisplayStackUnsupportedError,
  StreamPortUnavailableError,
  type EstablishedSandboxSession,
} from "@opengeni/runtime/sandbox";

/** The minimal services a viewer op needs: the DB + settings (lease cadence +
 *  the sandbox client construction the leaf reads from settings). The bus is
 *  optional — only the rotation path (emitting stream.url.rotated to OTHER
 *  viewers) needs it. */
export type ViewerServices = {
  db: Database;
  settings: Settings;
  bus?: EventBus;
};

/** A coherent snapshot the routes echo back: the holder id (the viewer's fence-
 *  carrying handle), the lease liveness/epoch, and the recorded data-plane URL
 *  (null until P4 mints the desktop tunnel). */
export type ViewerAttachResult = {
  viewerId: string;
  liveness: LeaseSnapshot["liveness"];
  leaseEpoch: number;
  sandboxGroupId: string;
  // The viewer heartbeat cadence the client must beat at to keep the holder
  // alive (shorter than the viewer-holder TTL the reaper enforces).
  viewerHeartbeatIntervalMs: number;
  // The desktop pixel tunnel URL the viewer connects to directly. Null in P1.4
  // (the mint is P4); surfaced here so the shape is stable.
  dataPlaneUrl: string | null;
};

/**
 * Acquire a `viewer` holder on the group lease, spinning up the box IN-PROCESS
 * when cold. Mirrors the worker's resumeBoxForTurn spawner/attached branches,
 * but with kind:'viewer' and run by the API process — no Temporal, no worker.
 *
 * `viewerId` is the unique-per-connection holder id (a uuid the client carries
 * through heartbeats + detach); generated when absent.
 */
export async function attachViewer(
  services: ViewerServices,
  input: { accountId: string; workspaceId: string; session: Session; viewerId?: string },
): Promise<ViewerAttachResult> {
  const { db, settings } = services;
  const { accountId, workspaceId, session } = input;
  const viewerId = input.viewerId ?? crypto.randomUUID();
  const leaseTtlMs = settings.sandboxLeaseTtlMs;
  const sandboxGroupId = session.sandboxGroupId;

  const release = async (): Promise<void> => {
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId,
      kind: "viewer",
      holderId: viewerId,
      idleGraceMs: settings.sandboxIdleGraceMs,
    });
  };

  const acquired = await acquireLease(db, {
    accountId,
    workspaceId,
    sandboxGroupId,
    kind: "viewer",
    holderId: viewerId,
    subjectId: session.id,
    backend: session.sandboxBackend,
    os: session.sandboxOs,
    leaseTtlMs,
  });

  // FENCED: a newer epoch re-established the box. Release our just-registered
  // holder and surface a 409 — the client re-reads capabilities and re-attaches.
  if (acquired.role === "fenced") {
    await release();
    throw new HTTPException(409, { message: `sandbox lease superseded (epoch ${acquired.lease.leaseEpoch}); re-read capabilities and re-attach` });
  }

  // SPAWNER: we won the cold->warming CAS. Establish the box in-process from the
  // session's persisted envelope (warm reattach by id, or cold-restore on a
  // provider NotFound), then commit warm (the lease_epoch++ fence + fold the
  // resume envelope onto the lease). A held in-memory handle is dropped after
  // commit — the lease owns lifecycle, not this handle (non-owned by id).
  if (acquired.role === "spawner") {
    const expectedEpoch = acquired.lease.leaseEpoch;
    let established: EstablishedSandboxSession | undefined;
    try {
      const envelope = await getSandboxSessionEnvelope(db, workspaceId, session.id);
      established = await establishSandboxSessionFromEnvelope(settings, envelope, {
        sessionId: session.id,
        backendOverride: session.sandboxBackend,
      });
      const committed = await commitWarmingToWarm(db, {
        accountId,
        workspaceId,
        sandboxGroupId,
        expectedEpoch,
        instanceId: established.instanceId,
        // The desktop tunnel-URL mint is P4; record null for now.
        dataPlaneUrl: null,
        resumeBackendId: established.backendId,
        resumeState: envelope ?? null,
        leaseTtlMs,
      });
      if (!committed.committed || !committed.lease) {
        // A reaper reset our warming row (we were too slow) or a sibling
        // re-established and bumped the epoch. Release our holder and surface a
        // 409. NEVER provider-delete the box (it rides the provider idle-timeout).
        await release();
        throw new SandboxLeaseSupersededError(sandboxGroupId, expectedEpoch);
      }
      return {
        viewerId,
        liveness: committed.lease.liveness,
        leaseEpoch: committed.lease.leaseEpoch,
        sandboxGroupId,
        viewerHeartbeatIntervalMs: viewerHeartbeatIntervalMs(settings),
        dataPlaneUrl: committed.lease.dataPlaneUrl,
      };
    } catch (error) {
      if (error instanceof SandboxLeaseSupersededError) {
        throw new HTTPException(409, { message: `sandbox lease superseded (epoch ${error.leaseEpoch}); re-read capabilities and re-attach` });
      }
      // Caught spawn failure: roll the warming row back to cold so the next
      // arrival (a turn or another viewer) re-acquires and re-spawns. Holders
      // are intentionally kept by failWarmingToCold for the re-acquire; then
      // release our own holder so we don't pin a cold lease.
      await failWarmingToCold(db, { accountId, workspaceId, sandboxGroupId, expectedEpoch });
      await release();
      throw error;
    } finally {
      // Drop the in-process handle: the API resumed BY ID for the cold-spawn,
      // it does NOT own the box. The lease's refcount (this viewer holder) keeps
      // it warm; the reaper stops it at refcount 0.
      await dropEstablishedHandle(established);
    }
  }

  // ATTACHED / REARMED: the box is live (or a sibling is mid-warm). The viewer
  // holder alone keeps it warm — no establish needed (the holder lifecycle is
  // the P1.4 deliverable; P4 mints the pixel URL on the negotiation read).
  return {
    viewerId,
    liveness: acquired.lease.liveness,
    leaseEpoch: acquired.lease.leaseEpoch,
    sandboxGroupId,
    viewerHeartbeatIntervalMs: viewerHeartbeatIntervalMs(settings),
    dataPlaneUrl: acquired.lease.dataPlaneUrl,
  };
}

/**
 * Refresh a viewer holder's TTL (the app-level viewer heartbeat). Epoch-fenced:
 * a stale-epoch heartbeat (a box re-established under a newer epoch) returns
 * false and the client must re-attach. Returns whether the holder is still live.
 */
export async function heartbeatViewer(
  services: ViewerServices,
  input: { accountId: string; workspaceId: string; sandboxGroupId: string; viewerId: string; expectedEpoch: number },
): Promise<boolean> {
  return await heartbeatLeaseHolder(services.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sandboxGroupId: input.sandboxGroupId,
    kind: "viewer",
    holderId: input.viewerId,
    leaseTtlMs: services.settings.sandboxLeaseTtlMs,
    expectedEpoch: input.expectedEpoch,
  });
}

/**
 * Release a viewer holder (the client disconnected). Idempotent: a double
 * detach (or a detach after the reaper already TTL-reaped the holder) is a
 * no-op. The box drains/stops only when no turn AND no viewer holds it.
 */
export async function detachViewer(
  services: ViewerServices,
  input: { accountId: string; workspaceId: string; sandboxGroupId: string; viewerId: string },
): Promise<{ liveness: LeaseSnapshot["liveness"]; refcount: number } | null> {
  return await releaseLeaseHolder(services.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sandboxGroupId: input.sandboxGroupId,
    kind: "viewer",
    holderId: input.viewerId,
    idleGraceMs: services.settings.sandboxIdleGraceMs,
  });
}

/** Non-locking lease snapshot for the capability-negotiation read. */
export async function readGroupLease(
  services: ViewerServices,
  input: { workspaceId: string; sandboxGroupId: string },
): Promise<LeaseSnapshot | null> {
  return await readLease(services.db, input.workspaceId, input.sandboxGroupId);
}

// The viewer heartbeat cadence: half the viewer-holder TTL, floored at 5s, so a
// single missed beat never reaps a live viewer (two beats fit inside the TTL).
function viewerHeartbeatIntervalMs(settings: Settings): number {
  return Math.max(5_000, Math.floor(settings.sandboxViewerHolderTtlMs / 2));
}

// Best-effort drop of a transiently-established handle (the cold-spawn path).
// The box is NON-OWNED by id, so closing the local handle never terminates it;
// we just free the in-process resources. Swallow errors — a failed close must
// not fail the attach (the lease holder already keeps the box warm).
async function dropEstablishedHandle(established: EstablishedSandboxSession | undefined): Promise<void> {
  if (!established) {
    return;
  }
  const session = established.session as { close?: () => Promise<void> } | undefined;
  if (session && typeof session.close === "function") {
    try {
      await session.close();
    } catch {
      // non-owned handle; the lease owns lifecycle.
    }
  }
}

// ============================================================================
// P4.2 — the pixel DATA PLANE, served API-DIRECT.
//
// mintDesktopStream resumes the WARM box BY ID in-process, idempotently ensures
// the display stack, resolves the provider's scoped tunnel for port 6080, mints
// the scoped per-viewer stream token, records the resolved URL on the lease under
// the epoch fence, and (on a box rollover — a lease_epoch advance vs what the
// caller last saw) emits a `stream.url.rotated` Channel-A event so OTHER
// connected viewers reconnect. NO Temporal, NO worker, NO NATS req/reply: the API
// process holds the live handle for the duration of the call and drops it on
// return (the lease, not this handle, owns the box).
//
// Rotation is EVENT-DRIVEN, not a timer: the URL only changes when the box is
// re-keyed (Modal 24h ceiling / death → re-establish under a new epoch). The
// requester always gets the fresh cell as the HTTP response; the rotation event
// is the out-of-band signal to the OTHER viewers of the same session.
// ============================================================================

/** The minted pixel cell the handshake/attach folds into the DesktopStream
 *  capability. Null when degraded (no secret, headless backend, display-stack
 *  failure, provider tunnel failure) — degradation is a value, never a throw. */
export type DesktopStreamMint = {
  url: string;
  token: string;
  expiresAt: string;
  resolution: [number, number];
  leaseEpoch: number;
};

export type MintDesktopStreamInput = {
  accountId: string;
  workspaceId: string;
  session: Session;
  /** The viewer holder id the scoped token is minted for. */
  viewerId: string;
  /** The live lease (must be warm/draining — the box is up). */
  lease: LeaseSnapshot;
  /** The epoch the CALLER last observed the URL minted under. When the live
   *  lease epoch is greater, the box rolled over → emit stream.url.rotated to the
   *  other viewers. Omit on a first mint (no prior URL to rotate from). */
  previousEpoch?: number;
  /** Test seam: override how the box is re-established by id. Defaults to the
   *  real leaf `establishSandboxSessionFromEnvelope`. Production NEVER passes
   *  this; it exists so a real-lease integration test can inject a fake provider
   *  session carrying `resolveExposedPort` without a live cloud box. */
  establish?: (
    envelope: Record<string, unknown> | null,
  ) => Promise<EstablishedSandboxSession>;
};

/**
 * Mint (or re-mint) the desktop pixel cell for a viewer against a WARM box,
 * IN-PROCESS. Returns the minted cell, or null when the desktop tier degrades
 * (no resolvable stream-token secret, a headless backend, a display-stack
 * failure, or a provider-tunnel failure) — the caller surfaces transport:null,
 * never an exception to the user.
 *
 * Idempotent display-stack + resolveExposedPort are safe to call N times. The
 * resolved URL is recorded on the lease (data_plane_url) under the epoch fence; a
 * stale-epoch write (the box re-established under a newer epoch mid-call) is a
 * no-op and we return the freshly-minted cell anyway (it is for the epoch we
 * resumed under; the next op reconciles).
 */
export async function mintDesktopStream(
  services: ViewerServices,
  input: MintDesktopStreamInput,
): Promise<DesktopStreamMint | null> {
  const { db, settings, bus } = services;
  const { accountId, workspaceId, session, viewerId, lease } = input;

  // GATE 1: a desktop tier that is off, headless, or lacks a stream-token secret
  // cannot mint a live URL. (The handshake's negotiateCapabilities already
  // reports the typed reason; here we just refuse to mint.)
  if (!settings.sandboxDesktopEnabled) {
    return null;
  }
  if (!desktopCapableBackend(session.sandboxBackend)) {
    return null;
  }
  const secret = resolveStreamTokenSecret(settings);
  if (!secret) {
    return null;
  }
  // GATE 2: the box must be live (the handshake never spins one up — a cold box
  // returns lease_cold; the viewer-attach path warms it first, then mints).
  if (lease.liveness !== "warm" && lease.liveness !== "draining") {
    return null;
  }

  // Resume the LIVE box by id. The lease's resume_state is authoritative (it is
  // the box the lease currently fences); fall back to the session envelope only
  // when the lease has none (a freshly-warmed lease always has it).
  const envelope = lease.resumeState ?? (await getSandboxSessionEnvelope(db, workspaceId, session.id));
  let established: EstablishedSandboxSession | undefined;
  try {
    established = input.establish
      ? await input.establish(envelope)
      : await establishSandboxSessionFromEnvelope(settings, envelope, {
          sessionId: session.id,
          backendOverride: session.sandboxBackend,
        });

    // Idempotent display stack (flock-guarded; a no-op when already up). A box
    // that genuinely can't run the stack degrades to transport:null, not a throw.
    try {
      await ensureDisplayStack(established.session);
    } catch (error) {
      if (error instanceof DisplayStackUnsupportedError) {
        return null;
      }
      throw error;
    }

    // Resolve the provider tunnel + mint the scoped token, IN-PROCESS.
    let exposed: Awaited<ReturnType<typeof exposeStreamPort>>;
    try {
      exposed = await exposeStreamPort(established.session, {
        workspaceId,
        sessionId: session.id,
        viewerId,
        leaseEpoch: lease.leaseEpoch,
        streamTokenSecret: secret,
        resolution: defaultResolution(settings),
      });
    } catch (error) {
      // A transient/headless provider failure degrades the desktop cell.
      if (error instanceof StreamPortUnavailableError) {
        return null;
      }
      throw error;
    }

    // Record the resolved URL on the lease under the epoch fence (rotation +
    // disclosure). A fence miss (the box re-established under a newer epoch
    // mid-call) is a no-op; we still return the cell we minted for our epoch.
    await recordLeaseDataPlaneUrl(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      expectedEpoch: lease.leaseEpoch,
      dataPlaneUrl: exposed.url,
    });

    const mint: DesktopStreamMint = {
      url: exposed.url,
      token: exposed.token,
      expiresAt: exposed.expiresAt,
      resolution: exposed.resolution,
      leaseEpoch: lease.leaseEpoch,
    };

    // ROLLOVER ROTATION (event-driven): when the live epoch advanced past what
    // the caller last saw, the box was re-keyed → the OLD data-plane URL is
    // stale. Emit stream.url.rotated so OTHER connected viewers hot-swap their
    // noVNC socket. The requester already has the fresh cell as its response, so
    // this is purely the out-of-band signal to the rest. Best-effort: a publish
    // failure must never fail the mint.
    if (bus && input.previousEpoch !== undefined && lease.leaseEpoch > input.previousEpoch) {
      const payload: StreamUrlRotatedPayload = {
        url: exposed.url,
        token: exposed.token,
        expiresAt: exposed.expiresAt,
        leaseEpoch: lease.leaseEpoch,
        transport: "vnc-ws",
        viewerId,
      };
      try {
        await appendAndPublishEvents(db, bus, workspaceId, session.id, [
          { type: "stream.url.rotated", payload },
        ]);
      } catch {
        // The durable SSE spine retries; a dropped publish here is not fatal.
      }
    }

    return mint;
  } catch {
    // Any other failure (resume error, exec error) degrades the desktop cell to
    // transport:null rather than failing the whole handshake — Channel-A still
    // works. The capability resolver reports the desktop as available; the live
    // URL is simply absent until the next op succeeds.
    return null;
  } finally {
    await dropEstablishedHandle(established);
  }
}

// The framebuffer geometry from settings (streamResolutionWidth/Height; default
// 1280x800, the spike's proven geometry).
function defaultResolution(settings: Settings): [number, number] {
  return [settings.streamResolutionWidth, settings.streamResolutionHeight];
}
