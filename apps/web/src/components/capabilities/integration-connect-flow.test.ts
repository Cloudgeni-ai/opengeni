import { describe, expect, test } from "bun:test";

import {
  initialIntegrationConnectFlow,
  integrationConnectFlowReducer,
  integrationConnectValidationError,
  type IntegrationConnectFlowAction,
  type IntegrationConnectFlowInput,
} from "./integration-connect-flow";

describe("integration connection flow", () => {
  test("validates the account and unavailable ownership before advancing", () => {
    let state = initialIntegrationConnectFlow(input({ accountLabel: "   " }));
    expect(integrationConnectValidationError(state)).toBe("Enter an account label.");
    state = integrationConnectFlowReducer(state, { type: "next" });
    expect(state.step).toBe("account");

    state = integrationConnectFlowReducer(state, {
      type: "account_label_changed",
      value: "Gmail — Finance",
    });
    state = integrationConnectFlowReducer(state, {
      type: "ownership_changed",
      value: "workspace",
    });
    expect(state.ownership).toBe("personal");
    expect(integrationConnectValidationError(state)).toBeNull();

    const unavailable = initialIntegrationConnectFlow(
      input({ availability: { personal: false, workspace: false } }),
    );
    expect(integrationConnectValidationError(unavailable)).toBe(
      "A workspace administrator must connect this account.",
    );
  });

  test("moves deterministically through review and permits only backward step jumps", () => {
    let state = initialIntegrationConnectFlow(input());
    state = reduce(state, [{ type: "next" }, { type: "next" }]);
    expect(state.step).toBe("review");

    state = integrationConnectFlowReducer(state, { type: "go_to", step: "account" });
    expect(state.step).toBe("account");
    state = integrationConnectFlowReducer(state, { type: "go_to", step: "review" });
    expect(state.step).toBe("account");

    state = reduce(state, [{ type: "next" }, { type: "back" }]);
    expect(state.step).toBe("account");
  });

  test("ignores duplicate and stale submission outcomes across reset and retry", () => {
    let state = reduce(initialIntegrationConnectFlow(input()), [
      { type: "next" },
      { type: "next" },
      { type: "submit", submissionId: 1 },
    ]);
    expect(state.status).toBe("submitting");

    const duplicate = integrationConnectFlowReducer(state, {
      type: "submit",
      submissionId: 2,
    });
    expect(duplicate).toBe(state);

    state = integrationConnectFlowReducer(state, {
      type: "reset",
      input: input({ accountLabel: "Gmail — Sales" }),
    });
    expect(state).toMatchObject({
      step: "account",
      accountLabel: "Gmail — Sales",
      status: "idle",
      submissionSequence: 2,
      activeSubmissionId: null,
    });
    const stale = integrationConnectFlowReducer(state, {
      type: "submit_failed",
      submissionId: 1,
      message: "stale provider failure",
    });
    expect(stale).toBe(state);

    state = reduce(state, [
      { type: "next" },
      { type: "next" },
      { type: "submit", submissionId: 3 },
      { type: "submit_failed", submissionId: 3, message: "Try safely again" },
    ]);
    expect(state).toMatchObject({ status: "error", error: "Try safely again" });

    state = integrationConnectFlowReducer(state, { type: "submit", submissionId: 4 });
    state = integrationConnectFlowReducer(state, {
      type: "redirecting",
      submissionId: 4,
    });
    expect(state.status).toBe("redirecting");
    expect(
      integrationConnectFlowReducer(state, {
        type: "submit_failed",
        submissionId: 3,
        message: "late failure",
      }),
    ).toBe(state);
  });
});

function input(overrides: Partial<IntegrationConnectFlowInput> = {}): IntegrationConnectFlowInput {
  return {
    accountLabel: "Gmail — Account 2",
    availability: { personal: true, workspace: false },
    ...overrides,
  };
}

function reduce(
  initial: ReturnType<typeof initialIntegrationConnectFlow>,
  actions: IntegrationConnectFlowAction[],
) {
  return actions.reduce(integrationConnectFlowReducer, initial);
}
