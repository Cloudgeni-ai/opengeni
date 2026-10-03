import { expect, test } from "bun:test";
import { ModalClient } from "modal";
import { OpenGeniModalSandboxClient } from "../src/sandbox/providers/modal";

// Public synthetic fixture only. Opt in explicitly; credentials stay in the
// controller. No workspace source, user data or environment secrets are copied.
test.skipIf(process.env.OPENGENI_LIVE_MODAL_CREATE !== "1")(
  "actual Modal client attributes before manifest setup and releases its dedicated transport",
  async () => {
    const cleanup = new ModalClient();
    const ids: string[] = [];
    const events: string[] = [];
    let transportClosed = false;
    try {
      const client = new OpenGeniModalSandboxClient({
        appName: process.env.OPENGENI_MODAL_SMOKE_APP ?? "opengeni-create-lifecycle-smoke",
        imageTag: "debian:bookworm-slim",
        cpu: 1,
        memoryMiB: 512,
        timeoutMs: 180000,
        sandboxCreateTimeoutS: 60,
      });
      const session = await client.createWithLifecycle(
        {
          manifest: {
            root: "/workspace",
            entries: { "proof.txt": { type: "file", content: "synthetic lifecycle proof" } },
          },
        },
        {
          beforeDispatch: async () => {
            events.push("dispatch");
          },
          onCreated: async (createdSession, intent) => {
            ids.push(createdSession.state.sandboxId!);
            events.push("receipt");
            expect(createdSession.state.imageId).toBe(intent.imageId);
            const apply = createdSession.applyManifest.bind(createdSession);
            createdSession.applyManifest = async (...args) => {
              events.push("manifest");
              return await apply(...args);
            };
            const modal = (createdSession as unknown as { modal: ModalClient }).modal;
            const close = modal.close.bind(modal);
            modal.close = () => {
              transportClosed = true;
              close();
            };
          },
        },
      );
      expect(events).toEqual(["dispatch", "receipt", "manifest"]);
      expect(new TextDecoder().decode(await session.readFile({ path: "proof.txt" }))).toBe(
        "synthetic lifecycle proof",
      );
      expect(transportClosed).toBe(false);
      await session.close();
      expect(transportClosed).toBe(true);
      const stopped = await cleanup.sandboxes.fromId(ids[0]!);
      expect(Number.isInteger(await stopped.poll())).toBe(true);
    } finally {
      try {
        for (const id of ids) {
          const box = await cleanup.sandboxes.fromId(id);
          const code = await box.terminate({ wait: true });
          expect(Number.isInteger(code)).toBe(true);
        }
      } finally {
        cleanup.close();
      }
    }
  },
  120_000,
);
