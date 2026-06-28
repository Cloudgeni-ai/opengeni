// Selfhosted capability negotiation (M3, dossier §10.2 item 4).
//
// `negotiateSelfhostedCapabilities` resolves the selfhosted-specific cells from
//   (a) the M2 enrollment row (consent / display / status / lastSeenAt), and
//   (b) a LIVENESS PROBE (a `ControlRpc` Ping, mockable) — "is there a responder
//       on the subject right now?"
// into the right `SessionCapabilities` cells with the selfhosted reasons:
//   - online              → responder + consented: cells available.
//   - offline             → no enrollment / revoked / no responder: agent_offline.
//   - reconnecting        → a transient blip (a recent lastSeenAt but the probe
//                           missed): agent_reconnecting.
//   - consent_required    → enrolled but whole-machine / screen-control not acked:
//                           consent_required on the desktop/computer-use cells.
//   - display_unavailable → online but the machine has no display (headless, no
//                           Xvfb): the desktop/computer-use cells degrade with
//                           display_unavailable.
//
// It REUSES `negotiateCapabilities` for the descriptor-shaped cells (so the
// "every cell present, degradation is a value" rule and the FS/Terminal/Git
// surface stay identical to Modal), then overlays the selfhosted liveness/consent
// /display reasons. The base function stays pure + synchronous; this is the
// selfhosted-aware entrypoint the API/worker call.

import type {
  CapabilityUnavailableReason,
  SandboxOs,
  SessionCapabilities,
} from "@opengeni/contracts";
import { negotiateCapabilities, type NegotiationContext } from "../select";
import type { SelfhostedSession } from "./session";

/**
 * The structural slice of the M2 `@opengeni/db` `EnrollmentRecord` the selfhosted
 * negotiation reads. Defined STRUCTURALLY (not imported from `@opengeni/db`) so
 * the agent-loop-free sandbox leaf does not couple to the DB package's graph —
 * the API/worker pass an `EnrollmentRecord`, which satisfies this shape. The
 * fields: `status` (active gates reachability), `exposure` +
 * `allowScreenControl` (whole-machine + screen-control consent),`hasDisplay`
 * (the display plane), `lastSeenAt` (the reconnecting-window disambiguator).
 */
export interface SelfhostedEnrollment {
  status: string;
  exposure: string;
  allowScreenControl: boolean;
  hasDisplay: boolean;
  lastSeenAt: string | null;
}

/** The derived liveness state of a selfhosted machine (the online/offline/
 *  reconnecting/consent/display matrix). */
export interface SelfhostedLivenessState {
  /** The dominant machine state. */
  state: "online" | "reconnecting" | "offline";
  /** Whole-machine + screen-control consent acknowledged (gates desktop input). */
  consented: boolean;
  /** A display (real or Xvfb) is present (gates the desktop pixel plane). */
  hasDisplay: boolean;
}

/**
 * The window after `lastSeenAt` within which a missed liveness probe is read as a
 * transient BLIP (`reconnecting`) rather than a hard `offline`. Mirrors the
 * resiliency model (§10.6: reconnecting after 1 missed window, offline after
 * ~30s). A probe miss with a lastSeenAt inside this window → reconnecting.
 */
export const SELFHOSTED_RECONNECT_WINDOW_MS = 30_000;

/**
 * Derive the selfhosted liveness state from the enrollment row + a liveness probe
 * outcome. The probe is the authoritative "is the agent answering NOW" signal;
 * `lastSeenAt` disambiguates a probe-miss into reconnecting (recent) vs offline
 * (stale / never seen).
 *
 *   - no enrollment / revoked         → offline (the machine isn't enrolled).
 *   - probe responded                 → online.
 *   - probe missed, lastSeenAt recent → reconnecting (a transient blip).
 *   - probe missed, lastSeenAt stale  → offline.
 */
export function selfhostedLiveness(input: {
  enrollment: SelfhostedEnrollment | null;
  /** The ControlRpc Ping outcome: true iff a responder answered. */
  probeResponded: boolean;
  /** Override the clock (tests). */
  now?: Date;
}): SelfhostedLivenessState {
  const { enrollment } = input;
  if (!enrollment || enrollment.status !== "active") {
    return { state: "offline", consented: false, hasDisplay: false };
  }
  const consented = enrollment.exposure === "whole-machine" && enrollment.allowScreenControl;
  const hasDisplay = enrollment.hasDisplay;
  if (input.probeResponded) {
    return { state: "online", consented, hasDisplay };
  }
  // Probe missed → reconnecting if we saw it recently, else offline.
  const now = (input.now ?? new Date()).getTime();
  const lastSeen = enrollment.lastSeenAt ? new Date(enrollment.lastSeenAt).getTime() : null;
  if (lastSeen !== null && now - lastSeen <= SELFHOSTED_RECONNECT_WINDOW_MS) {
    return { state: "reconnecting", consented, hasDisplay };
  }
  return { state: "offline", consented, hasDisplay };
}

export interface SelfhostedNegotiationInput {
  sessionId: string;
  os?: SandboxOs;
  leaseEpoch: number;
  /** The M2 enrollment row for the machine (null → never enrolled → offline). */
  enrollment: SelfhostedEnrollment | null;
  /** A live liveness probe — typically `session.ping()`. When a session is
   *  provided this is called; otherwise pass `probeResponded` explicitly. */
  session?: Pick<SelfhostedSession, "ping">;
  /** Explicit probe outcome (when no session is given, e.g. a pure read). */
  probeResponded?: boolean;
  /** The deployment desktop/terminal/computer-use policy toggles (threaded
   *  through to the base negotiation). */
  desktopEnabled?: boolean;
  terminalEnabled?: boolean;
  computerUseEnabled?: boolean;
  /** Whether the calling principal acknowledged the un-redacted desktop. */
  desktopAcknowledged?: boolean;
  shared?: boolean;
  sharedSessionIds?: string[];
  /** Override the clock (tests). */
  now?: Date;
}

/**
 * Negotiate the full `SessionCapabilities` document for a selfhosted machine,
 * with the online/offline/reconnecting/consent_required/display_unavailable cells
 * correctly decided. Async because it issues the liveness probe.
 */
export async function negotiateSelfhostedCapabilities(input: SelfhostedNegotiationInput): Promise<SessionCapabilities> {
  const probeResponded = input.probeResponded ?? (input.session ? await input.session.ping() : false);
  const liveness = selfhostedLiveness({
    enrollment: input.enrollment,
    probeResponded,
    ...(input.now ? { now: input.now } : {}),
  });

  // The base context: map the machine state onto the lease `liveness` axis so the
  // descriptor-shaped cells (FS/Terminal/Git/Desktop) negotiate as on a warm box
  // when online, and a cold box when not reachable (no live tunnel). The
  // selfhosted overlay below then stamps the selfhosted-specific reasons.
  const baseLiveness: NegotiationContext["liveness"] = liveness.state === "online" ? "warm" : "cold";
  const base: NegotiationContext = {
    sessionId: input.sessionId,
    backend: "selfhosted",
    os: input.os ?? "linux",
    liveness: baseLiveness,
    leaseEpoch: input.leaseEpoch,
    desktopEnabled: input.desktopEnabled ?? true,
    terminalEnabled: input.terminalEnabled ?? true,
    computerUseEnabled: input.computerUseEnabled ?? true,
    ...(input.desktopAcknowledged !== undefined ? { desktopAcknowledged: input.desktopAcknowledged } : {}),
    ...(input.shared !== undefined ? { shared: input.shared } : {}),
    ...(input.sharedSessionIds !== undefined ? { sharedSessionIds: input.sharedSessionIds } : {}),
    ...(input.now ? { now: input.now } : {}),
  };
  const caps = negotiateCapabilities(base);

  // ── Overlay the selfhosted liveness/consent/display reasons ────────────────

  // When the machine is not online, the Channel-A surface (FS/Terminal/Git) and
  // the desktop plane cannot be reached — stamp the machine-liveness reason. This
  // is the dominant degrade (like os_unsupported): an offline/reconnecting agent
  // knocks out every reachable capability with the single coherent reason.
  if (liveness.state !== "online") {
    const reason: CapabilityUnavailableReason = liveness.state === "offline" ? "agent_offline" : "agent_reconnecting";
    return {
      ...caps,
      FileSystem: { ...caps.FileSystem, available: false, readOnly: true, reason },
      Terminal: { ...caps.Terminal, transport: null, url: null, token: null, expiresAt: null, reason },
      Git: { ...caps.Git, available: false, reason },
      DesktopStream: {
        ...caps.DesktopStream,
        transport: null,
        client: null,
        mode: "read-only",
        url: null,
        token: null,
        expiresAt: null,
        requiresAcknowledgment: false,
        acknowledged: false,
        shared: false,
        sharedSessionIds: [],
        reason,
      },
      Recording: { ...caps.Recording, available: false, modes: [], codecs: [], reason },
      ComputerUse: { ...caps.ComputerUse, available: false, reason },
    };
  }

  // Online: FS/Terminal/Git stay as the base negotiated them (the machine is
  // reachable). The desktop/computer-use plane carries the consent + display
  // gates. Precedence on the desktop cell: a missing display (the machine is
  // headless, no Xvfb) > missing consent. A headless online machine reports
  // display_unavailable; a displayed-but-unconsented machine reports
  // consent_required. (If the base already degraded the desktop for a policy
  // reason — desktop disabled / no stream-token secret — that base reason wins
  // and we leave it; we only stamp a selfhosted reason on a cell the base left
  // AVAILABLE.)
  const desktopGate: CapabilityUnavailableReason | null = !liveness.hasDisplay
    ? "display_unavailable"
    : !liveness.consented
      ? "consent_required"
      : null;

  if (desktopGate) {
    return {
      ...caps,
      DesktopStream: caps.DesktopStream.transport !== null
        ? {
          ...caps.DesktopStream,
          transport: null,
          client: null,
          mode: "read-only",
          url: null,
          token: null,
          expiresAt: null,
          requiresAcknowledgment: false,
          acknowledged: false,
          shared: false,
          sharedSessionIds: [],
          reason: desktopGate,
        }
        : caps.DesktopStream,
      Recording: caps.Recording.available
        ? { ...caps.Recording, available: false, modes: [], codecs: [], reason: desktopGate }
        : caps.Recording,
      ComputerUse: caps.ComputerUse.available
        ? { ...caps.ComputerUse, available: false, reason: desktopGate }
        : caps.ComputerUse,
    };
  }

  // Fully online + displayed + consented: the base negotiation already produced
  // the correct available cells (desktop vnc-ws, computer-use available, etc.).
  return caps;
}
