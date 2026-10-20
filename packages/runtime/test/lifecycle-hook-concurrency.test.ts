import { describe, expect, test } from "bun:test";
import { runBeforeAgentStartHooks, type SandboxLifecycleHook } from "../src/index";

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
