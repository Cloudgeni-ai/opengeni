import { describe, expect, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import {
  installOpenGeniModalSnapshotPolicy,
  ModalProcessObservationUnavailableError,
} from "../src/sandbox/providers/modal";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";
import { ChannelAConflictError, SandboxChannelAService } from "../src/sandbox/channel-a";

// Exercise the pinned SDK process map, exec yielding, and terminal output. Only
// the remote transport is replaced; two adapters share one physical command.
describe("Modal retained-command observation", () => {
  test.each([undefined, {}, { has: () => true }])(
    "rejects unsupported SDK process-map shape before observing",
    async (activeProcesses) => {
      const owner = installOpenGeniModalSnapshotPolicy(
        new ModalSandboxSession({
          state: {
            sandboxId: "sb-unsupported-map",
            manifest: new Manifest({ root: "/workspace" }),
            environment: {},
            workspacePersistence: "tar",
          },
          sandbox: {},
          modal: { version: () => "0.9.0" },
          app: {},
        } as never),
      );
      Object.assign(owner, { activeProcesses });
      await expect(
        owner.writeStdin({ sessionId: 1, chars: "input", yieldTimeMs: 1 }),
      ).rejects.toThrow("observation unavailable");
      await expect(
        new SandboxChannelAService({ session: owner }).ptyWrite(
          { ptyId: "unsupported-pty", data: "input" },
          1,
          "input",
        ),
      ).rejects.toBeInstanceOf(ModalProcessObservationUnavailableError);
      const terminal = new SandboxChannelAService({ session: owner });
      await expect(
        terminal.ptyResize({ ptyId: "unsupported-pty", cols: 80, rows: 24 }, 1),
      ).rejects.toBeInstanceOf(ModalProcessObservationUnavailableError);
      await expect(terminal.ptyClose({ ptyId: "unsupported-pty" }, 1)).rejects.toBeInstanceOf(
        ModalProcessObservationUnavailableError,
      );
    },
  );

  test.each([
    [0, "control"],
    [1, "control"],
    [0, "pty"],
    [1, "pty"],
  ] as const)(
    "preserves a real exit %i through %s whose output resembles a missing SDK handle",
    async (exitCode, surface) => {
      let finish!: (code: number) => void;
      const exited = new Promise<number>((resolve) => {
        finish = resolve;
      });
      let output!: ReadableStreamDefaultController<string>;
      const sandbox = {
        exec: async () => ({
          stdout: new ReadableStream<string>({
            start(controller) {
              output = controller;
            },
          }),
          stderr: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          wait: () => exited,
        }),
      };
      const owner = installOpenGeniModalSnapshotPolicy(
        new ModalSandboxSession({
          state: {
            sandboxId: "sb-output-collision",
            manifest: new Manifest({ root: "/workspace" }),
            environment: {},
            workspacePersistence: "tar",
          },
          sandbox,
          modal: { version: () => "0.9.0" },
          app: {},
        } as never),
      );
      const proofs: unknown[] = [];
      const chunks: string[] = [];
      const routed = new RoutingSandboxSession({
        readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
        resolveActiveBackend: async () => ({ session: owner, sandboxId: null, kind: "modal" }),
        beforeMutation: async () => "parent",
        afterMutation: async () => undefined,
        settleProcess: async ({ proof }) => {
          proofs.push(proof);
        },
        captureProcessOutput: async ({ chunk }) => {
          chunks.push(chunk);
        },
      });
      const started = await routed.execCommand({
        cmd: "print-lost-looking-output",
        yieldTimeMs: 1,
      });
      expect(started).toContain("Process running with session ID 1");
      output.enqueue("session not found: 1");
      output.close();
      finish(exitCode);
      const result =
        surface === "pty"
          ? await new SandboxChannelAService({ session: routed }).ptyWrite(
              { ptyId: "test-pty", data: "" },
              1,
              "",
            )
          : await routed.writeStdinForProcessControl({ sessionId: 1, chars: "", yieldTimeMs: 10 });
      if (surface === "control") expect(result).toContain(`Process exited with code ${exitCode}`);
      expect(result).toContain("session not found: 1");
      expect(proofs).toEqual([{ outcome: "exited", exitCode, reason: "provider_exit_banner" }]);
      expect(chunks.join("")).toBe("session not found: 1");
      expect(routed.hasRetainedProcess(1)).toBe(false);
      await expect(owner.writeStdin({ sessionId: 1, chars: "", yieldTimeMs: 1 })).rejects.toThrow(
        "observation unavailable",
      );
    },
  );

  test("a second adapter cannot declare the owner's still-running command lost", async () => {
    let finish!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    let starts = 0;
    let stdinWrites = 0;
    const sandbox = {
      exec: async () => {
        starts += 1;
        return {
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue("retained output\n");
              controller.close();
            },
          }),
          stderr: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          wait: () => exited,
          stdin: {
            writeText: async () => {
              stdinWrites += 1;
            },
          },
        };
      },
    };
    const state = {
      sandboxId: "sb-same-instance",
      manifest: new Manifest({ root: "/workspace" }),
      environment: {},
      workspacePersistence: "tar",
    };
    const adapter = () =>
      installOpenGeniModalSnapshotPolicy(
        new ModalSandboxSession({
          state,
          sandbox,
          modal: { version: () => "0.9.0" },
          app: {},
        } as never),
      );
    const owner = adapter();
    const observer = adapter();
    const started = await owner.execCommand({ cmd: "long-running-test", yieldTimeMs: 1 });
    expect(started).toContain("Process running with session ID 1");
    try {
      await expect(
        observer.writeStdin({ sessionId: 1, chars: "", yieldTimeMs: 1 }),
      ).rejects.toThrow("observation unavailable");
      await expect(
        new SandboxChannelAService({ session: observer }).ptyWrite(
          { ptyId: "resumed-pty", data: "do-not-replay" },
          1,
          "do-not-replay",
        ),
      ).rejects.toBeInstanceOf(ChannelAConflictError);
      const terminal = new SandboxChannelAService({ session: observer });
      await expect(
        terminal.ptyResize({ ptyId: "resumed-pty", cols: 80, rows: 24 }, 1),
      ).rejects.toBeInstanceOf(ChannelAConflictError);
      await expect(terminal.ptyClose({ ptyId: "resumed-pty" }, 1)).rejects.toBeInstanceOf(
        ChannelAConflictError,
      );
      expect(starts).toBe(1);
      expect(stdinWrites).toBe(0);
    } finally {
      finish(0);
    }
    expect(await owner.writeStdin({ sessionId: 1, chars: "", yieldTimeMs: 10 })).toContain(
      "Process exited with code 0",
    );
    // Completed-map eviction is not physical loss proof either.
    await expect(owner.writeStdin({ sessionId: 1, chars: "", yieldTimeMs: 1 })).rejects.toThrow(
      "observation unavailable",
    );
  });
});
