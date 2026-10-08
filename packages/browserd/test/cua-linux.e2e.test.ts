import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ComputerSupervisor } from "../src/computer-supervisor";
import { LinuxVirtualComputerEnvironmentAllocator } from "../src/computer-environment";
import { createCuaComputerDriver } from "../src/cua/factory";

test.skipIf(process.platform !== "linux" || process.env.OPENGENI_CUA_E2E !== "1")(
  "native CUA batches and viewer captures stay inside two isolated Linux ComputerSessions",
  async () => {
    const root = await mkdtemp("/tmp/opengeni-cua-linux-");
    const references = [0, 1].map(() => ({
      computerSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
    }));
    const allocator = new LinuxVirtualComputerEnvironmentAllocator();
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const states = new Map<string, string>();
    const supervisor = await ComputerSupervisor.open({
      rootDirectory: root,
      maxSessions: 2,
      createDriver: createCuaComputerDriver,
      environmentAllocator: {
        async allocate(context) {
          const seat = await allocator.allocate(context);
          const state = join(context.sessionDirectory, "fixture.json");
          states.set(context.computerSessionId, state);
          const fixture = Bun.spawn(
            [
              "python3",
              join(import.meta.dir, "fixtures/cua/Fixture.py"),
              state,
              context.computerSessionId,
            ],
            {
              env: seat.environment,
              stdout: "ignore",
              stderr: "inherit",
            },
          );
          children.push(fixture);
          for (let i = 0; i < 100 && !(await Bun.file(state).exists()); i++) await Bun.sleep(100);
          if (!(await Bun.file(state).exists())) throw new Error("GTK fixture did not open");
          return {
            ...seat,
            async close() {
              fixture.kill();
              await fixture.exited;
              await seat.close();
            },
          };
        },
      },
    });
    const actual = async (index: number) =>
      Bun.file(states.get(references[index]!.computerSessionId)!).json();
    try {
      const [first, second] = await Promise.all(
        references.map((reference) => supervisor.createSession(reference)),
      );
      expect(first!.displayId).not.toBe(second!.displayId);
      expect(first!.adapter).toBe("opengeni.cua.linux.v1");
      const firstState = await actual(0);
      const target = first!.targets.find((target) => target.processId === firstState.pid)!;
      expect(target).toBeDefined();
      expect(second!.targets.some((target) => target.processId === firstState.pid)).toBe(false);
      const windowId = Number(target.id.split(":").at(-1));
      const command = (tool: string, args: Record<string, unknown>, index = 0) => ({
        protocolVersion: 1 as const,
        operationId: randomUUID(),
        ...references[index]!,
        targetId: null,
        actor: { kind: "agent" as const, subjectId: "agent:fixture" },
        tool,
        arguments: args,
      });
      const windowArgs = { pid: firstState.pid, window_id: windowId };
      expect(
        (await supervisor.nativeCall(command("set_agent_cursor_enabled", { enabled: false }, 1)))
          .state,
      ).toBe("completed");
      const cursor = await supervisor.nativeCall(
        command("set_agent_cursor_enabled", { enabled: true }),
      );
      expect(cursor.state).toBe("completed");
      const cursorState = await supervisor.nativeCall(command("get_agent_cursor_state", {}));
      expect(cursorState.observation!.result.structuredContent).toMatchObject({ enabled: true });
      const otherCursor = await supervisor.nativeCall(command("get_agent_cursor_state", {}, 1));
      expect(otherCursor.observation!.result.structuredContent).toMatchObject({ enabled: false });
      const clipboard = await supervisor.nativeCall(
        command("clipboard_write", { text: "Linux seat one Ω" }),
      );
      expect(clipboard.state).toBe("completed");
      const clipboardRead = await supervisor.nativeCall(
        command("clipboard_read", { include_text: true }),
      );
      expect(clipboardRead.observation!.result.structuredContent).toMatchObject({
        text: "Linux seat one Ω",
      });
      const otherClipboard = await supervisor.nativeCall(
        command("clipboard_read", { include_text: true }, 1),
      );
      expect((otherClipboard.observation!.result.structuredContent as any).text).not.toBe(
        "Linux seat one Ω",
      );
      const read = await supervisor.nativeCall(
        command("get_window_state", { ...windowArgs, tree_format: "elements" }),
      );
      expect(read.state).toBe("completed");
      const native = read.observation!.result.structuredContent as any;
      const input = native.elements.find((element: any) => element.label === "Fixture text");
      const button = native.elements.find((element: any) => element.label === "Increment");
      expect(input.element_token).toBeString();
      expect(button.element_token).toBeString();
      // Passive viewer reads may neither replace the native tokens nor the scale.
      for (let i = 0; i < 4; i++) {
        const frame = await supervisor.capture(references[0]!, target.id, {
          maxWidth: 240,
          maxHeight: 180,
        });
        expect(frame.data.subarray(0, 4)).toEqual(Buffer.from([137, 80, 78, 71]));
      }
      const batch = command("run_actions", {
        steps: [
          {
            tool: "set_value",
            args: { ...windowArgs, element_token: input.element_token, value: "Native Linux Ω" },
          },
          { tool: "click", args: { ...windowArgs, element_token: button.element_token } },
        ],
        observe: windowArgs,
      });
      const receipt = await supervisor.nativeCall(batch);
      expect(receipt.state).toBe("completed");
      expect(await supervisor.nativeCall(batch)).toEqual(receipt);
      await Bun.sleep(150);
      expect(await actual(0)).toMatchObject({ value: "Native Linux Ω", clicks: 1 });
      expect(await actual(1)).toMatchObject({ value: "", clicks: 0 });
      expect(
        (receipt.observation!.result.structuredContent as any).observation.state.since_status,
      ).toBe("diff");
      const fresh = await supervisor.nativeCall(
        command("get_window_state", { ...windowArgs, tree_format: "elements" }),
      );
      const state = fresh.observation!.result.structuredContent as any;
      const currentButton = state.elements.find((element: any) => element.label === "Increment");
      const bounds = currentButton.screenshot_frame;
      const click = await supervisor.nativeCall(
        command("click", {
          ...windowArgs,
          x: bounds.x + bounds.w / 2,
          y: bounds.y + bounds.h / 2,
          delivery_mode: "foreground",
        }),
      );
      expect(click.state).toBe("completed");
      // Dispatch completion is not application-effect proof. Observe the one
      // dispatched click without replaying it, retaining evidence if it missed.
      for (let i = 0; i < 20 && (await actual(0)).clicks !== 2; i++) await Bun.sleep(100);
      const afterClick = await actual(0);
      if (afterClick.clicks !== 2) {
        const afterWindow = await supervisor.nativeCall(
          command("get_window_state", { ...windowArgs, tree_format: "elements" }),
        );
        console.error(
          JSON.stringify({
            button: currentButton,
            receipt: click,
            fixture: afterClick,
            afterWindow: afterWindow.observation?.result.structuredContent,
          }),
        );
      }
      expect(afterClick.clicks).toBe(2);
      expect((await actual(1)).clicks).toBe(0);
      // Background refusal is returned honestly; never escalated and retried.
      const background = await supervisor.nativeCall(
        command("scroll", { ...windowArgs, direction: "down", delivery_mode: "background" }),
      );
      if (background.state !== "completed")
        expect(background.observation!.result.isError).toBe(true);
      // A non-GUI child must also stop: losing Xvfb alone would mask leaks.
      const launched = await supervisor.nativeCall(
        command("launch_app", { launch_path: "/usr/bin/sleep", additional_arguments: ["600"] }),
      );
      expect(launched.state).toBe("completed");
      const childPid = (launched.observation!.result.structuredContent as any).launcher_pid;
      expect(childPid).toBeNumber();
      const childEnvironment = (await readFile(`/proc/${childPid}/environ`, "utf8")).split("\0");
      expect(childEnvironment).toContain(`DISPLAY=${first!.displayId}`);
      expect(childEnvironment).toContain(
        `HOME=${join(root, "computer-sessions", references[0]!.computerSessionId, "gui-home")}`,
      );
      expect(
        childEnvironment.some((entry) =>
          /^(WAYLAND_DISPLAY|XAUTHORITY|AT_SPI_BUS_ADDRESS)=/.test(entry),
        ),
      ).toBe(false);
      await supervisor.endSession(references[0]!);
      let childStopped = false;
      try {
        const stat = await readFile(`/proc/${childPid}/stat`, "utf8");
        childStopped = stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z ");
      } catch (error) {
        childStopped = (error as NodeJS.ErrnoException).code === "ENOENT";
      }
      expect(childStopped).toBe(true);
      expect((await supervisor.nativeCall(command("list_windows", {}, 1))).state).toBe("completed");
    } finally {
      await supervisor.close();
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map((child) => child.exited));
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
