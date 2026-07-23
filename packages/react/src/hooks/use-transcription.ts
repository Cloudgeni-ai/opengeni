import {
  authorizeTranscriptionAdapter,
  createTranscriptionSessionRequest,
  type TranscriptionAdapter,
  type TranscriptionDiagnostic,
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
  error: { code: TranscriptionErrorCode; recoverable: boolean } | null;
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
        error: { code: normalizeTranscriptionErrorCode(action.code), recoverable: false },
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
      const acceptedFinalIds =
        duplicate || text.length === 0
          ? state.acceptedFinalIds
          : [...state.acceptedFinalIds, event.providerAcceptanceId];
      return {
        state: {
          ...sequenced,
          status: "listening",
          partial: "",
          error: null,
          acceptedFinalIds,
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
            code: normalizeTranscriptionErrorCode(event.code),
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
  lifecycleTimeouts?: Partial<TranscriptionLifecycleTimeouts> | undefined;
  /** Receives bounded, redacted diagnostics; this detail is never rendered by the hook. */
  onDiagnostic?: ((diagnostic: TranscriptionDiagnostic) => void) | undefined;
};

export type TranscriptionLifecycleTimeouts = {
  startMs: number;
  cleanupMs: number;
};

const DEFAULT_TRANSCRIPTION_LIFECYCLE_TIMEOUTS: TranscriptionLifecycleTimeouts = {
  startMs: 15_000,
  cleanupMs: 2_000,
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
  lifecycleTimeouts,
  onDiagnostic,
}: UseTranscriptionOptions): UseTranscriptionResult {
  const [state, setState] = useState(INITIAL_TRANSCRIPTION_CONTROL_STATE);
  const stateRef = useRef(state);
  const valueRef = useRef(value);
  const sessionRef = useRef<{ generation: number; session: TranscriptionSession } | null>(null);
  const pendingStartRef = useRef<{
    generation: number;
    controller: AbortController;
  } | null>(null);
  const activePolicyRef = useRef<{ generation: number; revision: string } | null>(null);
  valueRef.current = value;

  const startTimeoutMs = normalizeTimeout(
    lifecycleTimeouts?.startMs,
    DEFAULT_TRANSCRIPTION_LIFECYCLE_TIMEOUTS.startMs,
  );
  const cleanupTimeoutMs = normalizeTimeout(
    lifecycleTimeouts?.cleanupMs,
    DEFAULT_TRANSCRIPTION_LIFECYCLE_TIMEOUTS.cleanupMs,
  );

  const reportDiagnostic = useCallback(
    (diagnostic: unknown) => {
      if (!onDiagnostic) return;
      try {
        onDiagnostic(sanitizeTranscriptionDiagnostic(diagnostic));
      } catch {
        // Observability must never break the local privacy or UI lifecycle.
      }
    },
    [onDiagnostic],
  );
  const cleanupRuntimeRef = useRef({ cleanupTimeoutMs, reportDiagnostic });

  useEffect(() => {
    cleanupRuntimeRef.current = { cleanupTimeoutMs, reportDiagnostic };
  }, [cleanupTimeoutMs, reportDiagnostic]);

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

  const releaseTerminalSession = useCallback(
    (generation: number) => {
      const active = sessionRef.current;
      if (!active || active.generation !== generation) return;
      sessionRef.current = null;
      if (activePolicyRef.current?.generation === generation) activePolicyRef.current = null;
      detachSessionCleanup(active.session, {
        cleanupTimeoutMs,
        reportDiagnostic,
      });
    },
    [cleanupTimeoutMs, reportDiagnostic],
  );

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
      });
      return false;
    }
    activePolicyRef.current = { generation, revision: policyRevision };
    const controller = new AbortController();
    pendingStartRef.current = { generation, controller };
    let boundarySettled = false;
    let accepted = false;
    const observedStart = Promise.resolve()
      .then(() =>
        adapter.start(
          request,
          (event) => {
            apply({ type: "event", generation, event });
            if (event.type === "session.error" && !event.recoverable) {
              releaseTerminalSession(generation);
            } else if (event.type === "session.closed") {
              releaseTerminalSession(generation);
            }
          },
          {
            signal: controller.signal,
            reportDiagnostic,
          },
        ),
      )
      .then(
        (session) => {
          if (boundarySettled && !accepted) {
            detachSessionCleanup(session, {
              cancelReason: "stale-generation",
              cleanupTimeoutMs,
              reportDiagnostic,
            });
          }
          return { kind: "session" as const, session };
        },
        (error: unknown) => {
          if (boundarySettled) {
            reportDiagnostic({
              operation: "start",
              code: classifyStartError(error),
              detail: diagnosticDetail(error),
            });
          }
          return { kind: "error" as const, error };
        },
      );

    let abortListener: (() => void) | null = null;
    const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
      if (controller.signal.aborted) {
        resolve({ kind: "aborted" });
        return;
      }
      abortListener = () => resolve({ kind: "aborted" });
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutId = setTimeout(() => resolve({ kind: "timeout" }), startTimeoutMs);
    });
    const outcome = await Promise.race([observedStart, aborted, timedOut]);
    boundarySettled = true;
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
    if (pendingStartRef.current?.generation === generation) pendingStartRef.current = null;

    if (outcome.kind === "aborted") return false;

    if (outcome.kind === "timeout") {
      controller.abort("transcription-start-timeout");
      if (activePolicyRef.current?.generation === generation) activePolicyRef.current = null;
      reportDiagnostic({
        operation: "start",
        code: "timeout",
        detail: `Transcription adapter start exceeded ${startTimeoutMs}ms.`,
      });
      apply({ type: "start.failed", generation, code: "timeout" });
      return false;
    }

    if (outcome.kind === "error") {
      if (activePolicyRef.current?.generation === generation) activePolicyRef.current = null;
      const code = classifyStartError(outcome.error);
      reportDiagnostic({
        operation: "start",
        code,
        detail: diagnosticDetail(outcome.error),
      });
      if (!controller.signal.aborted) {
        apply({ type: "start.failed", generation, code });
      }
      return false;
    }

    const current = stateRef.current;
    if (
      current.generation !== generation ||
      current.localSessionId !== localSessionId ||
      current.status === "cancelling" ||
      !isActiveTranscriptionStatus(current.status)
    ) {
      if (activePolicyRef.current?.generation === generation) activePolicyRef.current = null;
      detachSessionCleanup(outcome.session, {
        ...(current.status === "error" ? {} : { cancelReason: "stale-generation" }),
        cleanupTimeoutMs,
        reportDiagnostic,
      });
      return false;
    }
    accepted = true;
    sessionRef.current = { generation, session: outcome.session };
    return true;
  }, [
    adapter,
    apply,
    createLocalSessionId,
    cleanupTimeoutMs,
    policy,
    policyRevision,
    releaseTerminalSession,
    reportDiagnostic,
    selection,
    startTimeoutMs,
    unavailableReason,
  ]);

  const cancel = useCallback(async (): Promise<boolean> => {
    const current = stateRef.current;
    if (!isActiveTranscriptionStatus(current.status)) return false;
    const generation = current.generation;
    apply({ type: "cancel", generation });
    const pending = pendingStartRef.current;
    if (pending?.generation === generation) {
      pendingStartRef.current = null;
      pending.controller.abort("transcription-locally-cancelled");
    }
    const active = sessionRef.current;
    sessionRef.current = null;
    if (activePolicyRef.current?.generation === generation) activePolicyRef.current = null;
    apply({ type: "cancel.settled", generation });
    focusInput();
    if (active?.generation === generation) {
      detachSessionCleanup(active.session, {
        cancelReason: "user-cancelled",
        cleanupTimeoutMs,
        reportDiagnostic,
      });
    }
    return true;
  }, [apply, cleanupTimeoutMs, focusInput, reportDiagnostic]);

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
      const pending = pendingStartRef.current;
      pendingStartRef.current = null;
      pending?.controller.abort("transcription-component-unmounted");
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
        const runtime = cleanupRuntimeRef.current;
        detachSessionCleanup(active.session, {
          cancelReason: "component-unmounted",
          cleanupTimeoutMs: runtime.cleanupTimeoutMs,
          reportDiagnostic: runtime.reportDiagnostic,
        });
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
  if (isRecord(error)) {
    const normalized = normalizeTranscriptionErrorCode(error.code);
    if (normalized !== "unknown") return normalized;
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "permission_denied";
    if (error.name === "NotSupportedError") return "not_supported";
    if (error.name === "TimeoutError") return "timeout";
    if (error.name === "AbortError") return "cancelled";
  }
  return "unknown";
}

export function normalizeTranscriptionErrorCode(code: unknown): TranscriptionErrorCode {
  switch (code) {
    case "permission_denied":
    case "not_supported":
    case "network":
    case "provider":
    case "policy_blocked":
    case "timeout":
    case "cancelled":
    case "unknown":
      return code;
    default:
      return "unknown";
  }
}

export function sanitizeTranscriptionDiagnostic(diagnostic: unknown): TranscriptionDiagnostic {
  const source = isRecord(diagnostic) ? diagnostic : {};
  const operation =
    source.operation === "start" ||
    source.operation === "session" ||
    source.operation === "cancel" ||
    source.operation === "close"
      ? source.operation
      : "session";
  const rawDetail = typeof source.detail === "string" ? source.detail : "No diagnostic detail.";
  const detail = rawDetail
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/gu, "[REDACTED]")
    .replace(
      /\b(api[-_ ]?key|authorization|access[-_ ]?token|refresh[-_ ]?token|token|secret)\b\s*[:=]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    )
    .trim()
    .slice(0, 512);
  return {
    operation,
    code: normalizeTranscriptionErrorCode(source.code),
    detail: detail || "No diagnostic detail.",
  };
}

function detachSessionCleanup(
  session: TranscriptionSession,
  options: {
    cancelReason?: string | undefined;
    cleanupTimeoutMs: number;
    reportDiagnostic: (diagnostic: unknown) => void;
  },
): void {
  if (options.cancelReason) {
    void runBoundedCleanup(
      "cancel",
      () => session.cancel(options.cancelReason),
      options.cleanupTimeoutMs,
      options.reportDiagnostic,
    );
  }
  void runBoundedCleanup(
    "close",
    () => session.close(),
    options.cleanupTimeoutMs,
    options.reportDiagnostic,
  );
}

async function runBoundedCleanup(
  operation: "cancel" | "close",
  invoke: () => Promise<void>,
  timeoutMs: number,
  reportDiagnostic: (diagnostic: unknown) => void,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const result = Promise.resolve()
    .then(invoke)
    .then(
      () => ({ kind: "settled" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const outcome = await Promise.race([result, timeout]);
  if (timeoutId !== null) clearTimeout(timeoutId);
  if (outcome.kind === "settled") return;
  reportDiagnostic({
    operation,
    code: outcome.kind === "timeout" ? "timeout" : "provider",
    detail:
      outcome.kind === "timeout"
        ? `Transcription ${operation} exceeded ${timeoutMs}ms.`
        : diagnosticDetail(outcome.error),
  });
}

function diagnosticDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown transcription adapter failure.";
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.min(Math.floor(value), 60_000)
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    policy.autoDetectLanguage ? "1" : "0",
    policy.diarization.enabled ? "1" : "0",
    policy.diarization.maxSpeakers?.toString() ?? "",
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
