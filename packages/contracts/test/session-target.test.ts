import { expect, test } from "bun:test";
import {
  nextSessionTargetContext,
  sessionTargetContext,
  SESSION_TARGET_CONTEXT_KEY,
} from "../src/session-target";

test("target select, reload, exact replay and clear preserve versioned context", () => {
  const empty = sessionTargetContext({});
  const request = {
    sessionId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    expectedVersion: 0,
  };
  const selected = nextSessionTargetContext(empty, request);
  expect(
    sessionTargetContext(JSON.parse(JSON.stringify({ [SESSION_TARGET_CONTEXT_KEY]: selected }))),
  ).toEqual(selected);
  expect(nextSessionTargetContext(selected, request)).toBe(selected);
  const cleared = nextSessionTargetContext(selected, {
    sessionId: null,
    operationId: crypto.randomUUID(),
    expectedVersion: 1,
  });
  expect(cleared.sessionId).toBeNull();
  expect(() => nextSessionTargetContext(cleared, request)).toThrow("changed");
  expect(() => nextSessionTargetContext(selected, { ...request, sessionId: null })).toThrow(
    "different input",
  );
});

test("malformed stored target and invalid selection fail closed", () => {
  expect(() =>
    sessionTargetContext({ [SESSION_TARGET_CONTEXT_KEY]: { sessionId: "bad" } }),
  ).toThrow();
  expect(() =>
    nextSessionTargetContext(sessionTargetContext({}), {
      sessionId: "bad",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
    }),
  ).toThrow();
});
