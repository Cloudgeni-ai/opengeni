// apps/api/src/sandbox/fleet.ts — the FLEET service backing the fleet MCP tools
// (M7): list / attach / swap / run_on / provision over the heterogeneous fleet
// (the session's Modal group box + the workspace's enrolled selfhosted machines).
//
// Each operation is workspace-scoped (the caller's grant) and, for the
// session-pointer mutations (attach/swap), session-scoped (the worker-signed
// sessionId claim). The swap is the epoch-fenced CAS `setActiveSandbox`: it bumps
// active_epoch + repoints active_sandbox_id, which the routing proxy reads on the
// NEXT tool call. Liveness for a selfhosted target is a real ControlRpc ping over
// the events bus (the subject IS the registry); a Modal box is "live" while its
// session group exists. `run_on` builds a one-off backend session and runs a
// single op WITHOUT touching the active pointer.

import type { Settings } from "@opengeni/config";
import {
  getEnrollment,
  getSandbox,
  listSandboxes,
  readActiveSandbox,
  requireSession,
  setActiveSandbox,
  type Database,
  type EnrollmentRecord,
  type SandboxRecord,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import {
  NatsControlRpc,
  selfhostedLiveness,
  SelfhostedSession,
  swapTargetEstablishability,
  type BackendUnresolvableCode,
  type ControlRpc,
  type NatsRequestConnection,
} from "@opengeni/runtime/sandbox";
import { HTTPException } from "hono/http-exception";
import { relayConfigFromSettings } from "./routing";

export type FleetServices = {
  db: Database;
  settings: Settings;
  bus?: EventBus;
};

export type FleetContext = {
  accountId: string;
  workspaceId: string;
  /** The calling session (the pointer the attach/swap mutates + whose group box
   *  is the default fleet member). */
  sessionId: string;
  /** The session's own group sandbox backend (modal/selfhosted/…). */
  sessionBackend: string;
  /** The session's own group sandbox id (the lease group). */
  sessionGroupId: string;
};

/**
 * Build a session-scoped {@link FleetContext}: load the session (workspace-
 * scoped), reject a session with no box (backend:none — the fleet is only
 * meaningful for a sandboxed session), and project its group backend/id. Shared
 * by the worker-signed MCP fleet tools and the user-authenticated swap REST
 * route so both resolve the SAME context (no drift). The `accountId`/`workspaceId`/
 * `sessionId` come from the trusted grant/route; the backend + group id come from
 * the session row.
 */
export async function buildFleetContextForSession(
  deps: { db: Database },
  ctx: { accountId: string; workspaceId: string; sessionId: string },
): Promise<FleetContext> {
  const session = await requireSession(deps.db, ctx.workspaceId, ctx.sessionId);
  if (session.sandboxBackend === "none") {
    throw new HTTPException(422, {
      message: "this session has no sandbox (backend: none); the fleet is unavailable",
    });
  }
  return {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    sessionBackend: session.sandboxBackend,
    sessionGroupId: session.sandboxGroupId,
  };
}

/** The dominant liveness of a fleet member, surfaced to the dock + the agent. */
export type FleetLiveness = "online" | "reconnecting" | "offline";

/**
 * A fleet member as the agent + the dock see it (the M8b/M9 UI seam — the
 * `sandboxes_list` response entry the dock renders). STABLE shape: the dock keys
 * on `id`, renders `name`/`kind`/`liveness`, and marks `active`. The session's own
 * Modal group box is a synthetic entry with `id: groupId`, `kind: "modal"`, and a
 * null `enrollmentId`; an enrolled machine carries its sandbox + enrollment ids.
 */
export type FleetSandboxEntry = {
  /** The sandbox id used as the attach/swap/run_on `target`. For the session's
   *  own group box this is the group id (a null active pointer == this box). */
  id: string;
  kind: "modal" | "selfhosted";
  name: string;
  liveness: FleetLiveness;
  /** True for the session's currently-active sandbox (the routing target). */
  active: boolean;
  /** True for the session's own group box (the default/home sandbox). */
  isSessionGroup: boolean;
  enrollmentId: string | null;
  /** Whether this target can be attached/swapped to right now (live + addressable). */
  attachable: boolean;
  /** Selfhosted only: whether whole-machine + screen-control consent is acked. */
  consented?: boolean;
  /** Selfhosted only: whether a display (real/Xvfb) is present. */
  hasDisplay?: boolean;
  lastSeenAt?: string | null;
};

export type FleetListResult = {
  /** The session's currently-active sandbox id, or null == the group box. */
  activeSandboxId: string | null;
  activeEpoch: number;
  sandboxes: FleetSandboxEntry[];
};

/** A swap/attach outcome the tool returns. On a rejection, `code` carries the
 *  typed reason (issue #341 typed diagnostics) alongside the human `reason`. */
export type FleetSwapResult = {
  swapped: boolean;
  activeSandboxId: string | null;
  activeEpoch: number;
  reason?: string;
  code?: BackendUnresolvableCode | "concurrent_swap";
};

const PROBE_TIMEOUT_MS = 5_000;

function controlRpc(bus: EventBus | undefined): ControlRpc {
  return new NatsControlRpc(async (): Promise<NatsRequestConnection | null> => {
    if (!bus) {
      return null;
    }
    return bus.getRequestConnection();
  });
}

/** Probe an enrolled machine's liveness: a real ControlRpc ping (the subject IS
 *  the registry), mapped through `selfhostedLiveness` (the enrollment row's
 *  status/consent/display + lastSeenAt disambiguate a probe-miss into
 *  reconnecting vs offline). A revoked/never-seen enrollment is offline without a
 *  probe. */
async function probeEnrollment(
  services: FleetServices,
  workspaceId: string,
  enrollment: EnrollmentRecord,
): Promise<{ liveness: FleetLiveness; consented: boolean; hasDisplay: boolean }> {
  const { settings, bus } = services;
  let probeResponded = false;
  if (enrollment.status === "active") {
    const session = new SelfhostedSession({
      workspaceId,
      agentId: enrollment.id,
      controlRpc: controlRpc(bus),
      relay: relayConfigFromSettings(settings),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    try {
      probeResponded = await session.ping();
    } catch {
      probeResponded = false;
    }
  }
  const state = selfhostedLiveness({
    enrollment: {
      status: enrollment.status,
      exposure: enrollment.exposure,
      allowScreenControl: enrollment.allowScreenControl,
      hasDisplay: enrollment.hasDisplay,
      lastSeenAt: enrollment.lastSeenAt,
      wentOfflineAt: enrollment.wentOfflineAt,
      wentOfflineReason: enrollment.wentOfflineReason,
    },
    probeResponded,
  });
  return { liveness: state.state, consented: state.consented, hasDisplay: state.hasDisplay };
}

/**
 * List the fleet: the session's own Modal group box (a synthetic entry) + the
 * workspace's first-class selfhosted sandboxes (each probed for liveness), each
 * with an `active` marker derived from the session's active pointer.
 */
export async function listFleet(
  services: FleetServices,
  ctx: FleetContext,
): Promise<FleetListResult> {
  const { db } = services;
  const pointer = (await readActiveSandbox(db, ctx.workspaceId, ctx.sessionId)) ?? {
    activeSandboxId: null,
    activeEpoch: 0,
  };

  const entries: FleetSandboxEntry[] = [];

  // The session's own group box (the default/home sandbox; null active pointer ==
  // this box). It is live by virtue of being the session's resumable group.
  const groupActive = pointer.activeSandboxId === null;
  entries.push({
    id: ctx.sessionGroupId,
    kind: ctx.sessionBackend === "selfhosted" ? "selfhosted" : "modal",
    name: "session sandbox",
    liveness: "online",
    active: groupActive,
    isSessionGroup: true,
    enrollmentId: null,
    attachable: true,
  });

  // The workspace's first-class selfhosted sandboxes (enrolled machines). Probe
  // each for liveness; a missing enrollment is offline.
  const sandboxes = await listSandboxes(db, ctx.workspaceId);
  for (const sandbox of sandboxes) {
    if (sandbox.kind !== "selfhosted" || !sandbox.enrollmentId) {
      continue;
    }
    const enrollment = await getEnrollment(db, ctx.workspaceId, sandbox.enrollmentId);
    const probe = enrollment
      ? await probeEnrollment(services, ctx.workspaceId, enrollment)
      : { liveness: "offline" as FleetLiveness, consented: false, hasDisplay: false };
    entries.push({
      id: sandbox.id,
      kind: "selfhosted",
      name: sandbox.name,
      liveness: probe.liveness,
      active: pointer.activeSandboxId === sandbox.id,
      isSessionGroup: false,
      enrollmentId: sandbox.enrollmentId,
      attachable: probe.liveness === "online",
      consented: probe.consented,
      hasDisplay: probe.hasDisplay,
      lastSeenAt: enrollment?.lastSeenAt ?? null,
    });
  }

  return {
    activeSandboxId: pointer.activeSandboxId,
    activeEpoch: pointer.activeEpoch,
    sandboxes: entries,
  };
}

/** Resolve a swap target id → the value `setActiveSandbox` writes. The session's
 *  own group id maps to NULL (the default pointer); a first-class sandbox id is
 *  validated (workspace ownership + liveness) and written verbatim. */
async function resolveTarget(
  services: FleetServices,
  ctx: FleetContext,
  target: string,
): Promise<
  | { ok: true; targetSandboxId: string | null }
  | { ok: false; reason: string; code: BackendUnresolvableCode }
> {
  // The session's own group box → the default pointer (null).
  if (target === ctx.sessionGroupId || target === "session" || target === "default") {
    return { ok: true, targetSandboxId: null };
  }
  const sandbox = await getSandbox(services.db, ctx.workspaceId, target);
  if (!sandbox) {
    return {
      ok: false,
      reason: `sandbox ${target} not found in this workspace`,
      code: "stale_pointer",
    };
  }
  // ESTABLISHER-CAPABILITY GATE (issue #341 invariant A): a target must be
  // establishable by a turn's routing context BEFORE the epoch-fenced CAS commits
  // the pointer, or a "successful" swap strands every following op on a backend no
  // turn can resume. `swapTargetEstablishability` is the SAME predicate the turn
  // resolver consults, so admission and establishment never disagree. Any sandbox
  // reaching here is NOT the session's own group box (handled above), so a Modal
  // sibling is rejected pre-commit rather than admitted-then-stranded.
  const establishable = swapTargetEstablishability({
    kind: sandbox.kind,
    isSessionGroup: false,
  });
  if (!establishable.ok) {
    return { ok: false, reason: establishable.reason, code: establishable.code };
  }
  if (sandbox.kind === "selfhosted") {
    if (!sandbox.enrollmentId) {
      return {
        ok: false,
        reason: `selfhosted sandbox ${target} has no enrollment`,
        code: "offline_enrollment",
      };
    }
    const enrollment = await getEnrollment(services.db, ctx.workspaceId, sandbox.enrollmentId);
    if (!enrollment) {
      return {
        ok: false,
        reason: `enrollment for sandbox ${target} not found`,
        code: "offline_enrollment",
      };
    }
    const probe = await probeEnrollment(services, ctx.workspaceId, enrollment);
    if (probe.liveness !== "online") {
      return {
        ok: false,
        reason: `sandbox ${target} is ${probe.liveness}; cannot attach to a non-online machine`,
        code: "offline_enrollment",
      };
    }
  }
  return { ok: true, targetSandboxId: sandbox.id };
}

/**
 * THE SWAP (and attach — identical mechanic). Validate the target's ownership +
 * liveness, then repoint the session via the epoch-fenced CAS `setActiveSandbox`:
 * read the current epoch, then CAS on it. A concurrent double-swap lets exactly
 * one win; the loser re-reads + may retry. The bumped epoch fences any in-flight
 * op cached against the old pointer, which then retries against the new active
 * sandbox (the routing proxy's fenced-retry role).
 */
export async function swapActiveSandbox(
  services: FleetServices,
  ctx: FleetContext,
  target: string,
  // The session's working directory to seed alongside the pointer (create-time
  // machine targeting). OMITTED ⇒ the column is left unchanged (a live swap/attach
  // never touches it); threaded straight into the epoch-fenced setActiveSandbox CAS.
  workingDir?: string | null,
): Promise<FleetSwapResult> {
  const resolved = await resolveTarget(services, ctx, target);
  if (!resolved.ok) {
    const pointer = (await readActiveSandbox(services.db, ctx.workspaceId, ctx.sessionId)) ?? {
      activeSandboxId: null,
      activeEpoch: 0,
    };
    // Fail BEFORE the CAS: the pointer + epoch are read back unchanged and echoed,
    // so an unestablishable target never mutates the session's routing state.
    return {
      swapped: false,
      activeSandboxId: pointer.activeSandboxId,
      activeEpoch: pointer.activeEpoch,
      reason: resolved.reason,
      code: resolved.code,
    };
  }

  // Read the current epoch, then CAS on it (the fence). One retry on a lost race
  // (a concurrent swap bumped the epoch between read and write).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pointer = (await readActiveSandbox(services.db, ctx.workspaceId, ctx.sessionId)) ?? {
      activeSandboxId: null,
      activeEpoch: 0,
    };
    // No-op swap (already pointed there) is a success without an epoch bump churn.
    if (pointer.activeSandboxId === resolved.targetSandboxId) {
      return {
        swapped: true,
        activeSandboxId: pointer.activeSandboxId,
        activeEpoch: pointer.activeEpoch,
      };
    }
    const result = await setActiveSandbox(services.db, {
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      targetSandboxId: resolved.targetSandboxId,
      expectedEpoch: pointer.activeEpoch,
      ...(workingDir !== undefined ? { workingDir } : {}),
    });
    if (result.swapped && result.pointer) {
      return {
        swapped: true,
        activeSandboxId: result.pointer.activeSandboxId,
        activeEpoch: result.pointer.activeEpoch,
      };
    }
    // CAS lost (a concurrent swap won) — re-read + retry once.
  }
  const pointer = (await readActiveSandbox(services.db, ctx.workspaceId, ctx.sessionId)) ?? {
    activeSandboxId: null,
    activeEpoch: 0,
  };
  return {
    swapped: false,
    activeSandboxId: pointer.activeSandboxId,
    activeEpoch: pointer.activeEpoch,
    reason: "a concurrent swap won the epoch fence; re-read and retry",
    code: "concurrent_swap",
  };
}

export type RunOnOp =
  | { kind: "exec"; cmd: string; workdir?: string }
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; content: string };

export type RunOnResult = {
  target: string;
  kind: string;
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  content?: string;
  bytesWritten?: number;
  reason?: string;
};

/**
 * Run a ONE-OFF op against a SPECIFIC target WITHOUT changing the active pointer
 * (the dossier `run_on`). Only selfhosted targets are routable as a one-off here
 * (a Modal target is the session's group box, reached via the normal Channel-A /
 * turn path — `run_on` is for reaching a NON-active enrolled machine without
 * swapping). The op is fenced under the target's enrollment, addressed to its
 * agent subject; an offline machine surfaces a clear reason, never a wrong-box
 * landing.
 */
export async function runOnSandbox(
  services: FleetServices,
  ctx: FleetContext,
  target: string,
  op: RunOnOp,
): Promise<RunOnResult> {
  const sandbox = await getSandbox(services.db, ctx.workspaceId, target);
  if (!sandbox) {
    return {
      target,
      kind: op.kind,
      ok: false,
      reason: `sandbox ${target} not found in this workspace`,
    };
  }
  if (sandbox.kind !== "selfhosted" || !sandbox.enrollmentId) {
    return {
      target,
      kind: op.kind,
      ok: false,
      reason: `run_on routes one-off ops to enrolled selfhosted machines; ${sandbox.kind} targets are reached via the active sandbox (swap to it first)`,
    };
  }
  const enrollment = await getEnrollment(services.db, ctx.workspaceId, sandbox.enrollmentId);
  if (!enrollment || enrollment.status !== "active") {
    return { target, kind: op.kind, ok: false, reason: `sandbox ${target} is not enrolled/active` };
  }

  const session = new SelfhostedSession({
    workspaceId: ctx.workspaceId,
    agentId: sandbox.enrollmentId,
    controlRpc: controlRpc(services.bus),
    relay: relayConfigFromSettings(services.settings),
  });

  try {
    if (op.kind === "exec") {
      const res = await session.exec({
        cmd: op.cmd,
        ...(op.workdir ? { workdir: op.workdir } : {}),
      });
      return {
        target,
        kind: "exec",
        ok: true,
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
      };
    }
    if (op.kind === "read") {
      const bytes = await session.readFile({ path: op.path });
      return { target, kind: "read", ok: true, content: new TextDecoder().decode(bytes) };
    }
    // write
    const bytesWritten = await session.writeFile({ path: op.path, content: op.content });
    return { target, kind: "write", ok: true, bytesWritten };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { target, kind: op.kind, ok: false, reason };
  }
}

export type ProvisionResult =
  | {
      kind: "selfhosted";
      instructions: string;
      installCommandUnix: string;
      installCommandWindows: string;
      verificationUri: string;
      note: string;
    }
  | { kind: "modal"; sandbox: SandboxRecord; note: string };

/**
 * Provision a new fleet member.
 *   - selfhosted → return the device-flow enrollment instructions (the agent
 *     surfaces them to a HUMAN, who installs the agent + enrolls — the agent
 *     cannot click the loud whole-machine consent itself).
 *   - modal → create a first-class named modal `sandboxes` record (a swap target).
 *     NOTE: the Modal BOX is materialized lazily when first swapped-to (Modal
 *     lifecycle is owned by the lease — unchanged per dossier §21).
 */
export async function provisionSandbox(
  services: FleetServices,
  ctx: FleetContext,
  input: { kind: "selfhosted" | "modal"; name?: string },
): Promise<ProvisionResult> {
  if (input.kind === "selfhosted") {
    const base = (services.settings.publicBaseUrl ?? "https://get.opengeni.ai").replace(/\/+$/, "");
    return {
      kind: "selfhosted",
      instructions:
        "Share these instructions with a human operator. They install the OpenGeni agent on the machine, run `opengeni-agent enroll`, complete the device-flow at the verification URL (the loud whole-machine + screen-control consent), and the machine then appears here as an attachable selfhosted sandbox.",
      // Install from THIS control plane's origin (not a hardcoded public CDN): the
      // served install script is rewritten to pull the per-SHA agent baked into
      // this exact deployment (see apps/api/src/routes/install.ts), so a deployed
      // env is self-contained and a private/air-gapped one works with no public DNS.
      installCommandUnix: `curl -fsSL ${base}/install.sh | sh`,
      installCommandWindows: `irm ${base}/install.ps1 | iex`,
      verificationUri: `${base}/device`,
      note: "Whole-machine access requires explicit human consent in the device-flow web page; the agent cannot self-consent.",
    };
  }
  // modal: create a first-class named modal sandbox record. NOTE: a session cannot
  // yet be swapped onto a second Modal box — cross-group Modal routing is not built,
  // so `sandbox_swap` to this id is rejected (unsupported_backend_context). The
  // response says so plainly rather than implying an attach that does not work.
  const { createSandbox } = await import("@opengeni/db");
  const sandbox = await createSandbox(services.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    kind: "modal",
    name: input.name?.trim() || "modal-box",
  });
  return {
    kind: "modal",
    sandbox,
    note: "A named Modal sandbox record was created, but it is NOT yet attachable as a swap target: routing a session onto a second Modal box is not supported yet, so a sandbox_swap to this id is rejected. Use the session's own box (the default) or attach a Connected Machine instead.",
  };
}
