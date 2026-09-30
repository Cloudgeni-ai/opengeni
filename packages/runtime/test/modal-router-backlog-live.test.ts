import { expect, test } from "bun:test";
import { ModalClient } from "modal";
import {
  ModalCommandControl,
  type ModalProviderCommand,
} from "../src/sandbox/providers/modal-command-control";
import { MODAL_ROUTER_READ_PAGE_BYTES } from "../src/sandbox/providers/modal-command-router-wire";

// Explicit target gate. Never create a sandbox or select another environment.
const sandboxId = process.env.OPENGENI_MODAL_ROUTER_LIVE_SANDBOX_ID;
const taskId = process.env.OPENGENI_MODAL_ROUTER_LIVE_TASK_ID;
const BYTES = 8_000_000;

test.skipIf(!sandboxId || !taskId)(
  "live: a finished command's multi-megabyte backlog settles in a few reads",
  async () => {
    const client = new ModalClient({
      tokenId: process.env.MODAL_TOKEN_ID,
      tokenSecret: process.env.MODAL_TOKEN_SECRET,
    });
    const control = ModalCommandControl.forSandbox(client, sandboxId!, "/workspace");
    try {
      const task = await client.cpClient.sandboxGetTaskId({ sandboxId: sandboxId! });
      expect(task.taskId).toBe(taskId);
      const started = await control.start({
        cmd: `head -c ${BYTES} /dev/zero | tr '\\0' x`,
        login: false,
        tty: false,
      });
      // Nobody reads for a while, as after a turn ends. Record whether the
      // provider keeps the process blocked on unread output.
      await Bun.sleep(15_000);
      let cursor: ModalProviderCommand = started;
      let exit: number | null = null,
        reads = 0,
        recorded = 0;
      const deadline = Date.now() + 60_000;
      while (exit === null && Date.now() < deadline) {
        const page = await control.read(cursor, 1000);
        reads++;
        for (const chunk of page.chunks) recorded += chunk.text.length;
        cursor = page.command;
        exit = page.exitCode;
      }
      if (cursor.kind !== "modal-router-v1") throw new Error("expected a byte-offset command");
      console.log(
        JSON.stringify({ reads, pageBytes: MODAL_ROUTER_READ_PAGE_BYTES, recorded, exit }),
      );
      expect(exit).toBe(0);
      expect(cursor.streams.stdout.byteOffset).toBe(BYTES);
      expect(recorded).toBe(BYTES);
      expect(reads).toBeLessThanOrEqual(Math.ceil(BYTES / MODAL_ROUTER_READ_PAGE_BYTES) + 2);
    } finally {
      await control.close();
      client.close();
    }
  },
  120_000,
);
