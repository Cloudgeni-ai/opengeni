import { expect, test } from "bun:test";
import { getComposerSendBlocker } from "./composer-send-blocking";

test("each synchronous composer blocker identifies its recovery reason", () => {
  const ready = {
    uploadPending: false,
    repositoryError: null,
    policyValid: true,
    variableSetBlocked: false,
    personalDecision: false,
    personalLoading: false,
  };
  expect(getComposerSendBlocker(ready)).toBeNull();
  for (const [change, expected] of [
    [{ uploadPending: true }, "upload"],
    [{ repositoryError: "Repository access expired" }, "repository"],
    [{ repositoryError: "" }, "repository"],
    [{ policyValid: false }, "policy"],
    [{ variableSetBlocked: true }, "variable_sets"],
    [{ personalDecision: true }, "personal_decision"],
    [{ personalLoading: true }, "personal_loading"],
  ] as const) {
    expect(getComposerSendBlocker({ ...ready, ...change })).toBe(expected);
  }
});
