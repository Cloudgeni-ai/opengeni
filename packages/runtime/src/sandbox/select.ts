// Backend selection + capability negotiation/degradation (module 03 §0, §5).
//
// negotiateCapabilities() turns a static CapabilityDescriptor + runtime context
// (the selected OS, the lease liveness/epoch, and the deployment's desktop
// policy) into a coherent SessionCapabilities document. The load-bearing rule
// (master-spine Part D): a capability cell is ALWAYS present — when unavailable
// it is `available:false` + a typed `reason`, NEVER absent. Degradation is a
// value, not a silent drop.

import {
  CAPABILITY_DESCRIPTORS,
  type CapabilityDescriptor,
  type CapabilityUnavailableReason,
  type SandboxBackend,
  type SandboxOs,
  type SessionCapabilities,
} from "@opengeni/contracts";

export interface NegotiationContext {
  sessionId: string;
  backend: SandboxBackend;
  os: SandboxOs;
  /** Current lease liveness; cold means nothing is provisioned yet. */
  liveness: "cold" | "warming" | "warm" | "draining";
  /** The lease epoch echoed on viewer heartbeats (the split-brain fence). */
  leaseEpoch: number;
  /** The deployment desktop toggle (settings.sandboxDesktopEnabled). */
  desktopEnabled: boolean;
  /** Whether the viewer has acknowledged the un-redacted desktop pixels. */
  desktopAcknowledged?: boolean;
  /** Override the negotiation clock (tests). */
  now?: Date;
}

/**
 * Resolve the descriptor for a backend. Throws on an unknown backend rather than
 * returning a half-formed default (the registry is the single source of truth).
 */
export function selectBackend(backend: SandboxBackend): CapabilityDescriptor {
  const descriptor = CAPABILITY_DESCRIPTORS[backend];
  if (!descriptor) {
    throw new Error(`Unknown sandbox backend "${backend}"`);
  }
  return descriptor;
}

/** True iff the descriptor lists the requested OS as supported. */
export function backendSupportsOs(descriptor: CapabilityDescriptor, os: SandboxOs): boolean {
  return descriptor.os.supported.includes(os);
}

/**
 * Negotiate a coherent SessionCapabilities document for (backend, os). Every
 * capability is reported with availability + a reason-when-unavailable; nothing
 * is ever absent. The reason precedence is: os_unsupported (the OS axis can't be
 * served at all) > the per-capability static feasibility > policy/liveness gates.
 */
export function negotiateCapabilities(ctx: NegotiationContext): SessionCapabilities {
  const descriptor = selectBackend(ctx.backend);
  const osSupported = backendSupportsOs(descriptor, ctx.os);
  const negotiatedAt = (ctx.now ?? new Date()).toISOString();

  // The dominant degrade: an unsupported OS knocks out every capability with a
  // single coherent reason.
  const osReason: CapabilityUnavailableReason | null = osSupported ? null : "os_unsupported";

  const fileSystem = (() => {
    if (osReason) {
      return { available: false, readOnly: true, root: descriptor.workspaceRoot, pathSep: "/" as const, treeMode: "lazy" as const, reason: osReason };
    }
    const cap = descriptor.capabilities.FileSystem;
    return {
      available: cap.available,
      readOnly: cap.readOnly,
      root: descriptor.workspaceRoot,
      pathSep: "/" as const,
      treeMode: "lazy" as const,
      reason: cap.available ? null : ("backend_unsupported" as const),
    };
  })();

  const terminal = (() => {
    const cap = descriptor.capabilities.Terminal;
    if (osReason) {
      return { transport: null, ptyCapable: false, shell: "/bin/bash", url: null, token: null, reason: osReason };
    }
    if (!cap.available) {
      return { transport: null, ptyCapable: false, shell: "/bin/bash", url: null, token: null, reason: "backend_unsupported" as const };
    }
    // pty-ws when the backend has a real PTY, else the SSE-events firehose.
    return {
      transport: cap.pty ? ("pty-ws" as const) : ("sse-events" as const),
      ptyCapable: cap.pty,
      shell: "/bin/bash",
      url: null,
      token: null,
      reason: null,
    };
  })();

  const git = (() => {
    const cap = descriptor.capabilities.Git;
    if (osReason) {
      return { available: false, repos: [], reason: osReason };
    }
    return { available: cap.available, repos: [], reason: cap.available ? null : ("backend_unsupported" as const) };
  })();

  const desktop = (() => {
    const cap = descriptor.capabilities.DesktopStream;
    // Reason precedence: OS > backend-tier feasibility > policy disable > cold lease.
    let reason: CapabilityUnavailableReason | null = null;
    let available = cap.available;
    if (osReason) {
      available = false;
      reason = osReason;
    } else if (!cap.available) {
      available = false;
      // Headless tiers expose the typed tier_headless reason; dev/none are
      // backend_unsupported for desktop.
      reason = descriptor.tier === "headless" ? "tier_headless" : "backend_unsupported";
    } else if (!ctx.desktopEnabled) {
      available = false;
      reason = "disabled_by_policy";
    } else if (ctx.liveness === "cold") {
      available = false;
      reason = "lease_cold";
    }
    return {
      transport: available ? cap.transport : null,
      client: available ? ("novnc" as const) : null,
      mode: "read-only" as const,
      url: null,
      token: null,
      expiresAt: null,
      resolution: [1024, 768] as [number, number],
      // Desktop pixels are ALWAYS un-redacted when present (the literal
      // framebuffer); the acknowledgment gate rests on this.
      unredacted: true,
      requiresAcknowledgment: available,
      acknowledged: available ? Boolean(ctx.desktopAcknowledged) : false,
      reason,
    };
  })();

  const recording = (() => {
    const cap = descriptor.capabilities.Recording;
    if (osReason) {
      return { available: false, modes: [] as ("manual" | "on-turn" | "on-verify")[], codecs: [] as ("h264-mp4" | "vp9-webm")[], reason: osReason };
    }
    if (!cap.available) {
      return { available: false, modes: [] as ("manual" | "on-turn" | "on-verify")[], codecs: [] as ("h264-mp4" | "vp9-webm")[], reason: descriptor.tier === "headless" ? ("tier_headless" as const) : ("backend_unsupported" as const) };
    }
    // Recording feasibility tracks desktop; policy-gate it the same way.
    if (!ctx.desktopEnabled) {
      return { available: false, modes: [] as ("manual" | "on-turn" | "on-verify")[], codecs: [] as ("h264-mp4" | "vp9-webm")[], reason: "disabled_by_policy" as const };
    }
    return {
      available: true,
      modes: ["manual", "on-turn", "on-verify"] as ("manual" | "on-turn" | "on-verify")[],
      codecs: ["h264-mp4", "vp9-webm"] as ("h264-mp4" | "vp9-webm")[],
      reason: null,
    };
  })();

  return {
    sessionId: ctx.sessionId,
    backend: ctx.backend,
    os: ctx.os,
    liveness: ctx.liveness,
    leaseEpoch: ctx.leaseEpoch,
    viewerHeartbeatIntervalMs: 30_000,
    FileSystem: fileSystem,
    Terminal: terminal,
    Git: git,
    DesktopStream: desktop,
    Recording: recording,
    negotiatedAt,
  };
}
