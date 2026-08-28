import { describe, expect, test } from "bun:test";

describe("scheduled task Connected Machine dispatch", () => {
  test("seeds the generated session route before validating and starting its first turn", async () => {
    const source = await Bun.file(
      new URL("../src/activities/scheduled-tasks.ts", import.meta.url),
    ).text();
    const dispatch = source.indexOf("async function recoverBoundScheduledTaskDispatch(");
    const seed = source.indexOf("await swapActiveSandbox(", dispatch);
    const pointerInvariant = source.indexOf("session.activeSandboxId !==", seed);
    const initialize = source.indexOf("await initializeSessionStartAtomically(", seed);

    expect(dispatch).toBeGreaterThan(0);
    expect(seed).toBeGreaterThan(dispatch);
    expect(pointerInvariant).toBeGreaterThan(seed);
    expect(initialize).toBeGreaterThan(pointerInvariant);
    expect(source.slice(seed, initialize)).toContain('"scheduled_machine_unavailable"');
  });

  test("freezes the selected machine backend and OS during occurrence acceptance", async () => {
    const source = await Bun.file(
      new URL("../src/activities/scheduled-tasks.ts", import.meta.url),
    ).text();
    const acceptance = source.indexOf("if (generatedTarget && task.agentConfig.machineTarget)");
    const acceptedExecution = source.indexOf("acceptedExecution", acceptance);

    expect(acceptance).toBeGreaterThan(0);
    expect(source.slice(acceptance, acceptedExecution)).toContain('sandboxBackend = "selfhosted"');
    expect(source.slice(acceptance, acceptedExecution)).toContain("sandboxOs = enrollment.os");
  });
});
