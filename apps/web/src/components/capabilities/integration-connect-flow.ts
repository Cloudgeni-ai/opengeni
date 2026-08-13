import type { ConnectionOwnership } from "@/types";

export const INTEGRATION_ACCOUNT_LABEL_MAX_LENGTH = 200;

export type IntegrationConnectStep = "account" | "access" | "review";
export type IntegrationConnectStatus = "idle" | "submitting" | "redirecting" | "error";

export type IntegrationConnectAvailability = Record<ConnectionOwnership, boolean>;

export type IntegrationConnectFlowInput = {
  accountLabel: string;
  preferredOwnership?: ConnectionOwnership;
  availability: IntegrationConnectAvailability;
};

export type IntegrationConnectFlowState = {
  step: IntegrationConnectStep;
  accountLabel: string;
  ownership: ConnectionOwnership;
  availability: IntegrationConnectAvailability;
  status: IntegrationConnectStatus;
  error: string | null;
  submissionSequence: number;
  activeSubmissionId: number | null;
};

export type IntegrationConnectFlowAction =
  | { type: "reset"; input: IntegrationConnectFlowInput }
  | { type: "account_label_changed"; value: string }
  | { type: "ownership_changed"; value: ConnectionOwnership }
  | { type: "next" }
  | { type: "back" }
  | { type: "go_to"; step: IntegrationConnectStep }
  | { type: "submit"; submissionId: number }
  | { type: "redirecting"; submissionId: number }
  | { type: "submit_failed"; submissionId: number; message: string };

const STEP_ORDER: readonly IntegrationConnectStep[] = ["account", "access", "review"];

export function initialIntegrationConnectFlow(
  input: IntegrationConnectFlowInput,
): IntegrationConnectFlowState {
  return initialState(input, 0);
}

export function integrationConnectFlowReducer(
  state: IntegrationConnectFlowState,
  action: IntegrationConnectFlowAction,
): IntegrationConnectFlowState {
  if (action.type === "reset") {
    // Advance the sequence so an async failure from the prior open cannot
    // overwrite a freshly reset journey, even when the old request settles late.
    return initialState(action.input, state.submissionSequence + 1);
  }

  const busy = state.status === "submitting" || state.status === "redirecting";
  if (busy && action.type !== "redirecting" && action.type !== "submit_failed") return state;

  switch (action.type) {
    case "account_label_changed":
      return { ...state, accountLabel: action.value, status: "idle", error: null };
    case "ownership_changed":
      if (!state.availability[action.value]) return state;
      return { ...state, ownership: action.value, status: "idle", error: null };
    case "next": {
      if (integrationConnectValidationError(state)) return state;
      const index = STEP_ORDER.indexOf(state.step);
      const next = STEP_ORDER[index + 1];
      return next ? { ...state, step: next, status: "idle", error: null } : state;
    }
    case "back": {
      const index = STEP_ORDER.indexOf(state.step);
      const previous = STEP_ORDER[index - 1];
      return previous ? { ...state, step: previous, status: "idle", error: null } : state;
    }
    case "go_to": {
      const currentIndex = STEP_ORDER.indexOf(state.step);
      const targetIndex = STEP_ORDER.indexOf(action.step);
      if (targetIndex < 0 || targetIndex >= currentIndex) return state;
      return { ...state, step: action.step, status: "idle", error: null };
    }
    case "submit":
      if (
        state.step !== "review" ||
        integrationConnectValidationError(state) ||
        action.submissionId <= state.submissionSequence
      ) {
        return state;
      }
      return {
        ...state,
        status: "submitting",
        error: null,
        submissionSequence: action.submissionId,
        activeSubmissionId: action.submissionId,
      };
    case "redirecting":
      if (state.activeSubmissionId !== action.submissionId || state.status !== "submitting") {
        return state;
      }
      return { ...state, status: "redirecting" };
    case "submit_failed":
      if (state.activeSubmissionId !== action.submissionId) return state;
      return {
        ...state,
        status: "error",
        error: action.message,
        activeSubmissionId: null,
      };
  }
}

export function integrationConnectValidationError(
  state: Pick<IntegrationConnectFlowState, "accountLabel" | "ownership" | "availability">,
): string | null {
  const label = state.accountLabel.trim();
  if (!label) return "Enter an account label.";
  if (label.length > INTEGRATION_ACCOUNT_LABEL_MAX_LENGTH) {
    return `Keep the account label to ${INTEGRATION_ACCOUNT_LABEL_MAX_LENGTH} characters or fewer.`;
  }
  if (!state.availability[state.ownership]) {
    return "A workspace administrator must connect this account.";
  }
  return null;
}

export function integrationConnectStepNumber(step: IntegrationConnectStep): number {
  return STEP_ORDER.indexOf(step) + 1;
}

function initialState(
  input: IntegrationConnectFlowInput,
  submissionSequence: number,
): IntegrationConnectFlowState {
  const preferred = input.preferredOwnership ?? "personal";
  const ownership = input.availability[preferred]
    ? preferred
    : input.availability.personal
      ? "personal"
      : input.availability.workspace
        ? "workspace"
        : preferred;
  return {
    step: "account",
    accountLabel: input.accountLabel,
    ownership,
    availability: { ...input.availability },
    status: "idle",
    error: null,
    submissionSequence,
    activeSubmissionId: null,
  };
}
