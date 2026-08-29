import { describe, expect, test } from "bun:test";

describe("scheduled task Connected Machine dispatch", () => {
  test("shares fail-closed route seeding across first dispatch and recovery", async () => {
    const source = await Bun.file(
      new URL("../src/activities/scheduled-tasks.ts", import.meta.url),
    ).text();
    const normalDispatch = source.indexOf("const executeDispatch = async");
    const normalSeed = source.indexOf(
      "session = await seedScheduledGeneratedSessionRoute(",
      normalDispatch,
    );
    const normalInitialize = source.indexOf("await initializeSessionStartAtomically(", normalSeed);
    const sharedSeed = source.indexOf("async function seedScheduledGeneratedSessionRoute(");
    const swap = source.indexOf("await swapActiveSandbox(", sharedSeed);
    const atomicFailure = source.indexOf("await failScheduledGeneratedSessionRoute(", swap);
    const recovery = source.indexOf("async function recoverBoundScheduledTaskDispatch(");
    const recoverySeed = source.indexOf(
      "session = await seedScheduledGeneratedSessionRoute(",
      recovery,
    );
    const pointerInvariant = source.indexOf("session.activeSandboxId !==", recoverySeed);
    const recoveryInitialize = source.indexOf(
      "await initializeSessionStartAtomically(",
      pointerInvariant,
    );

    expect(normalDispatch).toBeGreaterThan(0);
    expect(normalSeed).toBeGreaterThan(normalDispatch);
    expect(normalInitialize).toBeGreaterThan(normalSeed);
    expect(sharedSeed).toBeGreaterThan(normalInitialize);
    expect(swap).toBeGreaterThan(sharedSeed);
    expect(atomicFailure).toBeGreaterThan(swap);
    expect(recovery).toBeGreaterThan(atomicFailure);
    expect(recoverySeed).toBeGreaterThan(recovery);
    expect(pointerInvariant).toBeGreaterThan(recoverySeed);
    expect(recoveryInitialize).toBeGreaterThan(pointerInvariant);
  });

  test("freezes the selected machine backend and OS during occurrence acceptance", async () => {
    const source = await Bun.file(
      new URL("../src/activities/scheduled-tasks.ts", import.meta.url),
    ).text();
    const acceptance = source.indexOf("if (generatedTarget && task.agentConfig.machineTarget)");
    const acceptedExecution = source.indexOf("acceptedExecution", acceptance);
    const sessionCreate = source.indexOf("const sessionInput:", acceptedExecution);
    const sessionInitialize = source.indexOf(
      "await initializeSessionStartAtomically(",
      sessionCreate,
    );

    expect(acceptance).toBeGreaterThan(0);
    expect(source.slice(acceptance, acceptedExecution)).toContain('sandboxBackend = "selfhosted"');
    expect(source.slice(acceptance, acceptedExecution)).toContain("sandboxOs = enrollment.os");
    expect(source.slice(sessionCreate, sessionInitialize)).toContain("sandboxBackend,");
    expect(source.slice(sessionCreate, sessionInitialize)).toContain("sandboxOs,");
    expect(source.slice(sessionCreate, sessionInitialize)).not.toContain('sandboxOs: "linux"');
  });
});
