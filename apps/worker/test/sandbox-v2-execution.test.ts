import { expect, test } from "bun:test";
import type { Database } from "@opengeni/db";
import type { SandboxV2TurnMachine } from "@opengeni/core";
import { createTurnInvocationDrain, buildSandboxV2PreparedFileManifest } from "@opengeni/runtime";
import { shell, type SandboxSessionLike } from "@openai/agents/sandbox";
import type { MachineBackend } from "@opengeni/runtime/sandbox";
import { createSandboxV2TurnExecution } from "../src/sandbox-v2-execution";

function fixture(options: {
  renewal: { stop(): Promise<void> };
  mcp: { close(): void };
  signal?: AbortSignal;
}) {
  let reads = 0;
  const db = new Proxy({} as Database, {
    get: () => {
      reads++;
      throw Error("Synthetic control database unavailable");
    },
  });
  const instance = {
    id: "synthetic-instance",
    bootId: "a".repeat(64),
    diskLineage: crypto.randomUUID(),
  };
  const machine: SandboxV2TurnMachine = {
    engine: "machine-v2",
    authority: {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      machineId: crypto.randomUUID(),
      instance,
    },
    provider: "synthetic",
    transport: {
      exec: async () => {
        throw Error("No agent I/O during finalization");
      },
    },
    capabilities: { stdin: true, pty: false },
    releaseRevoked: async () => {
      throw Error("An unavailable control observer cannot release demand");
    },
  };
  const session: SandboxSessionLike = {
    state: {
      kind: "machine-v2",
      machineId: machine.authority.machineId,
      instance,
      manifest: buildSandboxV2PreparedFileManifest([]),
    },
  };
  const invocations = createTurnInvocationDrain();
  const prepared = { session, capabilities: [shell()] };
  const providers = new Map([
    [
      "synthetic",
      {
        backend: { provider: "synthetic" } as MachineBackend,
        transport: {
          exec: async () => {
            throw Error("No physical I/O before local drain");
          },
        },
      },
    ],
  ]);
  const owner = createSandboxV2TurnExecution(db, machine, prepared, providers, {
    invocations,
    ...(options.signal ? { signal: options.signal } : {}),
    credentialRenewal: options.renewal,
    runMcpCredentials: options.mcp,
  });
  return { owner, invocations, reads: () => reads, db, machine, prepared, providers };
}

test("worker cancellation closes a supplied invocation owner without detaching its started callback", async () => {
  const controller = new AbortController();
  const callback = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const reason = new Error("Synthetic worker cancellation");
  const f = fixture({
    signal: controller.signal,
    renewal: { stop: async () => {} },
    mcp: { close() {} },
  });
  const call = f.invocations.run(async () => {
    started.resolve();
    await callback.promise;
  });
  await started.promise;
  controller.abort(reason);
  await expect(f.invocations.run(async () => {})).rejects.toBe(reason);
  let drained = false;
  const closing = f.owner.closeAndDrain().then(() => {
    drained = true;
  });
  await Bun.sleep(0);
  expect(drained).toBe(false);
  expect(f.reads()).toBe(0);
  callback.resolve();
  await call;
  await closing;
  expect(drained).toBe(true);
  expect(f.reads()).toBe(0);
});

test("native finalization drains local callbacks and a started renewal before control observation", async () => {
  const callback = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const renewal = Promise.withResolvers<void>();
  let closes = 0;
  let stops = 0;
  const f = fixture({
    renewal: {
      stop: async () => {
        stops++;
        await renewal.promise;
      },
    },
    mcp: {
      close: () => {
        closes++;
      },
    },
  });
  const call = f.invocations.run(async () => {
    started.resolve();
    await callback.promise;
  });
  await started.promise;
  const finalizing = f.owner.finalize();
  const finalOutcome = finalizing.catch((error) => error);
  await Bun.sleep(0);
  expect(closes).toBe(1);
  expect(stops).toBe(1);
  expect(f.reads()).toBe(0);
  await expect(f.invocations.run(async () => {})).rejects.toThrow("TURN_ATTEMPT_FINALIZED");
  callback.resolve();
  await call;
  await Bun.sleep(0);
  expect(f.reads()).toBe(0);
  renewal.resolve();
  expect((await finalOutcome).message).toBe("Synthetic control database unavailable");
  await expect(f.owner.finalize()).rejects.toThrow("Synthetic control database unavailable");
  expect(closes).toBe(1);
  expect(stops).toBe(1);
});

test("a failing host close still drains other owners and never manufactures physical settlement", async () => {
  const callback = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let stops = 0;
  const failure = new Error("Synthetic MCP close failure");
  const f = fixture({
    renewal: {
      stop: async () => {
        stops++;
      },
    },
    mcp: {
      close: () => {
        throw failure;
      },
    },
  });
  const call = f.invocations.run(async () => {
    started.resolve();
    await callback.promise;
  });
  await started.promise;
  let completed = false;
  const outcome = f.owner.finalize().then(
    () => {
      completed = true;
    },
    (error) => {
      completed = true;
      return error;
    },
  );
  await Bun.sleep(0);
  expect(stops).toBe(1);
  expect(completed).toBe(false);
  expect(f.reads()).toBe(0);
  callback.resolve();
  await call;
  expect(await outcome).toBe(failure);
  expect(f.reads()).toBe(0);
});

test("native execution rejects a mixed incarnation or missing original provider before any I/O", () => {
  const f = fixture({ renewal: { stop: async () => {} }, mcp: { close: () => {} } });
  expect(() =>
    createSandboxV2TurnExecution(
      f.db,
      f.machine,
      {
        ...f.prepared,
        session: {
          state: {
            ...f.prepared.session.state,
            instance: { ...f.machine.authority.instance, bootId: "b".repeat(64) },
          },
        },
      },
      f.providers,
    ),
  ).toThrow("exact prepared machine");
  expect(() => createSandboxV2TurnExecution(f.db, f.machine, f.prepared, new Map())).toThrow(
    "exact prepared machine",
  );
  expect(f.reads()).toBe(0);
});
