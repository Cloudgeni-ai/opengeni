import { expect, test } from "bun:test";
import { ModalClient } from "modal";
import {
  ModalCommandControl,
  type ModalProviderCommand,
} from "../src/sandbox/providers/modal-command-control";

// Explicit target gate. Never create a sandbox or select another environment.
const sandboxId = process.env.OPENGENI_MODAL_ROUTER_LIVE_SANDBOX_ID;
const taskId = process.env.OPENGENI_MODAL_ROUTER_LIVE_TASK_ID;
test.skipIf(!sandboxId || !taskId)(
  "live byte-offset adapter preserves sparse streams across reconstructed readers",
  async () => {
    const client = new ModalClient({
      tokenId: process.env.MODAL_TOKEN_ID,
      tokenSecret: process.env.MODAL_TOKEN_SECRET,
    });
    const first = ModalCommandControl.forSandbox(client, sandboxId!, "/workspace");
    const second = ModalCommandControl.forSandbox(client, sandboxId!, "/workspace");
    try {
      const task = await client.cpClient.sandboxGetTaskId({ sandboxId: sandboxId! });
      expect(task.taskId).toBe(taskId);
      expect(task.taskResult).toBeUndefined();
      const original = await first.start({
        cmd: "for i in 0 1 2 3 4 5 6 7; do printf 'line:%s:€\\n' \"$i\"; sleep 0.1; done; printf 'stderr:done\\n' >&2",
        login: false,
        tty: false,
      });
      let cursor: ModalProviderCommand = original;
      let stdout = "",
        stderr = "",
        exit: number | null = null;
      const deadline = Date.now() + 30_000;
      let calls = 0;
      while (exit === null && Date.now() < deadline) {
        const page = await (calls++ % 2 ? first : second).read(cursor, 250);
        expect(page.expected).toEqual(cursor);
        for (const chunk of page.chunks) {
          if (chunk.stream === "stdout") stdout += chunk.text;
          else stderr += chunk.text;
        }
        cursor = page.command;
        exit = page.exitCode;
      }
      expect(exit).toBe(0);
      const expected = Array.from({ length: 8 }, (_, i) => `line:${i}:€\n`).join("");
      expect(stdout).toBe(expected);
      expect(stderr).toBe("stderr:done\n");
      // An unacknowledged start cursor remains fully replayable after completion.
      const replay = await second.read(original, 1000);
      expect(
        replay.chunks
          .filter((chunk) => chunk.stream === "stdout")
          .map((chunk) => chunk.text)
          .join(""),
      ).toBe(expected);
      expect(replay.exitCode).toBe(0);
    } finally {
      await first.close();
      await second.close();
      client.close();
    }
  },
  45_000,
);
