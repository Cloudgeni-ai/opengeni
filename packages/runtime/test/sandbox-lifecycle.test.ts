import { describe, expect, test } from "bun:test";
import {
  resumeExactSandboxSession,
  sandboxProviderContinuityForState,
  SandboxConfigError,
  SandboxExactResumeReplacedError,
  SandboxResumeIdentityUnavailableError,
  terminateManagedSandboxSession,
  terminateUnpublishedSandboxSession,
} from "../src/sandbox";

describe("provider-neutral sandbox teardown lifecycle", () => {
  test("prefers the live SDK session lifecycle so hooks and provider semantics run", async () => {
    const calls: string[] = [];
    const state = { providerState: { sandboxId: "box-1" } };

    await terminateManagedSandboxSession(
      {
        backendId: "test",
        delete: async (received: unknown) => {
          expect(received).toBe(state);
          calls.push("client.delete");
        },
      },
      state,
      {
        delete: async () => calls.push("session.delete"),
        close: async () => calls.push("session.close"),
      },
    );

    expect(calls).toEqual(["session.delete"]);
  });

  test("uses client.delete only when no live session teardown operation exists", async () => {
    const calls: string[] = [];
    const state = { providerState: { sandboxId: "box-1" } };
    await terminateManagedSandboxSession(
      {
        backendId: "state-only",
        delete: async (received: unknown) => {
          expect(received).toBe(state);
          calls.push("client.delete");
        },
      },
      state,
      { preStop: async () => calls.push("preStop") },
    );

    expect(calls).toEqual(["preStop", "client.delete"]);
  });

  test("never calls client.delete without the exact persisted state", async () => {
    const calls: string[] = [];
    await terminateManagedSandboxSession(
      {
        backendId: "test",
        delete: async () => calls.push("client.delete"),
      },
      undefined,
      { delete: async () => calls.push("session.delete") },
    );

    expect(calls).toEqual(["session.delete"]);
  });

  test("delegates fallback ordering and error preservation to the SDK lifecycle", async () => {
    const calls: string[] = [];
    const firstFailure = new Error("stop failed");

    await expect(
      terminateManagedSandboxSession(
        { backendId: "test" },
        {},
        {
          runPreStopHooks: async () => calls.push("hooks"),
          preStop: async (options: { reason?: string }) => calls.push(`preStop:${options.reason}`),
          stop: async (options: { reason?: string }) => {
            calls.push(`stop:${options.reason}`);
            throw firstFailure;
          },
          shutdown: async (options: { reason?: string }) =>
            calls.push(`shutdown:${options.reason}`),
          delete: async (options: { reason?: string }) => calls.push(`delete:${options.reason}`),
          close: async () => calls.push("close"),
        },
      ),
    ).rejects.toBe(firstFailure);

    expect(calls).toEqual([
      "hooks",
      "preStop:cleanup",
      "stop:cleanup",
      "shutdown:cleanup",
      "delete:cleanup",
    ]);
  });

  test("uses close only as the SDK fallback and rejects an undeclared teardown surface", async () => {
    const calls: string[] = [];
    await terminateManagedSandboxSession(
      { backendId: "close-only" },
      {},
      { close: async () => calls.push("close") },
    );
    expect(calls).toEqual(["close"]);

    await expect(terminateManagedSandboxSession({ backendId: "invalid" }, {}, {})).rejects.toThrow(
      "Sandbox backend invalid exposes no teardown lifecycle operation",
    );
  });

  test("exact Vercel resume strips replacement freshness state without mutating the archive envelope", async () => {
    const state = {
      sandboxId: "box-exact",
      snapshotSandboxId: "fresh-snapshot",
      workspaceArchive: "preserved",
    };
    let received: unknown;
    const resumed = await resumeExactSandboxSession(
      {
        backendId: "vercel",
        resume: async (value: unknown) => {
          received = value;
          return { state: { ...(value as object), sandboxId: "box-exact" } };
        },
        resumeExact: async (value: unknown) => {
          received = value;
          return { state: { ...(value as object), sandboxId: "box-exact" } };
        },
      },
      "vercel",
      state,
      "box-exact",
    );

    expect(received).toEqual({ sandboxId: "box-exact", workspaceArchive: "preserved" });
    expect(state.snapshotSandboxId).toBe("fresh-snapshot");
    expect(resumed.instanceId).toBe("box-exact");
  });

  test("exact resume deletes an SDK-created replacement before reporting the original missing", async () => {
    const calls: string[] = [];
    await expect(
      resumeExactSandboxSession(
        {
          backendId: "vercel",
          resume: async () => ({
            state: { sandboxId: "replacement" },
            delete: async () => calls.push("replacement.delete"),
          }),
          resumeExact: async () => ({
            state: { sandboxId: "replacement" },
            delete: async () => calls.push("replacement.delete"),
          }),
        },
        "vercel",
        { sandboxId: "expected", snapshotSandboxId: "snapshot" },
        "expected",
      ),
    ).rejects.toBeInstanceOf(SandboxExactResumeReplacedError);
    expect(calls).toEqual(["replacement.delete"]);
  });

  test("exact resume fails closed when the live handle exposes no stable provider identity", async () => {
    await expect(
      resumeExactSandboxSession(
        {
          backendId: "vercel",
          resume: async () => ({ state: {} }),
          resumeExact: async () => ({ state: {} }),
        },
        "vercel",
        { sandboxId: "expected" },
        "expected",
      ),
    ).rejects.toBeInstanceOf(SandboxResumeIdentityUnavailableError);
  });

  test("exact resume never falls back to ordinary resume", async () => {
    const calls: string[] = [];
    await expect(
      resumeExactSandboxSession(
        {
          backendId: "modal",
          resume: async () => {
            calls.push("ordinary-resume");
            return { state: { sandboxId: "box" } };
          },
        },
        "modal",
        { sandboxId: "box" },
        "box",
      ),
    ).rejects.toBeInstanceOf(SandboxConfigError);
    expect(calls).toEqual([]);
  });

  test("Docker attached exact resume never invokes the SDK replacement path", async () => {
    const calls: string[] = [];
    const state = {
      containerId: "old-container",
      workspaceRootPath: "/tmp/opengeni-workspace",
      workspaceRootOwned: true,
      snapshot: null,
    };
    const resumed = await resumeExactSandboxSession(
      {
        backendId: "docker",
        resume: async () => {
          calls.push("ordinary-resume");
          return { state: { ...state, containerId: "replacement" } };
        },
        resumeExact: async () => {
          calls.push("exact-resume");
          return { state };
        },
      },
      "docker",
      state,
      "old-container",
    );

    expect(resumed.instanceId).toBe("old-container");
    expect(calls).toEqual(["exact-resume"]);
  });

  test("a durable Docker continuity receipt adopts only a same-workspace replacement", async () => {
    const requestedState = {
      containerId: "old-container",
      workspaceRootPath: "/tmp/opengeni-workspace",
      workspaceRootOwned: true,
      snapshot: null,
    };
    const continuity = sandboxProviderContinuityForState("docker", requestedState, "old-container");
    expect(continuity).not.toBeNull();
    const replacementState = { ...requestedState, containerId: "new-container" };
    const resumed = await resumeExactSandboxSession(
      {
        backendId: "docker",
        resume: async () => ({ state: replacementState }),
        resumeExact: async () => {
          throw new Error("must not use exact resume for an authorized continuation");
        },
      },
      "docker",
      requestedState,
      "old-container",
      { continuity: continuity! },
    );

    expect(resumed.instanceId).toBe("new-container");
    expect(resumed.providerContinuity).toEqual(continuity);
  });

  test("a raced same-workspace Docker replacement is discarded without deleting its workspace", async () => {
    const calls: string[] = [];
    const requestedState = {
      containerId: "old-container",
      workspaceRootPath: "/tmp/opengeni-workspace",
      workspaceRootOwned: true,
      snapshot: null,
    };
    const replacementState = { ...requestedState, containerId: "raced-container" };
    await expect(
      resumeExactSandboxSession(
        {
          backendId: "docker",
          resume: async () => ({ state: replacementState }),
          resumeExact: async () => ({
            state: replacementState,
            delete: async () => {
              expect(replacementState.workspaceRootOwned).toBe(false);
              calls.push("delete-wrapper");
            },
          }),
        },
        "docker",
        requestedState,
        "old-container",
      ),
    ).rejects.toBeInstanceOf(SandboxExactResumeReplacedError);
    expect(calls).toEqual(["delete-wrapper"]);
  });

  test("unpublished continuity cleanup removes the wrapper but preserves the durable workspace", async () => {
    const state = {
      containerId: "new-container",
      workspaceRootPath: "/tmp/opengeni-workspace",
      workspaceRootOwned: true,
      snapshot: null,
    };
    const continuity = sandboxProviderContinuityForState(
      "docker",
      { ...state, containerId: "old-container" },
      "old-container",
    );
    const calls: string[] = [];
    await terminateUnpublishedSandboxSession({
      client: { backendId: "docker" },
      session: {
        state,
        delete: async () => {
          expect(state.workspaceRootOwned).toBe(false);
          calls.push("delete-wrapper");
        },
      },
      sessionState: state,
      instanceId: "new-container",
      backendId: "docker",
      providerContinuity: continuity!,
    });
    expect(calls).toEqual(["delete-wrapper"]);
  });
});
