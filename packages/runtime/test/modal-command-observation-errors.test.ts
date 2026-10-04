import { expect, test } from "bun:test";
import { isModalCommandObservationTransportError } from "../src/sandbox/providers/modal-command-observation-errors";
import {
  classifyProviderSandboxFailure,
  isProviderSandboxGoneDuringRoutedOperation,
} from "../src/sandbox/provider-errors";
import { isModalTaskExecStartPreDispatchUnavailableError } from "../src/sandbox/providers/modal";
import {
  ProviderCommandObservationUnavailableError,
  isProviderCommandObservationUnavailableError,
} from "../src/sandbox/provider-command-session";

const command = {
  kind: "modal-router-v1" as const,
  sandboxId: "sb-test",
  taskId: "task-test",
  execId: "792e06b2-03c7-40f0-baa7-a51cf4bddaf8",
  streams: {
    stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
  },
};

test.each([14, "14", "UNAVAILABLE", "ENOTFOUND"])(
  "read transport %s never grants Start replay or sandbox loss",
  (code) => {
    const error = Object.assign(new Error("Modal sandbox sb-test is no longer running."), { code });
    expect(isModalCommandObservationTransportError(error)).toBe(true);
    expect(classifyProviderSandboxFailure("modal", error).kind).toBe("transient_transport");
    expect(isModalTaskExecStartPreDispatchUnavailableError(error)).toBe(false);
    expect(
      isProviderSandboxGoneDuringRoutedOperation("modal", {
        code: "SANDBOX_NOT_FOUND",
        cause: error,
      }),
    ).toBe(false);
  },
);

test("bounded cause/Aggregate transport dominates sandbox-loss prose but mixed reads do not retry", () => {
  const transport = new Error("wrapper", {
    cause: new AggregateError([{ code: "14" }, { code: 14 }]),
  });
  expect(isModalCommandObservationTransportError(transport)).toBe(true);
  const shared = Object.assign(new Error("DNS unavailable"), { code: 14 });
  expect(isModalCommandObservationTransportError(new AggregateError([shared, shared]))).toBe(true);
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  expect(isModalCommandObservationTransportError(cycle)).toBe(false);
  const mixed = new AggregateError(
    [{ code: "14" }, { code: 404 }],
    "Modal sandbox sb-test is no longer running.",
  );
  expect(isModalCommandObservationTransportError(mixed)).toBe(false);
  expect(classifyProviderSandboxFailure("modal", mixed).kind).toBe("transient_transport");
  expect(
    isProviderSandboxGoneDuringRoutedOperation("modal", {
      code: "SANDBOX_NOT_FOUND",
      cause: transport,
    }),
  ).toBe(false);
});

test("malformed, oversized and unreadable graphs do not retire a routed lease", () => {
  for (const errors of [[], "not-an-array", Array(17).fill({ code: 14 }), [undefined]]) {
    const error = { code: "SANDBOX_NOT_FOUND", errors };
    expect(isProviderSandboxGoneDuringRoutedOperation("modal", error)).toBe(false);
    expect(classifyProviderSandboxFailure("modal", error).kind).toBe("other");
  }
  let calls = 0;
  const error = Object.defineProperty({ code: "SANDBOX_NOT_FOUND" }, "cause", {
    get() {
      calls++;
      return { code: 14 };
    },
  });
  expect(isProviderSandboxGoneDuringRoutedOperation("modal", error)).toBe(false);
  expect(calls).toBe(0);
});

test.each([
  { code: 5 },
  { code: 7 },
  { code: 16 },
  { code: "PERMISSION_DENIED" },
  new Error("DNS not found"),
  { name: "ProviderCommandObservationUnavailableError" },
])("nontransport %j is not read retry or unknown authority", (error) => {
  expect(isModalCommandObservationTransportError(error)).toBe(false);
  expect(isProviderCommandObservationUnavailableError(error)).toBe(false);
});

test("genuine read uncertainty preserves its exact locator through wrappers without executing getters", () => {
  const unknown = new ProviderCommandObservationUnavailableError(command, { code: 14 });
  expect(unknown.command).toBe(command);
  expect(
    isProviderCommandObservationUnavailableError(
      new Error("outer", { cause: new AggregateError([unknown]) }),
    ),
  ).toBe(true);
  expect(isModalTaskExecStartPreDispatchUnavailableError(unknown)).toBe(false);
  let calls = 0;
  const hostile = Object.defineProperties(new Error("DNS"), {
    code: {
      get() {
        calls++;
        return "14";
      },
    },
    cause: {
      get() {
        calls++;
        return unknown;
      },
    },
    errors: {
      get() {
        calls++;
        return [unknown];
      },
    },
  });
  expect(isModalCommandObservationTransportError(hostile)).toBe(false);
  expect(isProviderCommandObservationUnavailableError(hostile)).toBe(false);
  expect(classifyProviderSandboxFailure("modal", hostile).kind).toBe("other");
  expect(calls).toBe(0);
});
