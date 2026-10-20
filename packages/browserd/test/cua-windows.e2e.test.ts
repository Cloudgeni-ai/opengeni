import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ComputerAction,
  ComputerActionCommand,
  ComputerObservation,
} from "@opengeni/contracts";
import { ExistingComputerEnvironmentAllocator } from "../src/computer-environment";
import { ComputerSupervisor } from "../src/computer-supervisor";
import { createCuaComputerDriver } from "../src/cua/factory";

type State = { pid: number; value: string; clicks: number; chords: number; ready: boolean };

// Opt-in: needs an unlocked interactive Windows desktop. Opens one disposable
// WinForms window and drives it with ordinary capture, typing, key chords and
// pointer clicks through the same controller path agents use.
test.skipIf(process.platform !== "win32" || process.env.OPENGENI_CUA_E2E !== "1")(
  "CUA captures, types, presses keys and clicks in a real Windows window",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-cua-windows-"));
    const statePath = join(root, "fixture-state.json");
    const read = async (): Promise<State | null> => {
      try {
        return (await Bun.file(statePath).json()) as State;
      } catch {
        return null;
      }
    };
    const until = async (
      check: (state: State) => boolean,
      label: string,
      attempts = 100,
    ): Promise<State> => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const state = await read();
        if (state && check(state)) return state;
        await Bun.sleep(100);
      }
      throw new Error(`Fixture never reached: ${label} (last ${JSON.stringify(await read())})`);
    };
    const fixture = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(import.meta.dir, "fixtures/cua/WindowsFixture.ps1"),
        "-Root",
        root,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    let supervisor: ComputerSupervisor | undefined;
    let launchedPid: number | undefined;
    const reference = { computerSessionId: randomUUID(), controllerGeneration: randomUUID() };
    try {
      // A cold PowerShell start that loads WinForms can take several seconds.
      const ready = await until((state) => state.ready, "window shown", 600);
      supervisor = await ComputerSupervisor.open({
        rootDirectory: join(root, "controller"),
        displaceExistingSessions: true,
        createDriver: createCuaComputerDriver,
        // Mirrors the agent entrypoint: the existing Windows seat is used only with CUA.
        environmentAllocator: new ExistingComputerEnvironmentAllocator({ allowWindows: true }),
      });
      const session = await supervisor.createSession(reference);
      expect(session.adapter).toBe("opengeni.cua.windows.v1");
      expect(session.capabilities).toMatchObject({
        windowCapture: true,
        pointerInput: true,
        keyboardInput: true,
      });
      const target = session.targets.find(
        (entry) => entry.processId === ready.pid && entry.title === "Opengeni CUA Fixture",
      );
      if (!target) throw new Error(`Fixture window not listed: ${JSON.stringify(session.targets)}`);

      const command = (
        source: ComputerObservation,
        action: ComputerAction,
        frameId: string | null = null,
      ): ComputerActionCommand => ({
        protocolVersion: 1,
        operationId: randomUUID(),
        ...reference,
        targetId: target.id,
        expectedTargetGeneration: source.target.targetGeneration,
        expectedObservationId: source.observationId,
        expectedFrameId: frameId,
        actor: { kind: "agent", subjectId: "agent:cua-windows-fixture" },
        action,
      });

      const frame = await supervisor.capture(reference, target.id, {
        maxWidth: 1280,
        maxHeight: 800,
        format: "png",
      });
      expect(frame.width).toBeGreaterThan(100);
      expect(frame.height).toBeGreaterThan(100);

      let observed = await supervisor.observe(reference, target.id);
      const typed = "Hello from Opengeni 42";
      expect(
        await supervisor.action(
          command(observed, { type: "keyboard", action: "type", value: typed }),
        ),
      ).toMatchObject({ state: "completed" });
      expect((await until((state) => state.value === typed, "typed text")).value).toBe(typed);

      observed = await supervisor.observe(reference, target.id);
      expect(
        await supervisor.action(
          command(observed, { type: "keyboard", action: "press", value: "Control+Shift+K" }),
        ),
      ).toMatchObject({ state: "completed" });
      await until((state) => state.chords === 1, "key chord");

      observed = await supervisor.observe(reference, target.id);
      const clickFrame = await supervisor.capture(reference, target.id, {
        maxWidth: 1280,
        maxHeight: 800,
        format: "png",
      });
      const click = command(
        observed,
        {
          type: "pointer",
          action: "click",
          frameId: clickFrame.frameId,
          x: clickFrame.width / 2,
          y: clickFrame.height * 0.8,
        },
        clickFrame.frameId,
      );
      expect(await supervisor.action(click)).toMatchObject({ state: "completed" });
      await until((state) => state.clicks === 1, "button click");

      // Apps launch in the background by full path. The app must open a
      // window and keep running (a console tool such as whoami.exe exits;
      // Notepad on Windows 11 hands off to a packaged app).
      expect(session.capabilities.appLaunch).toBe(true);
      observed = await supervisor.observe(reference, target.id);
      const launched = await supervisor.action(
        command(observed, {
          type: "launch",
          applicationId: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "charmap.exe"),
        }),
      );
      launchedPid = launched.observation?.target.processId ?? undefined;
      // An elevated CUA driver starts apps only with a standard-user token,
      // which it cannot do for a restored background launch (hosted CI
      // runners are elevated). That launch must fail with CUA's own reason,
      // never silently or as a bare protocol error.
      if (elevated()) {
        expect(launched.state).not.toBe("completed");
        expect(JSON.stringify(launched.error)).toContain("Driver is elevated");
      } else {
        expect(launched).toMatchObject({ state: "completed" });
      }
    } finally {
      await supervisor?.close();
      // Only the process this test launched.
      if (launchedPid !== undefined) Bun.spawnSync(["taskkill", "/F", "/PID", String(launchedPid)]);
      fixture.kill();
      await fixture.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

/** Whether this process runs elevated, which the CUA driver it starts
 * inherits and checks for itself. An administrator's token is a member of the
 * Administrators role only when elevated (UAC filters it otherwise). */
function elevated(): boolean {
  const probe = Bun.spawnSync([
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  ]);
  const answer = probe.stdout.toString().trim();
  if (probe.exitCode !== 0 || (answer !== "True" && answer !== "False"))
    throw new Error(`elevation probe failed: ${answer} ${probe.stderr.toString().trim()}`);
  return answer === "True";
}
