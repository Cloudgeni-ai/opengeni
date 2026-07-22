import type {
  TranscriptionCommit,
  TranscriptionEvent,
  TranscriptionReducerAction,
  TranscriptionState,
} from "./types";

export const initialTranscriptionState: TranscriptionState = {
  phase: "idle",
  activeSessionId: null,
  partial: null,
  highestSequenceBySegment: {},
  acceptedFinalByLogicalSegment: {},
  acceptedCommits: [],
  latestCommit: null,
  acceptedUsage: [],
  acceptedUsageEventIds: {},
  reconnectAttempt: 0,
  retryInMs: null,
  error: null,
  closedReason: null,
};

function segmentSequenceKey(
  event: Extract<TranscriptionEvent, { type: "transcript.partial" | "transcript.final" }>,
): string {
  return `${event.providerId}:${event.attempt}:${event.segmentId}`;
}

function commitFrom(
  event: Extract<TranscriptionEvent, { type: "transcript.final" }>,
): TranscriptionCommit {
  return {
    id: `${event.sessionId}:${event.logicalSegmentId}:${event.providerId}:${event.providerAcceptanceId}`,
    sessionId: event.sessionId,
    providerId: event.providerId,
    providerAcceptanceId: event.providerAcceptanceId,
    ...(event.providerEventId ? { providerEventId: event.providerEventId } : {}),
    segmentId: event.segmentId,
    logicalSegmentId: event.logicalSegmentId,
    attempt: event.attempt,
    sequence: event.sequence,
    text: event.text,
    ...(event.language ? { language: event.language } : {}),
    ...(event.confidence === undefined ? {} : { confidence: event.confidence }),
    ...(event.speaker ? { speaker: event.speaker } : {}),
    ...(event.startMs === undefined ? {} : { startMs: event.startMs }),
    ...(event.endMs === undefined ? {} : { endMs: event.endMs }),
    ...(event.words ? { words: event.words } : {}),
  };
}

function reduceProviderEvent(
  state: TranscriptionState,
  event: TranscriptionEvent,
): TranscriptionState {
  if (event.sessionId !== state.activeSessionId) {
    return state;
  }

  if (state.phase === "error" || state.phase === "closed") {
    return state;
  }

  if (
    state.phase === "cancelling" &&
    (event.type === "transcript.partial" || event.type === "transcript.final")
  ) {
    return state;
  }

  switch (event.type) {
    case "session.ready":
      return {
        ...state,
        phase: "listening",
        reconnectAttempt: 0,
        retryInMs: null,
        error: null,
        closedReason: null,
      };

    case "transcript.partial": {
      if (state.acceptedFinalByLogicalSegment[event.logicalSegmentId] !== undefined) {
        return state;
      }
      const key = segmentSequenceKey(event);
      if ((state.highestSequenceBySegment[key] ?? -1) >= event.sequence) {
        return state;
      }
      return {
        ...state,
        phase: "listening",
        partial: event,
        highestSequenceBySegment: {
          ...state.highestSequenceBySegment,
          [key]: event.sequence,
        },
      };
    }

    case "transcript.final": {
      const key = segmentSequenceKey(event);
      if ((state.highestSequenceBySegment[key] ?? -1) >= event.sequence) {
        return state;
      }
      const highestSequenceBySegment = {
        ...state.highestSequenceBySegment,
        [key]: event.sequence,
      };
      const partial =
        state.partial?.logicalSegmentId === event.logicalSegmentId ? null : state.partial;
      if (
        state.acceptedFinalByLogicalSegment[event.logicalSegmentId] !== undefined ||
        event.providerAcceptanceId.trim().length === 0 ||
        event.text.trim().length === 0
      ) {
        return { ...state, partial, highestSequenceBySegment };
      }
      const commit = commitFrom(event);
      return {
        ...state,
        phase: "listening",
        partial,
        highestSequenceBySegment,
        acceptedFinalByLogicalSegment: {
          ...state.acceptedFinalByLogicalSegment,
          [event.logicalSegmentId]: event.providerAcceptanceId,
        },
        acceptedCommits: [...state.acceptedCommits, commit],
        latestCommit: commit,
      };
    }

    case "usage": {
      const usageEventId =
        event.providerEventId === undefined
          ? `${event.sessionId}:${event.providerId}:${event.sequence}`
          : `${event.providerId}:${event.providerEventId}`;
      if (state.acceptedUsageEventIds[usageEventId]) {
        return state;
      }
      return {
        ...state,
        acceptedUsage: [...state.acceptedUsage, event.usage],
        acceptedUsageEventIds: {
          ...state.acceptedUsageEventIds,
          [usageEventId]: true,
        },
      };
    }

    case "reconnecting":
      return {
        ...state,
        phase: "reconnecting",
        partial: null,
        reconnectAttempt: event.attempt,
        retryInMs: event.retryInMs ?? null,
        error: null,
      };

    case "error":
      return {
        ...state,
        phase: "error",
        partial: null,
        retryInMs: null,
        error: {
          code: event.code,
          message: event.message,
          retryable: event.retryable,
          permissionDenied: event.permissionDenied ?? false,
        },
      };

    case "closed":
      return {
        ...state,
        phase: "closed",
        partial: null,
        retryInMs: null,
        closedReason: event.reason,
      };
  }
}

export function transcriptionReducer(
  state: TranscriptionState,
  action: TranscriptionReducerAction,
): TranscriptionState {
  switch (action.type) {
    case "start.requested":
      return {
        ...initialTranscriptionState,
        phase: "requesting-permission",
        activeSessionId: action.sessionId,
      };
    case "cancel.requested":
      return state.activeSessionId
        ? {
            ...state,
            phase: "cancelling",
            partial: null,
            retryInMs: null,
            error: null,
          }
        : state;
    case "cancel.completed":
      return state.activeSessionId
        ? {
            ...state,
            phase: "closed",
            partial: null,
            retryInMs: null,
            error: null,
            closedReason: "cancelled",
          }
        : state;
    case "reset":
      return initialTranscriptionState;
    case "provider.event":
      return reduceProviderEvent(state, action.event);
  }
}
