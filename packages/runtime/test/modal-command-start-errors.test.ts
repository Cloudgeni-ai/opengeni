import { expect, test } from "bun:test";
import {
  isModalTaskExecStartPreDispatchUnavailableError,
  isModalCommandStartOutcomeUnknownError,
} from "../src/sandbox/providers/modal";
import { ModalCommandStartOutcomeUnknownError } from "../src/sandbox/providers/modal-command-start-errors";
import { ModalCommandStartPreDispatchUnavailableError } from "../src/sandbox/providers/modal-command-router-wire";

const brand = Symbol.for("opengeni.modal.command-start.boundary.v1");

test("runtime-owned ambiguous Start error is recognized without SDK export coupling", () => {
  const cause = Object.assign(new Error("lost acknowledgement"), { code: 14 });
  const error = new ModalCommandStartOutcomeUnknownError("task", "exec", cause);
  expect(error.cause).toBe(cause);
  expect(isModalCommandStartOutcomeUnknownError(new Error("wrapper", { cause: error }))).toBe(true);
  expect(isModalTaskExecStartPreDispatchUnavailableError(error)).toBe(false);
  expect(Object.getOwnPropertyDescriptor(error, brand)).toMatchObject({
    value: "outcome-unknown",
    enumerable: false,
    writable: false,
  });
});

test("patch-only error names, codes and string brands never grant recovery or no-replay classification", () => {
  for (const name of [
    "CommandStartPreDispatchUnavailableError",
    "CommandStartOutcomeUnknownError",
  ]) {
    const error = Object.assign(new Error("Name resolution failed for target dns:spoof.invalid"), {
      name,
      code: 14,
      "opengeni.modal.command-start.boundary.v1": "pre-dispatch-unavailable",
    });
    expect(isModalTaskExecStartPreDispatchUnavailableError(error)).toBe(false);
    expect(isModalCommandStartOutcomeUnknownError(error)).toBe(false);
  }
});

test("inherited markers and marker getters are not local boundary proof", () => {
  const inherited = Object.create(new ModalCommandStartOutcomeUnknownError("task", "exec", null));
  expect(isModalCommandStartOutcomeUnknownError(inherited)).toBe(false);
  let getterCalls = 0;
  const error = new Error("untrusted wrapper");
  Object.defineProperty(error, brand, {
    get() {
      getterCalls++;
      return "pre-dispatch-unavailable";
    },
  });
  expect(isModalTaskExecStartPreDispatchUnavailableError(error)).toBe(false);
  expect(isModalCommandStartOutcomeUnknownError(error)).toBe(false);
  expect(getterCalls).toBe(0);
});

test("a genuine ambiguous boundary still vetoes pre-dispatch proof in a wrapper graph", async () => {
  const proof = await ModalCommandStartPreDispatchUnavailableError.beforeDispatch(async () => {
    throw Object.assign(new Error("read-only lookup unavailable"), { code: 14 });
  }).catch((error) => error);
  expect(isModalTaskExecStartPreDispatchUnavailableError(proof)).toBe(true);
  const mixed = new AggregateError([
    proof,
    new ModalCommandStartOutcomeUnknownError("task", "exec", new Error("lost response")),
  ]);
  expect(isModalTaskExecStartPreDispatchUnavailableError(mixed)).toBe(false);
  expect(isModalCommandStartOutcomeUnknownError(mixed)).toBe(true);
});
