// "Computer use": whether agents can use the computer the person is on, as one
// on/off switch. The screens show one state at a time; a missing permission or
// a problem always comes with exactly one way to fix it.
import {
  thisComputerNeedsPermissions,
  type ThisComputerErrorCode,
  type ThisComputerPermissionId,
  type ThisComputerStatus,
  type ThisComputerWaitingOn,
} from "@opengeni/sdk/this-computer";
import { useCallback, useMemo } from "react";
import type { OpenGeniText } from "../../messages/runtime";
import type { ThisComputerLabels } from "./labels";
import type { UseThisComputerResult } from "./use-this-computer";

/**
 * What is wrong while computer use is on: a sign-in, a server that can't be
 * reached at all, turning on that has waited too long (`stalled`, with what it
 * waits for), or anything else (with the server's or agent's own words when
 * there are some). A missing permission is not one of these: see
 * `needs_permission`.
 */
export type ComputerUseProblem = "signed_out" | "offline" | "stalled" | "error";

export type ComputerUseState =
  /** Outside a desktop app that can host the agent, or not read yet. */
  | { kind: "hidden" }
  /** Never set up, turned off (paused), or removed on the server: all look the same. */
  | { kind: "off" }
  /**
   * Being turned on; `progress` while the agent downloads (0 to 1), and
   * `asking` while the system is asked for a permission.
   */
  | {
      kind: "turning_on";
      progress: number | null;
      asking: ThisComputerPermissionId | null;
    }
  | { kind: "on" }
  /**
   * On, but seeing and controlling the screen waits on a system permission
   * the person hasn't given (yet). Files and commands work meanwhile, so it
   * is not an error. `appName` is the app the permission goes to when it
   * isn't the desktop app itself (e.g. "Opengeni Agent").
   */
  | { kind: "needs_permission"; appName: string | null }
  | {
      kind: "problem";
      problem: ComputerUseProblem;
      code: ThisComputerErrorCode | null;
      /** The host's or server's own message, if there is one. */
      detail: string | null;
      /** For `stalled`: what turning on still waits for, when the host says. */
      waitingOn?: ThisComputerWaitingOn | null;
    };

/** How a missing permission or a problem is fixed: one action each. */
export type ComputerUseFix = "open_settings" | "sign_in" | "try_again";

export function computerUseFix(problem: ComputerUseProblem | "permission"): ComputerUseFix {
  return problem === "permission"
    ? "open_settings"
    : problem === "signed_out"
      ? "sign_in"
      : "try_again";
}

/** What a missing permission means, in one calm sentence (it isn't an error). */
export function computerUsePermissionText(appName: string, t: OpenGeniText): string {
  return t("thisComputer.computerUse.permission", { appName });
}

/**
 * The problem in one sentence. The network message is only for a server that
 * couldn't be reached; anything else keeps the server's or agent's own words.
 */
export function computerUseProblemText(
  state: Extract<ComputerUseState, { kind: "problem" }>,
  machineName: string,
  t: OpenGeniText,
  labels: Pick<ThisComputerLabels, "error">,
): string {
  switch (state.problem) {
    case "signed_out":
      return t("thisComputer.computerUse.signedOut", { machineName });
    case "offline":
      return t("thisComputer.computerUse.offline");
    case "stalled":
      return computerUseStalledText(state.waitingOn ?? null, machineName, t);
    default:
      // The server's or agent's own words say most; else what the code means.
      return (
        state.detail ??
        (state.code && state.code !== "unknown"
          ? labels.error(state.code, null)
          : t("thisComputer.computerUse.error"))
      );
  }
}

/** Why turning on has taken too long, in one plain sentence. */
export function computerUseStalledText(
  waitingOn: ThisComputerWaitingOn | null,
  machineName: string,
  t: OpenGeniText,
): string {
  switch (waitingOn) {
    case "sign_in":
      return t("thisComputer.computerUse.stalled.signIn", { machineName });
    case "server":
      return t("thisComputer.computerUse.stalled.server", { machineName });
    case "agent":
      return t("thisComputer.computerUse.stalled.agent");
    case "another_agent":
      return t("thisComputer.computerUse.stalled.anotherAgent");
    case "handover":
      return t("thisComputer.computerUse.stalled.handover");
    default:
      return t("thisComputer.computerUse.stalled", { machineName });
  }
}

/** The short form for a sidebar notice. */
export function computerUseNoticeText(
  state: Extract<ComputerUseState, { kind: "problem" | "turning_on" | "needs_permission" }>,
  t: OpenGeniText,
): string {
  if (state.kind === "turning_on") return t("thisComputer.computerUse.pill.turningOn");
  if (state.kind === "needs_permission") return t("thisComputer.computerUse.pill.permission");
  switch (state.problem) {
    case "signed_out":
      return t("thisComputer.computerUse.pill.signedOut");
    case "offline":
      return t("thisComputer.computerUse.pill.offline");
    case "stalled":
      return t("thisComputer.computerUse.pill.stalled");
    default:
      return t("thisComputer.computerUse.pill.error");
  }
}

function failure(
  code: ThisComputerErrorCode | null,
  detail: string | null,
): Extract<ComputerUseState, { kind: "problem" }> {
  return {
    kind: "problem",
    problem: code === "signed_out" ? "signed_out" : code === "offline" ? "offline" : "error",
    code,
    detail: detail || null,
  };
}

/**
 * The one state to show. Removal on the server shows as off: turning it on
 * registers this computer again. Only a failure the host reports as the server
 * being out of reach is "offline"; a server that answered is never that. A
 * permission being asked for is still turning on; one the person didn't give
 * is `needs_permission`, never a problem. Turning on that has waited too long
 * (`stalled`, see `useThisComputer`) is a problem that says what it waits for.
 */
export function computerUseState(
  computer: Pick<UseThisComputerResult, "status" | "actionError"> & {
    pending?: UseThisComputerResult["pending"] | undefined;
    asking?: UseThisComputerResult["asking"] | undefined;
    stalled?: UseThisComputerResult["stalled"] | undefined;
  },
): ComputerUseState {
  const status: ThisComputerStatus | null = computer.status;
  if (!status || status.state === "unavailable") return { kind: "hidden" };
  const pending = computer.pending ?? null;
  if (pending === "off") return { kind: "off" };
  // Something else (the menu bar, a link from the browser) may be setting it up.
  const turningOn =
    pending === "on" || (status.busy && status.state !== "connected" && status.state !== "paused");
  if (turningOn) {
    return { kind: "turning_on", progress: status.setupProgress ?? null, asking: null };
  }
  if (status.error && status.errorCode !== "removed") {
    return failure(status.errorCode ?? null, status.error);
  }
  if (computer.actionError !== null) return failure(null, computer.actionError);
  if (status.state === "connected") {
    if (thisComputerNeedsPermissions(status)) {
      const asking = computer.asking ?? null;
      return asking !== null
        ? { kind: "turning_on", progress: null, asking }
        : { kind: "needs_permission", appName: status.permissionAppName ?? null };
    }
    if (!status.reconnecting) return { kind: "on" };
    return computer.stalled
      ? {
          kind: "problem",
          problem: "stalled",
          code: null,
          detail: status.waitingDetail || null,
          waitingOn: status.waitingOn ?? null,
        }
      : { kind: "turning_on", progress: null, asking: null };
  }
  return { kind: "off" };
}

export interface ComputerUseHandlers {
  /**
   * "Open System Settings" for a missing permission. By default it asks for
   * the next missing one (its System Settings list, with the app's guide).
   */
  onAllowPermissions?: (() => void) | undefined;
  /** Signs the person in again; without it, a sign-in problem offers Try again. */
  onSignIn?: (() => void) | undefined;
}

export interface ComputerUseControl {
  state: ComputerUseState;
  /** The switch: on in every state but off, so a problem shows what's wrong with it on. */
  checked: boolean;
  /** The switch is saving; it ignores clicks meanwhile. */
  busy: boolean;
  setChecked(on: boolean): void;
  /** The one action for a missing permission or a problem; null otherwise. */
  fix: { kind: ComputerUseFix; run(): void } | null;
}

/**
 * The switch for computer use on this computer, from `useThisComputer`.
 * Turning it on is the whole step: it asks for missing permissions itself.
 */
export function useComputerUse(
  computer: UseThisComputerResult | null,
  handlers: ComputerUseHandlers = {},
): ComputerUseControl {
  const { onAllowPermissions, onSignIn } = handlers;
  const state: ComputerUseState = computer ? computerUseState(computer) : { kind: "hidden" };
  const turnOn = computer?.turnOn;
  const turnOff = computer?.turnOff;
  const allow = onAllowPermissions ?? computer?.allowPermissions;
  const on = useCallback(() => void turnOn?.(), [turnOn]);
  const setChecked = useCallback(
    (next: boolean) => {
      if (next) on();
      else void turnOff?.();
    },
    [on, turnOff],
  );
  const problem =
    state.kind === "problem"
      ? state.problem
      : state.kind === "needs_permission"
        ? "permission"
        : null;
  const fix = useMemo(() => {
    if (!problem) return null;
    const kind = problem === "signed_out" && !onSignIn ? "try_again" : computerUseFix(problem);
    // A click handler: nothing from the click reaches `allow`.
    const run =
      kind === "open_settings" ? () => allow?.() : kind === "sign_in" && onSignIn ? onSignIn : on;
    return { kind, run };
  }, [allow, on, onSignIn, problem]);
  return {
    state,
    checked: state.kind !== "off" && state.kind !== "hidden",
    busy: computer?.acting ?? false,
    setChecked,
    fix,
  };
}
