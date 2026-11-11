import { expect, test } from "bun:test";
import {
  initialWorkspaceMachineCompute,
  workspaceDefaultMachine,
} from "./workspace-default-machine";
const previous = { kind: "machine" as const, sandboxId: "old", folder: { kind: "root" as const } };
const settings = { defaultExecutionTarget: { kind: "machine", targetSandboxId: "current" } };
test("fresh chats prefer the workspace machine over project history", () => {
  expect(
    initialWorkspaceMachineCompute({
      settings,
      options: {},
      fallback: previous,
      backend: "docker",
    }),
  ).toEqual({ kind: "machine", sandboxId: "current", folder: { kind: "root" } });
  expect(
    initialWorkspaceMachineCompute({
      settings: { defaultExecutionTarget: { kind: "managed" } },
      options: {},
      fallback: previous,
      backend: "docker",
    }),
  ).toEqual({ kind: "sandbox", backend: "docker" });
});
test("explicit saved targets stay pinned even when unavailable", () => {
  expect(
    initialWorkspaceMachineCompute({
      settings,
      options: { targetSandboxId: "old" },
      fallback: previous,
      backend: "docker",
    }),
  ).toBe(previous);
  const managed = { kind: "sandbox" as const, backend: "docker" as const };
  expect(
    initialWorkspaceMachineCompute({
      settings,
      options: { sandboxBackend: "docker" },
      fallback: managed,
      backend: "docker",
    }),
  ).toBe(managed);
});
test("legacy and malformed defaults do not invent a target", () => {
  expect(workspaceDefaultMachine({ defaultExecutionTarget: { kind: "machine" } })).toBeNull();
  expect(
    initialWorkspaceMachineCompute({
      settings: {},
      options: {},
      fallback: previous,
      backend: "docker",
    }),
  ).toBe(previous);
});
test("the person's own default comes before the workspace default", () => {
  expect(
    initialWorkspaceMachineCompute({
      settings,
      memberTarget: { kind: "machine", targetSandboxId: "mine" },
      options: {},
      fallback: previous,
      backend: "docker",
    }),
  ).toEqual({ kind: "machine", sandboxId: "mine", folder: { kind: "root" } });
  // It applies without a workspace default too.
  expect(
    initialWorkspaceMachineCompute({
      settings: {},
      memberTarget: { kind: "managed" },
      options: {},
      fallback: previous,
      backend: "docker",
    }),
  ).toEqual({ kind: "sandbox", backend: "docker" });
  // An explicit saved target still wins, and no own default keeps the workspace default.
  expect(
    initialWorkspaceMachineCompute({
      settings,
      memberTarget: { kind: "machine", targetSandboxId: "mine" },
      options: { targetSandboxId: "old" },
      fallback: previous,
      backend: "docker",
    }),
  ).toBe(previous);
  expect(
    initialWorkspaceMachineCompute({
      settings,
      memberTarget: null,
      options: {},
      fallback: previous,
      backend: "docker",
    }),
  ).toEqual({ kind: "machine", sandboxId: "current", folder: { kind: "root" } });
});
