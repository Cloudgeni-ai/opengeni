// "Computer use": whether agents can use the computer the person is on, as one
// on/off switch. The screens show one of four states, and a problem always
// comes with exactly one way to fix it.
import {
  thisComputerNeedsPermissions,
  type ThisComputerErrorCode,
  type ThisComputerStatus,
} from "@opengeni/sdk/this-computer";
import { useCallback, useMemo } from "react";
import type { OpenGeniText } from "../../messages/runtime";
import type { ThisComputerLabels } from "./labels";
import type { UseThisComputerResult } from "./use-this-computer";

/**
 * What is wrong while computer use is on: a permission to allow, a sign-in,
 * a server that can't be reached at all, or anything else (with the
 * server's or agent's own words when there are some).
 */
export type ComputerUseProblem = "permissions" | "signed_out" | "offline" | "error";

export type ComputerUseState =
  /** Outside a desktop app that can host the agent, or not read yet. */
  | { kind: "hidden" }
  /** Never set up, turned off (paused), or removed on the server: all look the same. */
  | { kind: "off" }
  /** Being turned on; `progress` while the agent downloads (0 to 1). */
  | { kind: "turning_on"; progress: number | null }
  | { kind: "on" }
  | {
      kind: "problem";
      problem: ComputerUseProblem;
      code: ThisComputerErrorCode | null;
      /** The host's or server's own message, if there is one. */
      detail: string | null;
    };

/** How a problem is fixed: one action each. */
export type ComputerUseFix = "allow" | "sign_in" | "try_again";

export function computerUseFix(problem: ComputerUseProblem): ComputerUseFix {
  return problem === "permissions" ? "allow" : problem === "signed_out" ? "sign_in" : "try_again";
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
    case "permissions":
      return t("thisComputer.computerUse.permissions");
    case "signed_out":
      return t("thisComputer.computerUse.signedOut", { machineName });
    case "offline":
      return t("thisComputer.computerUse.offline");
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

/** The short form for a sidebar notice. */
export function computerUseNoticeText(
  state: Extract<ComputerUseState, { kind: "problem" | "turning_on" }>,
  t: OpenGeniText,
): string {
  if (state.kind === "turning_on") return t("thisComputer.computerUse.pill.turningOn");
  switch (state.problem) {
    case "permissions":
      return t("thisComputer.computerUse.pill.permissions");
    case "signed_out":
      return t("thisComputer.computerUse.pill.signedOut");
    case "offline":
      return t("thisComputer.computerUse.pill.offline");
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
 * being out of reach is "offline"; a server that answered is never that.
 */
export function computerUseState(
  computer: Pick<UseThisComputerResult, "status" | "actionError"> & {
    pending?: UseThisComputerResult["pending"] | undefined;
  },
): ComputerUseState {
  const status: ThisComputerStatus | null = computer.status;
  if (!status || status.state === "unavailable") return { kind: "hidden" };
  const pending = computer.pending ?? null;
  if (pending === "off") return { kind: "off" };
  // Something else (the menu bar, a link from the browser) may be setting it up.
  const turningOn =
    pending === "on" || (status.busy && status.state !== "connected" && status.state !== "paused");
  if (turningOn) return { kind: "turning_on", progress: status.setupProgress ?? null };
  if (status.error && status.errorCode !== "removed") {
    return failure(status.errorCode ?? null, status.error);
  }
  if (computer.actionError !== null) return failure(null, computer.actionError);
  if (status.state === "connected") {
    if (thisComputerNeedsPermissions(status)) {
      return { kind: "problem", problem: "permissions", code: null, detail: null };
    }
    return status.reconnecting ? { kind: "turning_on", progress: null } : { kind: "on" };
  }
  return { kind: "off" };
}

export interface ComputerUseHandlers {
  /** Shows how to allow the missing permissions, e.g. the setup steps or a permissions page. */
  onAllowPermissions(): void;
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
  /** The one action for a problem; null otherwise. */
  fix: { kind: ComputerUseFix; run(): void } | null;
}

/**
 * The switch for computer use on this computer, from `useThisComputer`.
 * Turning it on asks for permissions only when some are missing.
 */
export function useComputerUse(
  computer: UseThisComputerResult | null,
  handlers: ComputerUseHandlers,
): ComputerUseControl {
  const { onAllowPermissions, onSignIn } = handlers;
  const state: ComputerUseState = computer ? computerUseState(computer) : { kind: "hidden" };
  const turnOn = computer?.turnOn;
  const turnOff = computer?.turnOff;
  const on = useCallback(() => {
    void turnOn?.().then((next) => {
      if (thisComputerNeedsPermissions(next)) onAllowPermissions();
    });
  }, [onAllowPermissions, turnOn]);
  const setChecked = useCallback(
    (next: boolean) => {
      if (next) on();
      else void turnOff?.();
    },
    [on, turnOff],
  );
  const problem = state.kind === "problem" ? state.problem : null;
  const fix = useMemo(() => {
    if (!problem) return null;
    const kind = problem === "signed_out" && !onSignIn ? "try_again" : computerUseFix(problem);
    const run =
      kind === "allow" ? onAllowPermissions : kind === "sign_in" && onSignIn ? onSignIn : on;
    return { kind, run };
  }, [on, onAllowPermissions, onSignIn, problem]);
  return {
    state,
    checked: state.kind !== "off" && state.kind !== "hidden",
    busy: computer?.acting ?? false,
    setChecked,
    fix,
  };
}
