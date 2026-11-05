import { describe, expect, test } from "bun:test";
import * as runtime from "@opengeni/runtime";
import { buildManifest, buildOpenGeniAgent, runOwnedSandboxSetup } from "@opengeni/runtime";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import {
  createEagerOwnedSandboxSetup,
  runEagerOwnedSandboxSetup,
  type EagerOwnedSandboxSetupDeps,
  type EagerOwnedSandboxSetupOptions,
} from "../src/activities/agent-turn/owned-sandbox-setup";
import { createObservability } from "@opengeni/observability";

function depsFor(sandbox: { leaseEpoch: number; instanceId: string }) {
  const sandboxState = {
    resolvedSandbox: {
      leaseEpoch: sandbox.leaseEpoch,
      established: { instanceId: sandbox.instanceId },
    },
  };
  return {
    deps: { sandboxState } as unknown as EagerOwnedSandboxSetupDeps,
    rebind(next: { leaseEpoch: number; instanceId: string }) {
      sandboxState.resolvedSandbox = {
        leaseEpoch: next.leaseEpoch,
        established: { instanceId: next.instanceId },
      };
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("eager owned sandbox setup", () => {
  test("a prestarted setup runs once, before input preparation finishes, and the first stream joins it", async () => {
    const { deps } = depsFor({ leaseEpoch: 1, instanceId: "box-a" });
    const gate = deferred();
    const calls: EagerOwnedSandboxSetupOptions[] = [];
    const setup = createEagerOwnedSandboxSetup(
      deps,
      { fileDownloadsMaterialized: true },
      async (_deps, options) => {
        calls.push(options);
        await gate.promise;
      },
    );
    // Started immediately, without waiting for the model input.
    expect(calls).toEqual([{ fileDownloadsMaterialized: true }]);
    let joined = false;
    const first = setup.beforeModelStream({ fileDownloadsMaterialized: true }).then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    gate.resolve();
    await first;
    expect(joined).toBe(true);
    expect(calls).toHaveLength(1);
    // Later streams of the attempt (retries, steer resumes) run setup again.
    await setup.beforeModelStream({ fileDownloadsMaterialized: true });
    expect(calls).toHaveLength(2);
    await setup.settled();
  });

  test("an early failure surfaces on the first stream and settles without an unhandled rejection", async () => {
    const { deps } = depsFor({ leaseEpoch: 1, instanceId: "box-a" });
    const failure = new Error("clone failed");
    const setup = createEagerOwnedSandboxSetup(
      deps,
      { fileDownloadsMaterialized: false },
      async () => {
        throw failure;
      },
    );
    await setup.settled();
    await expect(setup.beforeModelStream({ fileDownloadsMaterialized: false })).rejects.toBe(
      failure,
    );
  });

  test("a box rebound while the prestarted setup ran gets its own setup", async () => {
    const { deps, rebind } = depsFor({ leaseEpoch: 1, instanceId: "box-a" });
    const boxes: string[] = [];
    const gate = deferred();
    const setup = createEagerOwnedSandboxSetup(
      deps,
      { fileDownloadsMaterialized: true },
      async (current) => {
        boxes.push(current.sandboxState.resolvedSandbox!.established.instanceId);
        if (boxes.length === 1) await gate.promise;
      },
    );
    rebind({ leaseEpoch: 2, instanceId: "box-b" });
    gate.resolve();
    await setup.beforeModelStream({ fileDownloadsMaterialized: true });
    expect(boxes).toEqual(["box-a", "box-b"]);
  });

  test("without a prestart the first stream runs setup with its prepared input", async () => {
    const { deps } = depsFor({ leaseEpoch: 1, instanceId: "box-a" });
    const calls: EagerOwnedSandboxSetupOptions[] = [];
    const setup = createEagerOwnedSandboxSetup(deps, undefined, async (_deps, options) => {
      calls.push(options);
    });
    expect(calls).toHaveLength(0);
    await setup.settled();
    const preparedInput = {
      input: [],
    } as unknown as EagerOwnedSandboxSetupOptions["preparedInput"];
    await setup.beforeModelStream({ fileDownloadsMaterialized: false, preparedInput });
    expect(calls).toEqual([{ fileDownloadsMaterialized: false, preparedInput }]);
  });
});

describe("a prestarted setup on a full /workspace", () => {
  const environment = { HOME: "/workspace" };
  const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });

  function fullDiskBox() {
    return {
      state: { manifest: buildManifest(settings, [], environment) },
      exec: async () => ({
        exitCode: 1,
        output: "mkdir: cannot create directory '/workspace/.opengeni': No space left on device",
      }),
      createEditor: () => ({
        createFile: async () => {
          throw new Error("write /workspace/.opengeni/stage.json: No space left on device");
        },
        deleteFile: async () => undefined,
      }),
    };
  }

  function agentAndDeps(sandbox: { leaseEpoch: number; instanceId: string }) {
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
      codemodeTokenSeed: "fixture-token",
      codemodeTokenSessionId: "fixture-session",
    });
    const { deps, rebind } = depsFor(sandbox);
    (deps as { agent: unknown }).agent = agent;
    return { agent, deps, rebind };
  }

  // The worker prestarts setup before the model input exists, as
  // runEagerOwnedSandboxSetup does for the first stream (no preparedInput).
  const realSetup = async (
    current: EagerOwnedSandboxSetupDeps,
    options: EagerOwnedSandboxSetupOptions,
  ) => {
    const box = fullDiskBox();
    await runOwnedSandboxSetup(current.agent as never, box as never, box as never, {
      settings,
      environment,
      ...(options.preparedInput ? { preparedInput: options.preparedInput } : {}),
    });
  };

  test("a prestarted setup holds its notice for the first stream's input", async () => {
    const { agent, deps } = agentAndDeps({ leaseEpoch: 1, instanceId: "box-a" });
    const setup = createEagerOwnedSandboxSetup(
      deps,
      { fileDownloadsMaterialized: true },
      realSetup,
    );
    const preparedInput = { input: "hello", persistedHistoryCount: 0 };
    await setup.beforeModelStream({
      fileDownloadsMaterialized: true,
      preparedInput: preparedInput as never,
    });
    // The setup ran before this input existed: its notice is held, and the
    // run adds held notices to its input when it starts.
    // Read through the namespace so this file still loads on code without it.
    const held = runtime.takeSandboxSetupNotices(agent);
    expect(held).toStartWith("Platform setup notice:");
    expect(held).toContain("No space left on the workspace machine's disk");
  });

  const MOVED_ASIDE_NOTICE =
    "Platform note: the repository folder repo was moved aside to repo.moved-1 before a fresh clone.";

  test("a rebound box reports only its own setup, never the earlier box's notice twice", async () => {
    const { agent, deps, rebind } = agentAndDeps({ leaseEpoch: 1, instanceId: "box-a" });
    const gate = deferred();
    let runs = 0;
    const setup = createEagerOwnedSandboxSetup(
      deps,
      { fileDownloadsMaterialized: true },
      async (current, options) => {
        runs += 1;
        await realSetup(current, options);
        if (runs === 1) {
          // Another setup notice about files that may still exist (a
          // repository folder moved aside) is held next to it.
          runtime.queueSandboxSetupNotice?.(current.agent, MOVED_ASIDE_NOTICE);
          await gate.promise;
        }
      },
    );
    rebind({ leaseEpoch: 2, instanceId: "box-b" });
    gate.resolve();
    const preparedInput = { input: "hello", persistedHistoryCount: 0 };
    await setup.beforeModelStream({
      fileDownloadsMaterialized: true,
      preparedInput: preparedInput as never,
    });
    expect(runs).toBe(2);
    expect(preparedInput.input.match(/Platform setup notice:/g)).toHaveLength(1);
    // The earlier box's setup failure notice is dropped; the moved-aside
    // notice still reaches the run's input when it starts.
    // Read through the namespace so this file still loads on code without it.
    expect(runtime.takeSandboxSetupNotices(agent)).toBe(MOVED_ASIDE_NOTICE);
  });

  test("run credential files the full disk refused join the same notice", async () => {
    const { agent } = agentAndDeps({ leaseEpoch: 1, instanceId: "box-a" });
    const box = fullDiskBox();
    const deps = {
      agent,
      input: { sessionId: "33333333-3333-4333-8333-333333333333" },
      attempt: { turnId: "44444444-4444-4444-8444-444444444444" },
      observability: createObservability(settings, { component: "worker" }),
      sandboxState: {
        resolvedSandbox: { leaseEpoch: 1, established: { instanceId: "box-a", session: box } },
        lazyOwnedSandbox: null,
        setupBoxSession: null,
      },
      eventing: {
        publish: async () => undefined,
        publishInBackground: () => undefined,
        toolCancellationFenceRef: { current: null },
      },
      leases: { renewServing: async () => undefined, servingLost: () => false },
      turnExecutionPolicy: { providerId: "openai" },
      activeSandboxBackend: "modal",
      groupBoxBackend: "modal",
      runSettings: settings,
      sandboxEnvironment: environment,
      initialRunCredentialMaterial: { environment: {}, files: [], authNeeded: [] },
      initialGitCredentials: null,
      fileResourceDownloads: [],
      runWorkspaceMutationForSandbox: async (
        _sandbox: unknown,
        _operation: string,
        mutation: () => Promise<unknown>,
      ) => await mutation(),
      // What run-credentials.ts returns when the box's disk refused the files.
      attachRunCredentialRenewal: async () => ({
        hookId: "run-credentials",
        cause: { kind: "no_space" },
      }),
      attachGitCredentialRenewal: async () => undefined,
    } as unknown as EagerOwnedSandboxSetupDeps;
    const preparedInput = { input: "hello", persistedHistoryCount: 0 };
    await runEagerOwnedSandboxSetup(deps, {
      fileDownloadsMaterialized: true,
      preparedInput: preparedInput as never,
    });
    expect(preparedInput.input.match(/Platform setup notice:/g)).toHaveLength(1);
    expect(preparedInput.input).toContain(
      "- Connected-account credentials for the shell were not written, so commands that use them can fail. No space left on the workspace machine's disk.",
    );
    expect(preparedInput.input).toContain(
      "- Opengeni tools in the shell (ogtool and the Codemode client) were not installed.",
    );
  });
});
