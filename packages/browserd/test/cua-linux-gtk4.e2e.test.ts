import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ComputerSupervisor } from "../src/computer-supervisor";
import { LinuxVirtualComputerEnvironmentAllocator } from "../src/computer-environment";
import { createCuaComputerDriver } from "../src/cua/factory";

for (const decorations of ["server", "client"]) {
  test.skipIf(process.platform !== "linux" || process.env.OPENGENI_CUA_E2E !== "1")(
    `GTK4 ${decorations} decorations preserve native pixel targeting after moving the window`,
    async () => {
      const root = await mkdtemp("/tmp/opengeni-cua-gtk4-");
      const reference = {
        computerSessionId: randomUUID(),
        controllerGeneration: randomUUID(),
      };
      const allocator = new LinuxVirtualComputerEnvironmentAllocator();
      let statePath = "";
      const supervisor = await ComputerSupervisor.open({
        rootDirectory: root,
        maxSessions: 1,
        createDriver: createCuaComputerDriver,
        environmentAllocator: {
          async allocate(context) {
            const seat = await allocator.allocate(context);
            statePath = join(context.sessionDirectory, "fixture.json");
            const child = Bun.spawn(
              [
                "python3",
                join(import.meta.dir, "fixtures/cua/Gtk4Fixture.py"),
                statePath,
                context.computerSessionId,
                decorations,
              ],
              { env: seat.environment, stdout: "ignore", stderr: "inherit" },
            );
            // A cold GTK4 renderer can take longer to initialize on ARM runners.
            // Wait only for fixture readiness; input dispatch is never retried.
            const readyDeadline = Date.now() + 30_000;
            while (!(await Bun.file(statePath).exists()) && Date.now() < readyDeadline) {
              if (child.exitCode !== null) break;
              await Bun.sleep(100);
            }
            if (!(await Bun.file(statePath).exists())) {
              child.kill();
              await child.exited;
              await seat.close();
              throw new Error(`GTK4 fixture did not open (exit ${child.exitCode})`);
            }
            return {
              ...seat,
              async close() {
                child.kill();
                await child.exited;
                await seat.close();
              },
            };
          },
        },
      });
      const call = async (tool: string, args: Record<string, unknown>) => {
        const receipt = await supervisor.nativeCall({
          protocolVersion: 1,
          operationId: randomUUID(),
          ...reference,
          targetId: null,
          actor: { kind: "agent", subjectId: "agent:fixture" },
          tool,
          arguments: args,
        });
        expect(receipt.state).toBe("completed");
        expect(receipt.observation?.result.isError).not.toBe(true);
        return receipt.observation!.result.structuredContent as any;
      };
      try {
        const session = await supervisor.createSession(reference);
        const actual = () => Bun.file(statePath).json();
        const pid = (await actual()).pid;
        const target = session.targets.find((candidate) => candidate.processId === pid);
        expect(target).toBeDefined();
        const window = { pid, window_id: Number(target!.id.split(":").at(-1)) };
        let expected = 0;
        for (const [x, y] of [
          [0, 0],
          [300, 200],
        ]) {
          await call("set_window_frame", {
            ...window,
            x,
            y,
            width: 460,
            height: 280,
          });
          const state = await call("get_window_state", {
            ...window,
            tree_format: "elements",
            timeout_ms: 5000,
          });
          expect(state.window_bounds.x).toBe(x);
          if (y === 0) {
            // The window manager keeps its server title bar on-screen.
            expect(state.window_bounds.y).toBeGreaterThanOrEqual(0);
            expect(state.window_bounds.y).toBeLessThan(64);
          } else {
            expect(state.window_bounds.y).toBe(y);
          }
          const button = state.elements.find((element: any) => element.label === "Increment");
          expect(button?.screenshot_frame).toBeDefined();
          const bounds = button.screenshot_frame;
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.y).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.w / 2).toBeLessThan(state.screenshot_width);
          expect(bounds.y + bounds.h / 2).toBeLessThan(state.screenshot_height);
          await call("click", {
            ...window,
            x: bounds.x + bounds.w / 2,
            y: bounds.y + bounds.h / 2,
            delivery_mode: "foreground",
          });
          expected++;
          // Poll application state after one dispatch; never replay a missed click.
          for (let i = 0; i < 20 && (await actual()).clicks !== expected; i++) await Bun.sleep(100);
          expect((await actual()).clicks).toBe(expected);
        }
      } finally {
        await supervisor.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
}
