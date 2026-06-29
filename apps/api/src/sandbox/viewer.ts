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

import { createHash } from "node:crypto";
import { resolveStreamTokenSecret, stableSandboxEnvironmentForRun } from "@opengeni/config";
import type { Settings } from "@opengeni/config";
import { type Session, type StreamUrlRotatedPayload } from "@opengeni/contracts";
import {
  acquireLease,
  commitWarmingToWarm,
  failWarmingToCold,
  getSandbox,
  getSandboxSessionEnvelope,
  heartbeatLeaseHolder,
  loadWorkspaceEnvironmentForRun,
  readLease,
  recordLeaseDataPlaneUrl,
  recordLeaseTerminalDataPlaneUrl,
  releaseLeaseHolder,
  SandboxLeaseSupersededError,
  type Database,
  type LeaseSnapshot,
  type SandboxRecord,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import { HTTPException } from "hono/http-exception";

// The leaf — agent-loop-free. apps/api imports sandbox symbols ONLY from here
// (enforced by sandbox-access-import-guard.test.ts).
import {
  DESKTOP_STREAM_PORT,
  ensureDisplayStack,
  ensureTerminalServer,
  establishSandboxSessionFromEnvelope,
  exposeStreamPort,
  desktopCapableBackend,
  NatsControlRpc,
  SelfhostedSandboxClient,
  serializeEstablishedSandboxEnvelope,
  mintStreamToken,
  STREAM_TOKEN_DEFAULT_TTL_SECONDS,
  TERMINAL_STREAM_PORT,
  DisplayStackUnsupportedError,
  TerminalServerUnsupportedError,
  StreamPortUnavailableError,
  type ControlRpc,
  type EstablishedSandboxSession,
  type NatsRequestConnection,
} from "@opengeni/runtime/sandbox";
import { relayConfigFromSettings } from "./routing";

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
 * The STABLE run-scoped sandbox environment a COLD box must be created with so
 * that — whether the box is first warmed by an API-direct ATTACH (here) or by the
 * worker TURN — its manifest environment matches the environment the agent later
 * declares for a turn. Without this, an attach-warmed box was created with the
 * BASE allowlist env only (establishSandboxSessionFromEnvelope's
 * collectSandboxEnvironment default), so the next turn's fuller env (git identity
 * + workspace environment + HOME) introduced a delta and the SDK's
 * `validateNoEnvironmentDelta` threw "Live sandbox sessions cannot change manifest
 * environment variables" — the BLOCKING error this fixes.
 *
 * Mirrors the worker turn's STABLE subset (config.stableSandboxEnvironmentForRun +
 * the session's attached, decrypted workspace environment). It deliberately omits
 * the per-run, rotating GitHub App installation token the turn layers on for a
 * repo-attached run (sandboxEnvironmentForRun): that secret is minted fresh per
 * call and is not attach-reproducible, and the attach surfaces have no repo
 * resources in scope anyway.
 */
async function sessionAttachEnvironment(
  services: ViewerServices,
  workspaceId: string,
  session: Session,
): Promise<Record<string, string>> {
  const workspaceEnvironment = await loadWorkspaceEnvironmentForRun(
    services.db,
    services.settings,
    workspaceId,
    session.environmentId,
  );
  return stableSandboxEnvironmentForRun(services.settings, workspaceEnvironment?.values ?? {});
}

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
      // Create a cold box with the SAME stable run-environment the worker turn
      // will declare (config base + git identity + decrypted workspace env + HOME)
      // so the next turn's agent-manifest apply finds an EMPTY environment delta in
      // the SDK's validateNoEnvironmentDelta (otherwise: "Live sandbox sessions
      // cannot change manifest environment variables").
      const environment = await sessionAttachEnvironment(services, workspaceId, session);
      // Prefer the COLD lease's preserved resume_state when it carries a persisted
      // /workspace snapshot (confirmDrainCold keeps a minimal archive-only envelope
      // across draining->cold). establishSandboxSessionFromEnvelope cold-creates a
      // fresh box and replays the archive via hydrateWorkspace, so /workspace
      // survives the box churn (sandbox-file-persistence). No archive -> the bare
      // session envelope (a never-warmed cold start).
      const spawnEnvelope = acquired.lease.resumeState ?? envelope;
      established = await establishSandboxSessionFromEnvelope(settings, spawnEnvelope, {
        sessionId: session.id,
        backendOverride: session.sandboxBackend,
        environment,
      });
      // Fold the LIVE box into a re-resumable envelope and persist it as the
      // lease's resume_state, so EVERY later op (another viewer, a Channel-A
      // call, the reaper) resumes THIS box by id instead of cold-creating a
      // rival. Fall back to the session envelope only when serialize is
      // unavailable. (Without this the box churned: each op spawned its own box.)
      const resumeEnvelope = (await serializeEstablishedSandboxEnvelope(established)) ?? envelope ?? null;
      const committed = await commitWarmingToWarm(db, {
        accountId,
        workspaceId,
        sandboxGroupId,
        expectedEpoch,
        instanceId: established.instanceId,
        // The desktop tunnel-URL mint is P4; record null for now.
        dataPlaneUrl: null,
        resumeBackendId: established.backendId,
        resumeState: resumeEnvelope,
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
      // Mirror the Channel-A spawner (channel-a.ts): a provider/config failure to
      // bring up the cold box is a client-actionable 409 ("sandbox not available;
      // re-attach to retry"), NOT a raw 500 — the warming row was just rolled back
      // to cold, so a re-attach re-acquires and re-spawns. Preserve an already-typed
      // HTTPException unchanged.
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(409, { message: `sandbox not available (${error instanceof Error ? error.message : "spawn failed"})` });
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
export function viewerHeartbeatIntervalMs(settings: Settings): number {
  return Math.max(5_000, Math.floor(settings.sandboxViewerHolderTtlMs / 2));
}

// Drop a transiently-established, NON-OWNED handle. The box is owned by the LEASE
// (resumed by id), not by this in-process handle, so we MUST NOT terminate it on
// drop — we only release the local reference and let GC reclaim the client's
// transport. This mirrors the worker's resume-by-id path (sandbox-resume.ts),
// which injects the session NON-OWNED and never closes it.
//
// CRITICAL (deployed-integration bug, prove-it D1/D2/D5): a provider session's
// `close()` is NOT a neutral "free local resources" call. For Modal,
// `ModalSandboxSession.close()` calls `sandbox.terminate()` — it KILLS THE BOX.
// Calling it here terminated the very box the lease had just committed warm, so
// every viewer attach / Channel-A op spawned a box and immediately destroyed it
// (the lease showed warm while Modal showed the box gone; reads 404'd against a
// fresh box). We therefore DO NOT call session.close()/shutdown()/delete() — the
// reaper (provider stop at refcount 0) is the ONLY sanctioned box terminator.
async function dropEstablishedHandle(established: EstablishedSandboxSession | undefined): Promise<void> {
  // Intentionally a no-op beyond dropping the reference: terminating the box here
  // is wrong (see above). The lease owns lifecycle; the reaper owns teardown.
  void established;
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
  /** The live lease (must be warm/draining — the box is up). A selfhosted-active
   *  session may have no Modal group lease; omit and the selfhosted branch handles it. */
  lease?: LeaseSnapshot;
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
  /** Test seam: inject a fake relay-resolving session for the selfhosted-active
   *  branch. Production NEVER passes this. */
  resolveSelfhostedSession?: (sandbox: SandboxRecord) => Promise<{ resolveExposedPort?: (port: number) => Promise<unknown> }>;
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
  const { accountId, workspaceId, session } = input;
  const lease = input.lease;
  // The scoped token's viewerId must be a UUID (StreamTokenPayload). The GET caps
  // handshake passes grant.subjectId, which is a non-UUID for an API-key principal
  // ("configured:key") — coerce it to a deterministic UUID so the mint never 500s
  // (caps-500 fix). A managed-session subject (already a UUID) is unchanged.
  const viewerId = viewerIdAsUuid(input.viewerId);

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

  // SELFHOSTED ACTIVE: when the session's active sandbox is a selfhosted machine,
  // route to the relay (NOT the Modal group-box path — it would resume the wrong
  // box and return a Modal URL). No Modal lease required.
  if (session.activeSandboxId) {
    const active = await getSandbox(db, workspaceId, session.activeSandboxId);
    if (active?.kind === "selfhosted") {
      const m = await tryMintActiveSelfhostedStream(services, { session, viewerId: input.viewerId, workspaceId, port: DESKTOP_STREAM_PORT, sandbox: active }, input.resolveSelfhostedSession);
      // mintSelfhostedStream returns no resolution; the desktop cell needs it.
      return m ? { url: m.url, token: m.token, expiresAt: m.expiresAt, resolution: defaultResolution(settings), leaseEpoch: m.leaseEpoch } : null;
    }
    // A Modal swap target (or unknown) falls through to the existing group-box path.
  }

  // GATE 2: the box must be live (the handshake never spins one up — a cold box
  // returns lease_cold; the viewer-attach path warms it first, then mints).
  if (!lease || (lease.liveness !== "warm" && lease.liveness !== "draining")) {
    return null;
  }

  // FAST PATH (P4.2 perf): when the lease already holds the data-plane URL for
  // this epoch, the box is warm, exposed, and the display stack is already up.
  // Re-resuming the box by id (Modal resume-by-id is ~40s) + re-running
  // ensureDisplayStack + exposeStreamPort on EVERY stream-capabilities poll made
  // the desktop look like it was "starting" forever. The tunnel URL is stable for
  // the life of the (epoch-fenced) box, so mint ONLY a fresh scoped token (HMAC,
  // sub-millisecond) against the cached URL and return — no box touch at all. A
  // rollover advances the epoch and re-records dataPlaneUrl via the slow path, so
  // a cached URL here is always the current epoch's live tunnel.
  if (lease.dataPlaneUrl) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await mintStreamToken(secret, {
      workspaceId,
      sessionId: session.id,
      viewerId,
      leaseEpoch: lease.leaseEpoch,
      nowSeconds,
    });
    return {
      url: lease.dataPlaneUrl,
      token,
      expiresAt: new Date((nowSeconds + STREAM_TOKEN_DEFAULT_TTL_SECONDS) * 1000).toISOString(),
      resolution: defaultResolution(settings),
      leaseEpoch: lease.leaseEpoch,
    };
  }

  // Resume the LIVE box by id. The lease's resume_state is authoritative (it is
  // the box the lease currently fences); fall back to the session envelope only
  // when the lease has none (a freshly-warmed lease always has it).
  const envelope = lease.resumeState ?? (await getSandboxSessionEnvelope(db, workspaceId, session.id));
  let established: EstablishedSandboxSession | undefined;
  try {
    // On a cold-restore (the lease's box is gone) this create() must carry the
    // SAME stable run-env the turn declares, so a later turn finds no env delta.
    const environment = await sessionAttachEnvironment(services, workspaceId, session);
    established = input.establish
      ? await input.establish(envelope)
      : await establishSandboxSessionFromEnvelope(settings, envelope, {
          sessionId: session.id,
          backendOverride: session.sandboxBackend,
          environment,
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

// ============================================================================
// P5.t — the REAL PTY terminal DATA PLANE, served API-DIRECT.
//
// mintTerminalStream is the EXACT terminal twin of mintDesktopStream: it resumes
// the WARM box BY ID in-process, idempotently ensures the ttyd PTY-over-websocket
// server (ensureTerminalServer), resolves the provider's scoped tunnel for port
// 7681 (a SEPARATE tunnel from the 6080 desktop noVNC → a different URL), mints
// the scoped per-viewer stream token, and records the resolved URL on the lease's
// terminal_data_plane_url column under the epoch fence. The fast-path re-mints
// ONLY a fresh token against the cached terminal URL (no box touch).
//
// It does NOT require the desktop to be on — it gates on the separate
// sandboxTerminalEnabled toggle. Degradation (no secret, headless backend, ttyd
// failure, provider tunnel failure) returns null → the Terminal cell falls back
// to the read-only sse-events firehose (a value, never a throw).
// ============================================================================

/** The minted terminal cell the handshake/attach folds into the Terminal
 *  capability (pty-ws). Null when degraded — the caller surfaces transport
 *  "sse-events" (the read-only firehose), never an exception. */
export type TerminalStreamMint = {
  url: string;
  token: string;
  expiresAt: string;
  leaseEpoch: number;
};

export type MintTerminalStreamInput = {
  accountId: string;
  workspaceId: string;
  session: Session;
  /** The viewer holder / principal id the scoped token is minted for. */
  viewerId: string;
  /** The live lease (must be warm/draining — the box is up). A selfhosted-active
   *  session may have no Modal group lease; omit and the selfhosted branch handles it. */
  lease?: LeaseSnapshot;
  /** Test seam: override how the box is re-established by id (see
   *  MintDesktopStreamInput.establish). Production NEVER passes this. */
  establish?: (
    envelope: Record<string, unknown> | null,
  ) => Promise<EstablishedSandboxSession>;
  /** Test seam: inject a fake relay-resolving session for the selfhosted-active
   *  branch. Production NEVER passes this. */
  resolveSelfhostedSession?: (sandbox: SandboxRecord) => Promise<{ resolveExposedPort?: (port: number) => Promise<unknown> }>;
};

/**
 * Mint (or re-mint) the REAL PTY (ttyd pty-ws) terminal cell for a viewer against
 * a WARM box, IN-PROCESS. Returns the minted cell, or null when the terminal tier
 * degrades (terminal off, no resolvable stream-token secret, a headless backend,
 * a ttyd-launch failure, or a provider-tunnel failure) — the caller surfaces the
 * sse-events firehose, never an exception to the user. Mirrors mintDesktopStream.
 */
export async function mintTerminalStream(
  services: ViewerServices,
  input: MintTerminalStreamInput,
): Promise<TerminalStreamMint | null> {
  const { db, settings } = services;
  const { accountId, workspaceId, session } = input;
  const lease = input.lease;
  // Same caps-500 fix as the desktop mint: coerce a non-UUID principal id
  // (grant.subjectId = "configured:key" for an API key) to a deterministic UUID
  // so StreamTokenPayload.parse never throws an uncaught 500.
  const viewerId = viewerIdAsUuid(input.viewerId);

  // GATE 1: the terminal pty-ws plane requires the toggle ON, a real-PTY backend
  // (desktop-capable images bake ttyd), and a resolvable stream-token secret.
  if (!settings.sandboxTerminalEnabled) {
    return null;
  }
  if (!desktopCapableBackend(session.sandboxBackend)) {
    return null;
  }
  const secret = resolveStreamTokenSecret(settings);
  if (!secret) {
    return null;
  }

  // SELFHOSTED ACTIVE: when the session's active sandbox is a selfhosted machine,
  // route to the relay. NEVER fall through to the Modal group-box path (it would
  // resume the wrong box / return a Modal URL).
  if (session.activeSandboxId) {
    const active = await getSandbox(db, workspaceId, session.activeSandboxId);
    if (active?.kind === "selfhosted") {
      return await tryMintActiveSelfhostedStream(services, { session, viewerId: input.viewerId, workspaceId, port: TERMINAL_STREAM_PORT, sandbox: active }, input.resolveSelfhostedSession);
    }
    // A Modal swap target (or unknown) falls through to the existing group-box path
    // (unchanged — Modal swap-target streaming is out of scope for this fix).
  }

  // GATE 2: the box must be live (the handshake never spins one up).
  if (!lease || (lease.liveness !== "warm" && lease.liveness !== "draining")) {
    return null;
  }

  // FAST PATH: the terminal tunnel URL is stable for the life of the (epoch-fenced)
  // box, so when the lease already caches it, mint ONLY a fresh scoped token (HMAC,
  // sub-millisecond) against the cached URL — no box resume/exec at all. A rollover
  // advances the epoch and clears terminalDataPlaneUrl (commitWarmingToWarm), so a
  // cached URL here is always the current epoch's live ttyd tunnel.
  if (lease.terminalDataPlaneUrl) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await mintStreamToken(secret, {
      workspaceId,
      sessionId: session.id,
      viewerId,
      leaseEpoch: lease.leaseEpoch,
      port: TERMINAL_STREAM_PORT,
      nowSeconds,
    });
    return {
      url: lease.terminalDataPlaneUrl,
      token,
      expiresAt: new Date((nowSeconds + STREAM_TOKEN_DEFAULT_TTL_SECONDS) * 1000).toISOString(),
      leaseEpoch: lease.leaseEpoch,
    };
  }

  // Resume the LIVE box by id (lease.resume_state authoritative), ensure ttyd, and
  // resolve the 7681 tunnel + mint the scoped token, IN-PROCESS.
  const envelope = lease.resumeState ?? (await getSandboxSessionEnvelope(db, workspaceId, session.id));
  let established: EstablishedSandboxSession | undefined;
  try {
    // On a cold-restore this create() must carry the SAME stable run-env the turn
    // declares, so a later turn finds no manifest-env delta.
    const environment = await sessionAttachEnvironment(services, workspaceId, session);
    established = input.establish
      ? await input.establish(envelope)
      : await establishSandboxSessionFromEnvelope(settings, envelope, {
          sessionId: session.id,
          backendOverride: session.sandboxBackend,
          environment,
        });

    // Idempotent ttyd launch (flock-guarded; a no-op when already up). A box that
    // genuinely can't run it degrades to the sse-events firehose, not a throw.
    try {
      await ensureTerminalServer(established.session, { port: TERMINAL_STREAM_PORT });
    } catch (error) {
      if (error instanceof TerminalServerUnsupportedError) {
        return null;
      }
      throw error;
    }

    // Resolve the provider tunnel for 7681 + mint the scoped token, IN-PROCESS.
    // exposeStreamPort is port-agnostic; it returns transport "vnc-ws"/client
    // "novnc" tags we ignore for the terminal (the contract carries pty-ws) — we
    // use only its url/token/expiresAt.
    let exposed: Awaited<ReturnType<typeof exposeStreamPort>>;
    try {
      exposed = await exposeStreamPort(established.session, {
        workspaceId,
        sessionId: session.id,
        viewerId,
        leaseEpoch: lease.leaseEpoch,
        streamTokenSecret: secret,
        port: TERMINAL_STREAM_PORT,
      });
    } catch (error) {
      if (error instanceof StreamPortUnavailableError) {
        return null;
      }
      throw error;
    }

    // Record the resolved terminal URL on the lease under the epoch fence. A fence
    // miss (box re-established under a newer epoch mid-call) is a no-op; we still
    // return the cell we minted for our epoch.
    await recordLeaseTerminalDataPlaneUrl(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      expectedEpoch: lease.leaseEpoch,
      terminalDataPlaneUrl: exposed.url,
    });

    return {
      url: exposed.url,
      token: exposed.token,
      expiresAt: exposed.expiresAt,
      leaseEpoch: lease.leaseEpoch,
    };
  } catch {
    // Any other failure degrades the terminal pty-ws cell to the sse-events
    // firehose rather than failing the whole handshake.
    return null;
  } finally {
    await dropEstablishedHandle(established);
  }
}

// ============================================================================
// M8b — the SELFHOSTED relay stream cell.
//
// When the session's ACTIVE sandbox is a selfhosted machine (a swap target, or the
// session's own selfhosted group box), the desktop/terminal stream does NOT ride a
// Modal provider tunnel — it rides the `opengeni-relay` edge. The selfhosted
// session's `resolveExposedPort(port)` returns the relay URL SHAPE (host/port/tls/
// path + the `ws=&agent=&port=&channel=` routing query), and exposeStreamPort mints
// the scoped `ogs_` token. The CRITICAL M8b seam: the token is fenced by the swap
// `active_epoch` (NOT the Modal lease epoch), so the relay's stale-viewer fence
// rejects a viewer whose token predates a swap-away — it cannot reach a machine the
// session swapped off of. control ops are already active-epoch-fenced (the routing
// proxy); this closes the STREAM side.
// ============================================================================

// Build a ControlRpc backed by the NATS events bus (mirrors fleet.ts:controlRpc).
function controlRpc(bus: EventBus | undefined): ControlRpc {
  return new NatsControlRpc(async (): Promise<NatsRequestConnection | null> => {
    if (!bus) {
      return null;
    }
    return bus.getRequestConnection();
  });
}

/**
 * Mint the relay stream cell against the session's ACTIVE selfhosted machine,
 * fenced by active_epoch. Returns null (degrade, never throw) when the active
 * sandbox is not selfhosted, the agent is offline, or the relay channel can't be
 * ensured. `sandbox` is passed in already-fetched to avoid a duplicate getSandbox.
 */
async function tryMintActiveSelfhostedStream(
  services: ViewerServices,
  input: { session: Session; viewerId: string; workspaceId: string; port: number; sandbox: SandboxRecord },
  // optional test seam (mirrors the existing `establish?` seam pattern): inject a
  // fake relay-resolving session; production NEVER passes it.
  resolveSelfhostedSession?: (sandbox: SandboxRecord) => Promise<{ resolveExposedPort?: (port: number) => Promise<unknown> }>,
): Promise<TerminalStreamMint | null> {
  const { settings, bus } = services;
  const { session, workspaceId, port, sandbox } = input;
  if (!sandbox.enrollmentId) {
    return null;
  }
  // The relay needs NATS; degrade to null without a bus.
  if (!bus && !resolveSelfhostedSession) {
    return null;
  }
  let shSession: { resolveExposedPort?: (port: number) => Promise<unknown> };
  try {
    if (resolveSelfhostedSession) {
      shSession = await resolveSelfhostedSession(sandbox);
    } else {
      const client = new SelfhostedSandboxClient({
        workspaceId,
        relay: relayConfigFromSettings(settings),
        controlRpcFactory: () => controlRpc(bus),
        agentId: sandbox.enrollmentId,
        epoch: session.activeEpoch,
      });
      shSession = await client.resume({ agentId: sandbox.enrollmentId });
    }
  } catch {
    return null;
  }
  return mintSelfhostedStream(services, {
    workspaceId,
    sessionId: session.id,
    viewerId: input.viewerId,
    activeEpoch: session.activeEpoch,
    port,
    session: shSession,
  });
}

/** The structural slice of a selfhosted session the relay stream mint needs. */
type RelayResolvableSession = {
  resolveExposedPort?: (port: number) => Promise<unknown>;
};

export type MintSelfhostedStreamInput = {
  workspaceId: string;
  sessionId: string;
  /** The viewer holder / principal id the scoped token is minted for. */
  viewerId: string;
  /** The swap fence: the session's `active_epoch`. The minted `ogs_` token carries
   *  THIS as its leaseEpoch claim so the relay rejects a stale-epoch (swapped-away)
   *  viewer. */
  activeEpoch: number;
  /** The exposed stream port (6080 desktop / 7681 terminal). */
  port: number;
  /** The resolvable selfhosted session (the routing proxy resolves the active
   *  selfhosted backend; its `resolveExposedPort` returns the relay endpoint). */
  session: RelayResolvableSession;
};

/**
 * Mint the selfhosted relay stream cell for a viewer against the session's ACTIVE
 * selfhosted machine, IN-PROCESS. Resolves the relay endpoint via the selfhosted
 * session's `resolveExposedPort` and mints the scoped `ogs_` token FENCED BY THE
 * SWAP `active_epoch`. Returns null when the stream tier degrades (no stream-token
 * secret, the agent is offline / cannot ensure a channel) — the caller surfaces
 * transport:null, never an exception.
 *
 * The token is RECORDED against the viewer holder by the caller and is NEVER a URL
 * query param (the relay validates the in-band token); the relay's stale-viewer
 * fence uses the token's leaseEpoch claim (== activeEpoch here).
 */
export async function mintSelfhostedStream(
  services: ViewerServices,
  input: MintSelfhostedStreamInput,
): Promise<TerminalStreamMint | null> {
  const { settings } = services;
  const secret = resolveStreamTokenSecret(settings);
  if (!secret) {
    return null;
  }
  const viewerId = viewerIdAsUuid(input.viewerId);
  if (typeof input.session?.resolveExposedPort !== "function") {
    return null;
  }
  try {
    // exposeStreamPort threads the epoch we pass into the `ogs_` token's leaseEpoch
    // claim. For selfhosted we pass the swap active_epoch — THE fence the relay
    // enforces so a swapped-away viewer is rejected.
    const exposed = await exposeStreamPort(input.session, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      viewerId,
      leaseEpoch: input.activeEpoch,
      streamTokenSecret: secret,
      port: input.port,
    });
    return {
      url: exposed.url,
      token: exposed.token,
      expiresAt: exposed.expiresAt,
      leaseEpoch: input.activeEpoch,
    };
  } catch (error) {
    // A headless / offline / channel-ensure failure degrades the cell to
    // transport:null rather than throwing (mirrors the Modal mint paths).
    if (error instanceof StreamPortUnavailableError) {
      return null;
    }
    return null;
  }
}

// The framebuffer geometry from settings (streamResolutionWidth/Height; default
// 1280x800, the spike's proven geometry).
function defaultResolution(settings: Settings): [number, number] {
  return [settings.streamResolutionWidth, settings.streamResolutionHeight];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Coerce a viewer/principal id into a valid UUID for the scoped stream-token
 * payload (StreamTokenPayload.viewerId is z.string().uuid()).
 *
 * The GET stream-capabilities handshake mints a token scoped to the CALLING
 * PRINCIPAL — grant.subjectId — which for an API-key principal is a NON-UUID like
 * "configured:key". Passing that straight to mintStreamToken threw a ZodError in
 * StreamTokenPayload.parse, which escaped as an uncaught 500 (caps-500 bug). The
 * browser's managed-session subject IS a UUID and is returned unchanged, so it is
 * unaffected. A non-UUID principal is mapped to a DETERMINISTIC v5-shaped UUID
 * (SHA-256 of the raw id, RFC-4122 version/variant bits set) so the same
 * principal always mints the same viewerId (stable scoping; idempotent re-mint).
 */
function viewerIdAsUuid(rawViewerId: string): string {
  if (UUID_RE.test(rawViewerId)) {
    return rawViewerId;
  }
  const hex = createHash("sha256").update(`opengeni:stream-viewer:${rawViewerId}`).digest("hex");
  // Shape the first 16 bytes as a version-5 UUID (deterministic, name-based).
  const b = hex.slice(0, 32).split("");
  b[12] = "5"; // version 5
  const variantNibble = (parseInt(b[16]!, 16) & 0x3) | 0x8; // RFC-4122 variant (8-b)
  b[16] = variantNibble.toString(16);
  const s = b.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
