import { expect, test } from "bun:test";
import { ModalClient, type Sandbox } from "modal";
import {
  ModalCommandControl,
  type ModalProviderCommand,
} from "../src/sandbox/providers/modal-command-control";
import { MODAL_ROUTER_READ_PAGE_BYTES } from "../src/sandbox/providers/modal-command-router-wire";

// Explicit target gate: either an existing sandbox (never created or selected
// here), or an explicit opt-in app for ONE disposable sandbox that this test
// creates and always terminates.
const targetSandboxId = process.env.OPENGENI_MODAL_ROUTER_LIVE_SANDBOX_ID;
const targetTaskId = process.env.OPENGENI_MODAL_ROUTER_LIVE_TASK_ID;
const disposableApp = process.env.OPENGENI_MODAL_ROUTER_LIVE_DISPOSABLE_APP;
const BYTES = 8_000_000;

test.skipIf(!(targetSandboxId && targetTaskId) && !disposableApp)(
  "live: a finished command's multi-megabyte backlog settles in a few reads",
  async () => {
    const client = new ModalClient({
      tokenId: process.env.MODAL_TOKEN_ID,
      tokenSecret: process.env.MODAL_TOKEN_SECRET,
    });
    let disposable: Sandbox | null = null;
    let control: ModalCommandControl | null = null;
    try {
      let sandboxId = targetSandboxId,
        taskId = targetTaskId;
      if (!sandboxId || !taskId) {
        const app = await client.apps.fromName(disposableApp!, { createIfMissing: true });
        disposable = await client.sandboxes.create(
          app,
          client.images.fromRegistry("debian:bookworm-slim"),
          { command: ["sleep", "infinity"], timeoutMs: 10 * 60_000 },
        );
        sandboxId = disposable.sandboxId;
        const ready = Date.now() + 120_000;
        while (!taskId && Date.now() < ready) {
          taskId = (await client.cpClient.sandboxGetTaskId({ sandboxId })).taskId || undefined;
          if (!taskId) await Bun.sleep(1000);
        }
        if (!taskId) throw new Error("disposable sandbox did not start a task in time");
        const mkdir = await disposable.exec(["mkdir", "-p", "/workspace"]);
        expect(await mkdir.wait()).toBe(0);
      }
      const task = await client.cpClient.sandboxGetTaskId({ sandboxId });
      expect(task.taskId).toBe(taskId);
      control = ModalCommandControl.forSandbox(client, sandboxId, "/workspace");
      const started = await control.start({
        cmd: `head -c ${BYTES} /dev/zero | tr '\\0' x`,
        login: false,
        tty: false,
      });
      // Nobody reads for a while, as after a turn ends.
      await Bun.sleep(15_000);
      let cursor: ModalProviderCommand = started;
      let exit: number | null = null,
        reads = 0,
        recorded = 0,
        exitedWhileUnread: boolean | undefined;
      const deadline = Date.now() + 60_000;
      while (exit === null && Date.now() < deadline) {
        const page = await control.read(cursor, 1000);
        reads++;
        // Whether the provider already reported exit with output still unread
        // (no backpressure on the process) on the first read after the pause.
        exitedWhileUnread ??= page.providerExited === true && page.exitCode === null;
        for (const chunk of page.chunks) recorded += chunk.text.length;
        cursor = page.command;
        exit = page.exitCode;
      }
      if (cursor.kind !== "modal-router-v1") throw new Error("expected a byte-offset command");
      console.log(
        JSON.stringify({
          reads,
          pageBytes: MODAL_ROUTER_READ_PAGE_BYTES,
          recorded,
          exit,
          exitedWhileUnread,
        }),
      );
      expect(exit).toBe(0);
      expect(cursor.streams.stdout.byteOffset).toBe(BYTES);
      expect(recorded).toBe(BYTES);
      expect(reads).toBeLessThanOrEqual(Math.ceil(BYTES / MODAL_ROUTER_READ_PAGE_BYTES) + 2);
    } finally {
      await control?.close();
      await disposable?.terminate();
      client.close();
    }
  },
  240_000,
);
