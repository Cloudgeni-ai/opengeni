// State + payload mapping for the rich create-session form.
//
// The composer is organised around ONE top-level question — "Where should this
// run?" — modelled here as a discriminated `ComputeTarget`. That choice is the
// parent that gates the rest of the form (repos/env on a managed sandbox; a
// machine + working folder on a connected machine). `SessionDraft` collapses the
// old split between the per-mount "advanced" draft and the global selection so
// the compute target and everything it gates live in one consistent state.
//
// Wire fields are unchanged (PR-1, no contract change): a managed sandbox still
// sends `sandboxBackend`/`variableSetId`; a connected machine still sends the
// top-level `targetSandboxId` (+ Stage A's `workingDir`). Only the form shape and
// the gating change.
import { CAPABILITY_DESCRIPTORS, type CapabilityDescriptor, type MachineView } from "@opengeni/contracts";

import { sessionMcpPermissionGroups } from "@/lib/permissions";
import type { GoalSpec, SandboxBackend, TurnSubmission } from "@/types";

// ── Compute target — the promoted top-level "Where should this run?" choice ──

/** A platform-owned ephemeral sandbox. `backend === ""` is the deployment
 *  default; a specific managed backend is an Advanced override. */
export type ManagedSandboxTarget = {
  kind: "sandbox";
  backend: SandboxBackend | "";
};

/** The working folder on a connected machine. PR-1 ships `root` (the agent's
 *  launch dir → no `workingDir` sent) and `path` (a free-form host path → sent as
 *  Stage A's `workingDir`). A named Project (D4) is a future third variant. */
export type MachineFolder =
  | { kind: "root" }
  | { kind: "path"; path: string };

/** A user-owned enrolled machine the platform attaches to (no clone, no teardown,
 *  the machine's own env & git auth). `sandboxId` is `null` until one is picked. */
export type ConnectedMachineTarget = {
  kind: "machine";
  sandboxId: string | null;
  folder: MachineFolder;
};

export type ComputeTarget = ManagedSandboxTarget | ConnectedMachineTarget;

export type SessionDraft = {
  // PROMOTED — the parent that gates the compute-dependent band.
  compute: ComputeTarget;
  // Injected at start on a managed sandbox; ignored when compute.kind==="machine"
  // (a connected machine uses its own variable set & git credentials — D2).
  variableSetId: string;
  goalText: string;
  goalSuccessCriteria: string;
  goalMaxAutoContinuations: string;
  customMcpPermissions: boolean;
  mcpPermissions: Set<string>;
};

export function emptySessionDraft(): SessionDraft {
  return {
    compute: { kind: "sandbox", backend: "" },
    variableSetId: "",
    goalText: "",
    goalSuccessCriteria: "",
    goalMaxAutoContinuations: "",
    customMcpPermissions: false,
    mcpPermissions: new Set(sessionMcpPermissionGroups.flatMap((group) => group.permissions)),
  };
}

/** True once the draft can be submitted: a connected machine needs a picked
 *  machine; a managed sandbox is always ready. */
export function isSessionDraftComputeReady(draft: SessionDraft): boolean {
  return draft.compute.kind !== "machine" || draft.compute.sandboxId !== null;
}

export type SessionDraftSubmission = {
  /** TurnSubmission extras merged into the create payload. */
  extras: Omit<TurnSubmission, "text">;
  /** Top-level create fields threaded into `startSession` separately. */
  options: { targetSandboxId: string | null; workingDir: string | null };
  /** When true (a connected machine) the workspace's selected repos must NOT be
   *  cloned: the machine uses its own checkout & git auth (D3). This is the UI
   *  half of the clone-gating footgun fix — the selection is retained in context
   *  (lossless toggle-back) but excluded from the create's `resources[]`. */
  omitWorkspaceResources: boolean;
};

/** The single submit mapper: turns a `SessionDraft` into the create payload,
 *  branching on the compute kind (the one discriminant). */
export function submissionFromSessionDraft(draft: SessionDraft): SessionDraftSubmission {
  const goal = goalFromDraft(draft);
  const mcp = draft.customMcpPermissions ? { firstPartyMcpPermissions: [...draft.mcpPermissions] } : {};

  if (draft.compute.kind === "machine") {
    return {
      // No sandboxBackend (forced `selfhosted` server-side) and no variable set
      // injection — the machine's own env & git auth apply (D2).
      extras: {
        ...(goal ? { goal } : {}),
        ...mcp,
      },
      options: {
        targetSandboxId: draft.compute.sandboxId,
        workingDir: workingDirFromFolder(draft.compute.folder),
      },
      omitWorkspaceResources: true,
    };
  }

  return {
    extras: {
      ...(draft.compute.backend ? { sandboxBackend: draft.compute.backend } : {}),
      ...(draft.variableSetId ? { variableSetId: draft.variableSetId } : {}),
      ...(goal ? { goal } : {}),
      ...mcp,
    },
    options: { targetSandboxId: null, workingDir: null },
    omitWorkspaceResources: false,
  };
}

/** The machine's per-session working directory, or `null` for its default
 *  workspace_root (the agent's launch dir). A blank custom path normalizes to
 *  `null` (omitted ⇒ byte-identical to today). */
function workingDirFromFolder(folder: MachineFolder): string | null {
  return folder.kind === "path" ? folder.path.trim() || null : null;
}

function goalFromDraft(draft: SessionDraft): GoalSpec | null {
  if (!draft.goalText.trim()) {
    return null;
  }
  const maxAutoContinuations = nonNegativeInteger(draft.goalMaxAutoContinuations);
  return {
    text: draft.goalText.trim(),
    ...(draft.goalSuccessCriteria.trim() ? { successCriteria: draft.goalSuccessCriteria.trim() } : {}),
    ...(maxAutoContinuations !== null ? { maxAutoContinuations } : {}),
  };
}

function nonNegativeInteger(value: string): number | null {
  const parsed = Number(value);
  return value.trim() && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

// ── Managed sandbox backend options (descriptor-driven) ──────────────────────
//
// Replaces the hand-maintained literal: every managed backend is sourced from
// `CAPABILITY_DESCRIPTORS` (the `selfhosted` row is the Connected Machine kind, so
// it is excluded), and each option surfaces the capability metadata the table
// already carries (Desktop/Recording/lifetime).

export type ManagedBackendOption = {
  value: SandboxBackend | "";
  label: string;
  /** Capability summary chips, e.g. ["Desktop", "Recording", "24h"]. */
  chips: string[];
};

const MANAGED_BACKEND_LABELS: Partial<Record<SandboxBackend, string>> = {
  docker: "Docker",
  modal: "Modal",
  local: "Local",
  none: "None (no sandbox)",
  daytona: "Daytona",
  runloop: "Runloop",
  e2b: "E2B",
  blaxel: "Blaxel",
  cloudflare: "Cloudflare",
  vercel: "Vercel",
};

function backendLabel(backend: SandboxBackend): string {
  return MANAGED_BACKEND_LABELS[backend] ?? backend.slice(0, 1).toUpperCase() + backend.slice(1);
}

function descriptorChips(descriptor: CapabilityDescriptor): string[] {
  const chips: string[] = [];
  if (descriptor.capabilities.DesktopStream.available) {
    chips.push("Desktop");
  }
  if (descriptor.capabilities.Recording.available) {
    chips.push("Recording");
  }
  const hardLifetimeMs = descriptor.lifetime.hardLifetimeMs;
  if (hardLifetimeMs) {
    chips.push(formatLifetime(hardLifetimeMs));
  }
  // Fall back to the tier so a headless/dev/none backend still reads as something.
  if (chips.length === 0 && descriptor.tier !== "none") {
    chips.push(descriptor.tier.slice(0, 1).toUpperCase() + descriptor.tier.slice(1));
  }
  return chips;
}

function formatLifetime(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  return Number.isInteger(hours) ? `${hours}h` : `${Math.round(hours)}h`;
}

/** The managed backend options for the Advanced override, descriptor-driven and
 *  led by the deployment default. Excludes `selfhosted` (the Connected Machine
 *  kind). */
export function managedBackendOptions(): ManagedBackendOption[] {
  const managed = (Object.entries(CAPABILITY_DESCRIPTORS) as Array<[SandboxBackend, CapabilityDescriptor]>)
    .filter(([backend]) => backend !== "selfhosted")
    .map(([backend, descriptor]) => ({
      value: backend,
      label: backendLabel(backend),
      chips: descriptorChips(descriptor),
    }));
  return [{ value: "", label: "Deployment default", chips: [] }, ...managed];
}

/** The capability chips for a connected (selfhosted) machine, reflecting the
 *  SELECTED machine's real capabilities — not the static descriptor.
 *  FileSystem/Terminal/Git are always available, so they show even before a
 *  machine is picked. The static descriptor *proclaims* DesktopStream, but that
 *  is consent-gated at enrollment and absent on a headless machine — so the
 *  "Desktop" chip is shown only when the picked machine actually has a display
 *  (`hasDisplay`). A headless machine therefore never shows "Desktop"; the caller
 *  surfaces a distinct "no display" indicator instead. */
export function selfhostedCapabilityChips(machine?: MachineView | null): string[] {
  const descriptor = CAPABILITY_DESCRIPTORS.selfhosted;
  const chips: string[] = [];
  if (descriptor.capabilities.FileSystem.available) {
    chips.push("FileSystem");
  }
  if (descriptor.capabilities.Terminal.available) {
    chips.push("Terminal");
  }
  if (descriptor.capabilities.Git.available) {
    chips.push("Git");
  }
  // Per-machine truth, not the proclaimed static descriptor: only a machine that
  // actually reports a display can offer the desktop stream.
  if (machine?.hasDisplay) {
    chips.push("Desktop");
  }
  return chips;
}
