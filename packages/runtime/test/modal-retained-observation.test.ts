import { describe, expect, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { installOpenGeniModalSnapshotPolicy } from "../src/sandbox/providers/modal";

// Exercise the pinned SDK process map, exec yielding, and terminal output. Only
// the remote transport is replaced; two adapters share one physical command.
describe("Modal retained-command observation", () => {
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
