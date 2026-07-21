import {
  authorizeTranscriptionAdapter,
  createTranscriptionSessionRequest,
  type TranscriptionAdapter,
  type TranscriptionErrorCode,
  type TranscriptionEvent,
  type TranscriptionLifecycleStatus,
  type TranscriptionPolicyBlockReason,
  type TranscriptionSession,
  type TranscriptionTargetSelection,
  type WorkspaceTranscriptionPolicy,
} from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type TranscriptionControlState = {
  status: TranscriptionLifecycleStatus;
  generation: number;
  localSessionId: string | null;
  providerSessionId: string | null;
  lastSequence: number;
  partial: string;
  error: { code: TranscriptionErrorCode; message: string; recoverable: boolean } | null;
  acceptedFinalIds: string[];
  audioMilliseconds: number;
  costUsd: number | null;
};

export const INITIAL_TRANSCRIPTION_CONTROL_STATE: TranscriptionControlState = {
  status: "idle",
  generation: 0,
  localSessionId: null,
  providerSessionId: null,
  lastSequence: 0,
  partial: "",
  error: null,
  acceptedFinalIds: [],
  audioMilliseconds: 0,
  costUsd: null,
};

export type TranscriptionControlAction =
  | { type: "start"; generation: number; localSessionId: string }
  | { type: "event"; generation: number; event: TranscriptionEvent }
  | {
      type: "start.failed";
      generation: number;
      code: TranscriptionErrorCode;
      message: string;
    }
  | { type: "cancel"; generation: number }
  | { type: "cancel.settled"; generation: number }
  | { type: "reset" };

export type TranscriptionControlTransition = {
  state: TranscriptionControlState;
  /** A newly accepted final to append to the current editable draft once. */
  commit: string | null;
};

export function transitionTranscriptionControl(
  state: TranscriptionControlState,
  action: TranscriptionControlAction,
): TranscriptionControlTransition {
  if (action.type === "reset") {
    return {
      state: { ...INITIAL_TRANSCRIPTION_CONTROL_STATE, generation: state.generation },
      commit: null,
    };
  }
  if (action.type === "start") {
    if (action.generation <= state.generation) return { state, commit: null };
    return {
      state: {
        ...INITIAL_TRANSCRIPTION_CONTROL_STATE,
        status: "requesting-permission",
        generation: action.generation,
        localSessionId: action.localSessionId,
      },
      commit: null,
    };
  }
  if (action.generation !== state.generation) return { state, commit: null };
  if (action.type === "start.failed") {
    if (state.status === "closed" || state.status === "error") return { state, commit: null };
    return {
      state: {
        ...state,
        status: "error",
        partial: "",
        error: { code: action.code, message: action.message, recoverable: false },
      },
      commit: null,
    };
  }
  if (action.type === "cancel") {
    if (!isActiveTranscriptionStatus(state.status)) return { state, commit: null };
    return {
      state: { ...state, status: "cancelling", partial: "", error: null },
      commit: null,
    };
  }
  if (action.type === "cancel.settled") {
    if (state.status !== "cancelling") return { state, commit: null };
    return { state: { ...state, status: "closed", partial: "" }, commit: null };
  }

  const event = action.event;
  if (event.localSessionId !== state.localSessionId) return { state, commit: null };
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= state.lastSequence) {
    return { state, commit: null };
  }
  // Closed and failed generations are terminal local privacy fences. Adapters
  // may still deliver callbacks while remote cleanup settles; none can revive
  // the session or mutate the draft.
  if (state.status === "closed" || state.status === "error") return { state, commit: null };
  // Once cancellation begins, late partial/final/usage callbacks are fenced.
  if (state.status === "cancelling" && event.type !== "session.closed") {
    return { state: { ...state, lastSequence: event.sequence }, commit: null };
  }

  const sequenced = { ...state, lastSequence: event.sequence };
  switch (event.type) {
    case "permission.requested":
      return {
        state: { ...sequenced, status: "requesting-permission", partial: "", error: null },
        commit: null,
      };
    case "session.opened":
      return {
        state: {
          ...sequenced,
          status: "listening",
          providerSessionId: event.providerSessionId,
          error: null,
        },
        commit: null,
      };
    case "transcript.partial":
      return {
        state: { ...sequenced, status: "listening", partial: event.text, error: null },
        commit: null,
      };
    case "transcript.final": {
      const text = event.text.trim();
      const duplicate = state.acceptedFinalIds.includes(event.providerAcceptanceId);
      return {
        state: {
          ...sequenced,
          status: "listening",
          partial: "",
          error: null,
          acceptedFinalIds: duplicate
            ? state.acceptedFinalIds
            : [...state.acceptedFinalIds, event.providerAcceptanceId],
        },
        commit: duplicate || text.length === 0 ? null : text,
      };
    }
    case "usage":
      return {
        state: {
          ...sequenced,
          audioMilliseconds: Math.max(state.audioMilliseconds, event.audioMilliseconds),
          costUsd: event.costUsd,
        },
        commit: null,
      };
    case "session.reconnecting":
      return {
        state: { ...sequenced, status: "reconnecting", partial: "", error: null },
        commit: null,
      };
    case "session.error":
      return {
        state: {
          ...sequenced,
          status: event.recoverable ? "reconnecting" : "error",
          partial: "",
          error: {
            code: event.code,
            message: event.message,
            recoverable: event.recoverable,
          },
        },
        commit: null,
      };
    case "session.closed":
      return {
        state: {
          ...sequenced,
          status: event.reason === "error" ? "error" : "closed",
          partial: "",
        },
        commit: null,
      };
  }
}

export function appendFinalTranscript(draft: string, transcript: string): string {
  const final = transcript.trim();
  if (!final) return draft;
  if (!draft) return final;
  return /\s$/u.test(draft) ? `${draft}${final}` : `${draft} ${final}`;
}

export type UseTranscriptionOptions = {
  adapter: TranscriptionAdapter | null;
  policy: WorkspaceTranscriptionPolicy;
  selection?: TranscriptionTargetSelection | undefined;
  value: string;
  setValue: (value: string) => void;
  focusInput: () => void;
  disabled?: boolean | undefined;
  createLocalSessionId?: (() => string) | undefined;
};

export type UseTranscriptionResult = {
  state: TranscriptionControlState;
  available: boolean;
  unavailableReason:
    | TranscriptionPolicyBlockReason
    | "adapter_missing"
    | "composer_disabled"
    | null;
  start: () => Promise<boolean>;
  cancel: () => Promise<boolean>;
  reset: () => void;
};

export function useTranscription({
  adapter,
  policy,
  selection = { kind: "primary" },
  value,
  setValue,
  focusInput,
  disabled = false,
  createLocalSessionId = defaultLocalSessionId,
}: UseTranscriptionOptions): UseTranscriptionResult {
  const [state, setState] = useState(INITIAL_TRANSCRIPTION_CONTROL_STATE);
  const stateRef = useRef(state);
  const valueRef = useRef(value);
  const sessionRef = useRef<{ generation: number; session: TranscriptionSession } | null>(null);
  const activePolicyRef = useRef<{ generation: number; revision: string } | null>(null);
  valueRef.current = value;

  const policyRevision = useMemo(
    () => transcriptionPolicyRevision(policy, selection),
    [policy, selection],
  );
  const authorization = useMemo(
    () => (adapter ? authorizeTranscriptionAdapter(policy, adapter.descriptor, selection) : null),
    [adapter, policy, selection],
  );
  const unavailableReason = disabled
    ? ("composer_disabled" as const)
    : !policy.enabled
      ? ("disabled" as const)
      : !policy.acceptanceId
        ? ("unaccepted" as const)
        : !policy.primary
          ? ("target_missing" as const)
          : !adapter
            ? ("adapter_missing" as const)
            : authorization?.authorized
              ? null
              : (authorization?.reason ?? "unaccepted");

  const apply = useCallback(
    (action: TranscriptionControlAction) => {
      const transition = transitionTranscriptionControl(stateRef.current, action);
      if (transition.state !== stateRef.current) {
        stateRef.current = transition.state;
        setState(transition.state);
      }
      if (transition.commit !== null) {
        const next = appendFinalTranscript(valueRef.current, transition.commit);
        valueRef.current = next;
        setValue(next);
        focusInput();
      }
      return transition.state;
    },
    [focusInput, setValue],
  );

  const releaseTerminalSession = useCallback((generation: number) => {
    const active = sessionRef.current;
    if (!active || active.generation !== generation) return;
    sessionRef.current = null;
    if (activePolicyRef.current?.generation === generation) activePolicyRef.current = null;
    void active.session.close().catch(() => undefined);
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (
      !adapter ||
      unavailableReason !== null ||
      isActiveTranscriptionStatus(stateRef.current.status)
    ) {
      return false;
    }
    const generation = stateRef.current.generation + 1;
    const localSessionId = createLocalSessionId();
    apply({ type: "start", generation, localSessionId });
    const request = createTranscriptionSessionRequest({
      policy,
      adapter,
      localSessionId,
      selection,
      sequenceFloor: 0,
    });
    if (!request) {
      apply({
        type: "start.failed",
        generation,
        code: "policy_blocked",
        message: "Transcription is not authorized by the accepted workspace policy.",
      });
      return false;
    }
    activePolicyRef.current = { generation, revision: policyRevision };
    try {
      const session = await adapter.start(request, (event) => {
        apply({ type: "event", generation, event });
        if (event.type === "session.error" && !event.recoverable) {
          releaseTerminalSession(generation);
        } else if (event.type === "session.closed") {
          releaseTerminalSession(generation);
        }
      });
      const current = stateRef.current;
      if (
        current.generation !== generation ||
        current.localSessionId !== localSessionId ||
        current.status === "cancelling" ||
        !isActiveTranscriptionStatus(current.status)
      ) {
        const locallyRevoked = activePolicyRef.current?.generation !== generation;
        if (activePolicyRef.current?.generation === generation) activePolicyRef.current = null;
        if (locallyRevoked || (current.status !== "error" && current.status !== "closed")) {
          await session.cancel("stale-generation").catch(() => undefined);
        }
        await session.close().catch(() => undefined);
        return false;
      }
      sessionRef.current = { generation, session };
      return true;
    } catch (error) {
      if (activePolicyRef.current?.generation === generation) activePolicyRef.current = null;
      apply({
        type: "start.failed",
        generation,
        code: classifyStartError(error),
        message: error instanceof Error ? error.message : "Unable to start voice input.",
      });
      return false;
    }
  }, [
    adapter,
    apply,
    createLocalSessionId,
    policy,
    policyRevision,
    releaseTerminalSession,
    selection,
    unavailableReason,
  ]);

  const cancel = useCallback(async (): Promise<boolean> => {
    const current = stateRef.current;
    if (!isActiveTranscriptionStatus(current.status)) return false;
    const generation = current.generation;
    apply({ type: "cancel", generation });
    const active = sessionRef.current;
    sessionRef.current = null;
    if (activePolicyRef.current?.generation === generation) activePolicyRef.current = null;
    try {
      if (active?.generation === generation) {
        await active.session.cancel("user-cancelled");
        await active.session.close();
      }
    } catch {
      // Cancellation is a local privacy fence even when provider cleanup fails.
    } finally {
      apply({ type: "cancel.settled", generation });
      focusInput();
    }
    return true;
  }, [apply, focusInput]);

  const reset = useCallback(() => apply({ type: "reset" }), [apply]);

  useEffect(() => {
    if (!isActiveTranscriptionStatus(state.status)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void cancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [cancel, state.status]);

  useEffect(() => {
    if (!isActiveTranscriptionStatus(state.status)) return;
    const activePolicy = activePolicyRef.current;
    if (
      unavailableReason === null &&
      activePolicy?.generation === state.generation &&
      activePolicy.revision === policyRevision
    ) {
      return;
    }
    void cancel();
  }, [cancel, policyRevision, state.generation, state.status, unavailableReason]);

  useEffect(
    () => () => {
      const active = sessionRef.current;
      sessionRef.current = null;
      activePolicyRef.current = null;
      stateRef.current = {
        ...stateRef.current,
        generation: stateRef.current.generation + 1,
        status: "closed",
        partial: "",
      };
      if (active) {
        void active.session.cancel("component-unmounted").catch(() => undefined);
        void active.session.close().catch(() => undefined);
      }
    },
    [],
  );

  return {
    state,
    available: unavailableReason === null,
    unavailableReason,
    start,
    cancel,
    reset,
  };
}

function isActiveTranscriptionStatus(status: TranscriptionLifecycleStatus): boolean {
  return (
    status === "requesting-permission" ||
    status === "listening" ||
    status === "reconnecting" ||
    status === "cancelling"
  );
}

function defaultLocalSessionId(): string {
  return globalThis.crypto.randomUUID();
}

function classifyStartError(error: unknown): TranscriptionErrorCode {
  if (error instanceof DOMException && error.name === "NotAllowedError") return "permission_denied";
  if (error instanceof DOMException && error.name === "NotSupportedError") return "not_supported";
  return "unknown";
}

function transcriptionPolicyRevision(
  policy: WorkspaceTranscriptionPolicy,
  selection: TranscriptionTargetSelection,
): string {
  const targetKey = (target: WorkspaceTranscriptionPolicy["primary"]): string =>
    target
      ? [
          target.provider,
          target.model ?? "",
          target.credentialMode,
          target.credentialConnectionId ?? "",
          target.region ?? "",
        ].join("\u0000")
      : "";
  return [
    policy.enabled ? "1" : "0",
    policy.acceptanceId ?? "",
    targetKey(policy.primary),
    policy.language ?? "",
    policy.retention.mode,
    policy.retention.maxDays?.toString() ?? "",
    policy.privacy.allowProviderLogging ? "1" : "0",
    policy.privacy.allowProviderTraining ? "1" : "0",
    policy.fallback.mode,
    policy.fallback.targets.map(targetKey).join("\u0001"),
    policy.cost.currency,
    policy.cost.maxPerHour?.toString() ?? "",
    policy.cost.maxPerMonth?.toString() ?? "",
    selection.kind,
    selection.kind === "fallback" ? selection.index.toString() : "",
  ].join("\u0002");
}
