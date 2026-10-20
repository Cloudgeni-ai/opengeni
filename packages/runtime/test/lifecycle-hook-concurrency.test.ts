import { describe, expect, test } from "bun:test";
import {
  runBeforeAgentStartHooks,
  withSandboxLifecycleHooks,
  type SandboxLifecycleHook,
} from "../src/index";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function hook(
  id: string,
  log: string[],
  options: { independent?: boolean; gate?: Promise<void>; fail?: string } = {},
): SandboxLifecycleHook {
  return {
    id,
    phase: "beforeAgentStart",
    ...(options.independent ? { independent: true } : {}),
    run: async () => {
      log.push(`start:${id}`);
      await options.gate;
      log.push(`end:${id}`);
      if (options.fail) throw new Error(options.fail);
    },
  };
}

describe("beforeAgentStart hook scheduling", () => {
  for (const operation of ["create", "resume"] as const) {
    test(`${operation} waits for independent client installation and ordered seed, renewal and clone`, async () => {
      const log: string[] = [];
      const clientReady = deferred();
      const seedReady = deferred();
      const seedStarted = deferred();
      const cloneFinished = deferred();
      const session = {};
      const client = withSandboxLifecycleHooks(
        {
          backendId: "test",
          create: async () => session,
          resume: async () => session,
        } as never,
        [
          hook("codemode-client", log, { independent: true, gate: clientReady.promise }),
          {
            id: "codemode-token",
            phase: "beforeAgentStart",
            run: async () => {
              log.push("start:seed");
              seedStarted.resolve();
              await seedReady.promise;
              log.push("end:seed");
            },
          },
          hook("codemode-token-renewal-registration", log),
          {
            id: "repository-clone",
            phase: "beforeAgentStart",
            run: async () => {
              log.push("end:clone");
              cloneFinished.resolve();
            },
          },
        ],
        { environment: {} },
      );
      let sdkUsedSession = false;
      const ready = (
        operation === "create" ? client.create!({} as never) : client.resume!({} as never)
      ).then((result) => {
        sdkUsedSession = true;
        return result;
      });
      try {
        await seedStarted.promise;
        // Keep the seed blocked while pending scheduler continuations drain.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(log).not.toContain("start:codemode-token-renewal-registration");
        expect(log).not.toContain("end:clone");
        expect(sdkUsedSession).toBe(false);
        seedReady.resolve();
        await cloneFinished.promise;
        // Clone completion wakes this test before the decorator can settle.
        // Leave the independent client blocked for a turn so a missing
        // success-path join cannot hide behind its pending continuations.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(log.indexOf("end:seed")).toBeLessThan(
          log.indexOf("start:codemode-token-renewal-registration"),
        );
        expect(log.indexOf("end:codemode-token-renewal-registration")).toBeLessThan(
          log.indexOf("end:clone"),
        );
        expect(log).not.toContain("end:codemode-client");
        expect(sdkUsedSession).toBe(false);
        clientReady.resolve();
        await expect(ready).resolves.toBe(session);
        expect(log).toContain("end:codemode-client");
        expect(sdkUsedSession).toBe(true);
      } finally {
        seedReady.resolve();
        clientReady.resolve();
        await ready;
      }
    });
  }

  test("independent hooks overlap the ordered chain, which keeps its order", async () => {
    const log: string[] = [];
    const slow = deferred();
    const run = runBeforeAgentStartHooks(
      {} as never,
      [
        hook("doctor", log, { independent: true, gate: slow.promise }),
        hook("credentials", log),
        hook("token", log, { independent: true }),
        hook("clone", log),
      ],
      { environment: {} },
    );
    await Bun.sleep(5);
    // The ordered chain finished while the slow independent hook is still running.
    expect(log).toContain("end:clone");
    expect(log.indexOf("end:credentials")).toBeLessThan(log.indexOf("start:clone"));
    expect(log).not.toContain("end:doctor");
    slow.resolve();
    await run;
    expect(log).toContain("end:doctor");
  });

  test("setup waits for every hook and reports the earliest declared failure", async () => {
    const log: string[] = [];
    const late = deferred();
    const run = runBeforeAgentStartHooks(
      {} as never,
      [
        hook("doctor", log, { independent: true, gate: late.promise, fail: "doctor failed" }),
        hook("credentials", log, { fail: "credentials failed" }),
        hook("clone", log),
      ],
      { environment: {} },
    );
    let settled = false;
    void run.catch(() => undefined).finally(() => (settled = true));
    await Bun.sleep(5);
    // The ordered failure stops its chain but does not settle setup early.
    expect(log).not.toContain("start:clone");
    expect(settled).toBe(false);
    late.resolve();
    await expect(run).rejects.toThrow("doctor failed");
  });

  test("without independent hooks the order and first failure are unchanged", async () => {
    const log: string[] = [];
    await expect(
      runBeforeAgentStartHooks(
        {} as never,
        [hook("a", log), hook("b", log, { fail: "b failed" }), hook("c", log)],
        { environment: {} },
      ),
    ).rejects.toThrow("b failed");
    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });
});
