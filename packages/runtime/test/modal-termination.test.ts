import { describe, expect, test } from "bun:test";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { testSettings } from "@opengeni/testing";
import {
  installOpenGeniModalSnapshotPolicy,
  terminateModalSandboxById,
  sweepModalOrphanSandboxes,
} from "../src/sandbox/providers/modal";

const settings = testSettings({ sandboxBackend: "modal", modalAppName: "termination-test" });

function provider(terminate: (options?: { wait?: boolean }) => Promise<unknown>) {
  let closed = false;
  let listed = false;
  const client = {
    sandboxes: { fromId: async () => ({ terminate }) },
    apps: { fromName: async () => ({ appId: "ap-test" }) },
    cpClient: {
      sandboxList: async () => {
        if (listed) return { sandboxes: [] };
        listed = true;
        return { sandboxes: [{ id: "sb-test", createdAt: 1, tags: [] }] };
      },
    },
    close() {
      closed = true;
    },
  };
  return { client: client as never, isClosed: () => closed };
}

function fixture(
  terminate: (options?: { wait?: boolean }) => Promise<unknown>,
  ownsSandbox = true,
) {
  return installOpenGeniModalSnapshotPolicy(
    new ModalSandboxSession({
      state: { workspacePersistence: "tar", manifest: { root: "/workspace" } },
      modal: { version: () => "0.9.0" },
      sandbox: { terminate },
      app: {},
      ownsSandbox,
    } as never),
  );
}

describe("Modal physical termination confirmation", () => {
  test("SDK shutdown cannot finish at stop acknowledgement before provider exit", async () => {
    const stopped = Promise.withResolvers<number>();
    const called = Promise.withResolvers<void>();
    let finished = false;
    const session = fixture(async (options) => {
      called.resolve();
      return options?.wait ? stopped.promise : undefined;
    });
    const closing = session.shutdown().then(() => {
      finished = true;
    });
    await called.promise;
    // Drain scheduled close continuations, without a wall-clock race.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const early = finished;
    stopped.resolve(137);
    await closing;
    expect(early).toBe(false);
    expect(finished).toBe(true);
  });

  test("provider wait failure propagates and leaves SDK close retryable", async () => {
    const failure = new Error("provider exit unavailable");
    let calls = 0;
    const session = fixture(async (options) => {
      calls++;
      if (!options?.wait) return undefined;
      if (calls === 1) throw failure;
      return 137;
    });
    await expect(session.close()).rejects.toBe(failure);
    await session.close();
    expect(calls).toBe(2);
  });

  test("a stop acknowledgement without an exit code is not confirmation", async () => {
    const session = fixture(async () => undefined);
    await expect(session.close()).rejects.toThrow("terminal exit");
  });

  test("closing a borrowed SDK handle never stops or waits for the owned sandbox", async () => {
    let calls = 0;
    const session = fixture(async () => {
      calls++;
      throw Error("must not terminate");
    }, false);
    await session.close();
    expect(calls).toBe(0);
  });

  test("shutdown confirms the replacement handle, not a stale pre-hydration handle", async () => {
    const session = fixture(async () => {
      throw Error("old handle used");
    });
    let waited = false;
    Reflect.set(session, "sandbox", {
      terminate: async (options?: { wait?: boolean }) => {
        waited = options?.wait === true;
        return 137;
      },
    });
    await session.shutdown();
    expect(waited).toBe(true);
  });

  test("by-id cleanup retains its client and cannot return success before exit", async () => {
    const stopped = Promise.withResolvers<number>();
    const called = Promise.withResolvers<void>();
    const p = provider(async (options) => {
      called.resolve();
      return options?.wait ? stopped.promise : undefined;
    });
    let finished = false;
    const cleanup = terminateModalSandboxById(settings, "sb-test", async () => p.client).then(
      (value) => {
        finished = true;
        return value;
      },
    );
    await called.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const early = { finished, closed: p.isClosed() };
    stopped.resolve(137);
    expect(await cleanup).toBe(true);
    expect(early).toEqual({ finished: false, closed: false });
    expect(p.isClosed()).toBe(true);
  });

  test("orphan sweep does not report an acknowledged but unconfirmed stop", async () => {
    const p = provider(async () => undefined);
    const result = await sweepModalOrphanSandboxes(settings, [], {
      client: p.client,
      now: new Date(1_000_000),
    });
    expect(result.terminated).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  test("orphan sweep waits for the exact candidate's terminal result", async () => {
    const stopped = Promise.withResolvers<number>();
    const called = Promise.withResolvers<void>();
    const p = provider(async (options) => {
      called.resolve();
      return options?.wait ? stopped.promise : undefined;
    });
    let finished = false;
    const cleanup = sweepModalOrphanSandboxes(settings, [], {
      client: p.client,
      now: new Date(1_000_000),
    }).then((value) => {
      finished = true;
      return value;
    });
    await called.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const early = finished;
    stopped.resolve(137);
    expect((await cleanup).terminated.map((candidate) => candidate.sandboxId)).toEqual(["sb-test"]);
    expect(early).toBe(false);
  });
});
