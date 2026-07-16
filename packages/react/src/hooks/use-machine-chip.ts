import { useMemo } from "react";
import type { MachineState } from "@opengeni/sdk";
import type { SessionCapabilitiesState } from "./use-session-capabilities";

/** The one truthful machine indicator (dossier §3 #10). Honest staleness beats
 *  fake liveness: a cold/asleep box reads "offline — as of <time>", never "live". */
export type MachineChipState = "live" | "waking" | "offline";

export type MachineChip = {
  state: MachineChipState;
  /** A ready-to-render label ("Live" / "Waking…" / "Offline — as of 3m ago"). */
  label: string;
  /** The capture time backing an offline/stale label (ISO), or null. M4 may
   *  reformat this; `label` already embeds a relative form. */
  asOf: string | null;
};

export type DeriveMachineChipInput = {
  /** `capabilities.liveness` — "warm" | "draining" | "cold" (or null pre-negotiation). */
  liveness?: string | null | undefined;
  /** `useSessionCapabilities().state` — drives the "waking" (negotiating) read. */
  capabilitiesState?: SessionCapabilitiesState | null | undefined;
  /** The ACTIVE machine's connection state (from `useMachines`), when known. A
   *  self-hosted machine that is `offline` cannot be remotely woken. */
  activeMachineState?: MachineState | null | undefined;
  /** Whether the active sandbox is a user-owned self-hosted machine (no remote wake). */
  activeIsSelfhosted?: boolean | undefined;
  /** An interaction (wake-on-edit, terminal focus) is actively warming the box. */
  wantsWarm?: boolean | undefined;
  /** The latest capture's `capturedAt` (ISO) — the "as of <time>" backing. */
  capturedAt?: string | null | undefined;
  /** Injectable clock for deterministic relative labels (defaults to Date.now). */
  now?: number | undefined;
};

/** Compact relative-time for the "as of" label. Pure, no Intl dependency. */
export function formatAsOf(capturedAt: string, now: number): string {
  const then = Date.parse(capturedAt);
  if (Number.isNaN(then)) return "recently";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Derive the machine-state chip from the live capability/liveness surface, the
 * active machine's connection state, and the latest capture time. PURE (M4 renders
 * it; the whole point is a deterministic, testable projection).
 *
 * Precedence:
 *   1. warm/draining lease → **live** (a warm box always wins).
 *   2. actively warming (negotiating, wake-on-edit, or a reconnecting/enrolling
 *      machine) → **waking**.
 *   3. everything else (a cold/asleep box, a self-hosted machine that's offline,
 *      an error) → **offline**, labelled "as of <capture time>".
 */
export function deriveMachineChip(input: DeriveMachineChipInput): MachineChip {
  const now = input.now ?? Date.now();
  const asOf = input.capturedAt ?? null;
  const offlineLabel = asOf ? `Offline — as of ${formatAsOf(asOf, now)}` : "Offline";

  // 1. A warm (or draining) lease is live regardless of anything else.
  if (input.liveness === "warm" || input.liveness === "draining") {
    return { state: "live", label: "Live", asOf: null };
  }

  // A self-hosted machine that reports offline cannot be woken remotely — honest
  // "offline", never "waking" (dossier §3 #5 / #10).
  const selfhostedOffline =
    input.activeIsSelfhosted === true && input.activeMachineState === "offline";

  // 2. Actively coming up: negotiation in flight, an edit/terminal is warming, or
  //    the active machine is (re)connecting. Never when self-hosted is hard-offline.
  const machineWarming =
    input.activeMachineState === "reconnecting" || input.activeMachineState === "enrolling";
  if (
    !selfhostedOffline &&
    (input.capabilitiesState === "negotiating" || input.wantsWarm === true || machineWarming)
  ) {
    return { state: "waking", label: "Waking…", asOf };
  }

  // 3. Cold / asleep / offline / error → honest stale label.
  return { state: "offline", label: offlineLabel, asOf };
}

export type UseMachineChipOptions = DeriveMachineChipInput;

/**
 * Thin memoized wrapper over `deriveMachineChip` for the dock header (M4). The
 * dock already runs `useSessionCapabilities` + `useMachines` + `useWorkspace
 * capture`; it feeds their `liveness` / `state` / active-machine state /
 * `capturedAt` here. Pass a periodically-updated `now` if you want the relative
 * "as of" label to tick.
 */
export function useMachineChip(input: UseMachineChipOptions): MachineChip {
  const {
    liveness,
    capabilitiesState,
    activeMachineState,
    activeIsSelfhosted,
    wantsWarm,
    capturedAt,
    now,
  } = input;
  return useMemo(
    () =>
      deriveMachineChip({
        liveness,
        capabilitiesState,
        activeMachineState,
        activeIsSelfhosted,
        wantsWarm,
        capturedAt,
        now,
      }),
    // Depend on the primitive fields (not the object identity) so a caller passing
    // a fresh object each render doesn't recompute needlessly.
    [
      liveness,
      capabilitiesState,
      activeMachineState,
      activeIsSelfhosted,
      wantsWarm,
      capturedAt,
      now,
    ],
  );
}
