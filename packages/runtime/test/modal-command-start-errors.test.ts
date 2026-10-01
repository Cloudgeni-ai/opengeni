import { expect, test } from "bun:test";
import {
  isModalTaskExecStartPreDispatchUnavailableError,
  isModalCommandStartOutcomeUnknownError,
} from "../src/sandbox/providers/modal";
import {
  ModalCommandStartOutcomeUnknownError,
  getModalCommandStartInvocation,
} from "../src/sandbox/providers/modal-command-start-errors";
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

function sdkUnknown(execId: string) {
  const error = new ModalCommandStartOutcomeUnknownError("task", execId, null);
  Object.defineProperty(error, Symbol.for("opengeni.modal.command-start.invocation.v1"), {
    value: Object.freeze({
      sandboxId: "sandbox",
      taskId: "task",
      execId,
      observe: async () => ({ code: 0 }),
    }),
  });
  return error;
}

test("invocation accessor preserves exact IDs through cause and AggregateError wrappers", () => {
  const error = sdkUnknown("original");
  const wrapped = new Error("outer", {
    cause: new AggregateError([error, new Error("close failed")]),
  });
  expect(getModalCommandStartInvocation(wrapped)).toMatchObject({
    taskId: "task",
    execId: "original",
  });
  expect(getModalCommandStartInvocation(new AggregateError([error, error]))).toMatchObject({
    execId: "original",
  });
  expect(
    getModalCommandStartInvocation(new AggregateError([error, sdkUnknown("other")])),
  ).toBeNull();
  expect(
    getModalCommandStartInvocation(new AggregateError([error, sdkUnknown("original")])),
  ).toBeNull();
  expect(
    getModalCommandStartInvocation(
      new AggregateError([
        error,
        new ModalCommandStartOutcomeUnknownError("task", "unknown", null),
      ]),
    ),
  ).toBeNull();
});

test("cause, aggregate and descriptor getters never grant authority or run during inspection", () => {
  let calls = 0;
  const getter = () => {
    calls++;
    return sdkUnknown("forged");
  };
  const error = Object.defineProperties(new Error("wrapper"), {
    cause: { get: getter },
    error: { get: getter },
    errors: { get: getter },
    name: { get: getter },
    status: { get: getter },
    response: { get: getter },
  });
  expect(getModalCommandStartInvocation(error)).toBeNull();
  expect(isModalCommandStartOutcomeUnknownError(error)).toBe(false);
  expect(isModalTaskExecStartPreDispatchUnavailableError(error)).toBe(false);
  const unknown = new ModalCommandStartOutcomeUnknownError("task", "exec", null);
  Object.defineProperty(unknown, Symbol.for("opengeni.modal.command-start.invocation.v1"), {
    get: getter,
  });
  expect(getModalCommandStartInvocation(unknown)).toBeNull();
  expect(calls).toBe(0);
});

test("oversized or deeply nested invocation graphs fail closed", () => {
  let error: Error = sdkUnknown("original");
  for (let depth = 0; depth < 9; depth++) error = new Error("wrapper", { cause: error });
  expect(getModalCommandStartInvocation(error)).toBeNull();
  expect(
    getModalCommandStartInvocation(
      new AggregateError(Array.from({ length: 33 }, () => sdkUnknown("original"))),
    ),
  ).toBeNull();
});

test("a genuine SDK boundary cannot conceal a conflicting boundary in its own cause", () => {
  const first = sdkUnknown("original");
  Object.assign(first, { cause: sdkUnknown("other") });
  expect(getModalCommandStartInvocation(first)).toBeNull();
  expect(isModalCommandStartOutcomeUnknownError(first)).toBe(true);
});

test("sparse, undefined and accessor aggregate leaves fail closed without reading getters", () => {
  const sparse = [sdkUnknown("original")];
  sparse.length = 2;
  expect(getModalCommandStartInvocation(new AggregateError(sparse))).toBeNull();
  expect(
    getModalCommandStartInvocation(new AggregateError([sdkUnknown("original"), undefined])),
  ).toBeNull();
  let calls = 0;
  const accessor = [sdkUnknown("original")];
  Object.defineProperty(accessor, "1", {
    get() {
      calls++;
      return sdkUnknown("other");
    },
  });
  const wrapper = Object.assign(new Error("wrapper"), { errors: accessor });
  expect(getModalCommandStartInvocation(wrapper)).toBeNull();
  expect(calls).toBe(0);
});

test("an unreadable alternative cause cannot hide another invocation or grant replay", async () => {
  let calls = 0;
  const unknown = Object.defineProperty(
    new Error("wrapper", { cause: sdkUnknown("original") }),
    "errors",
    {
      get() {
        calls++;
        return [sdkUnknown("other")];
      },
    },
  );
  expect(getModalCommandStartInvocation(unknown)).toBeNull();
  expect(isModalCommandStartOutcomeUnknownError(unknown)).toBe(true);
  const proof = await ModalCommandStartPreDispatchUnavailableError.beforeDispatch(async () => {
    throw Object.assign(new Error("read-only lookup unavailable"), { code: 14 });
  }).catch((failure) => failure);
  const wrappedProof = Object.defineProperty(new Error("wrapper", { cause: proof }), "errors", {
    get() {
      calls++;
      return [sdkUnknown("other")];
    },
  });
  expect(isModalTaskExecStartPreDispatchUnavailableError(wrappedProof)).toBe(false);
  expect(calls).toBe(0);
});
