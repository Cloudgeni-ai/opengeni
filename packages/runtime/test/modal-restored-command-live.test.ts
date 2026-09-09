import { expect, test } from "bun:test";
import { ModalClient } from "modal";
import { decodeNativeSnapshotRef, type SandboxProviderCommand } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { createSandboxClient } from "../src/sandbox";
import type { ChannelASession } from "../src/sandbox/channel-a";
import { parseExecBannerExitCode, parseExecBannerSessionId } from "../src/sandbox/exec-banner";
import { withProviderCommandHandle } from "../src/sandbox/provider-command-session";

type Session = ChannelASession & {
  delete(): Promise<void>;
  persistWorkspace(options: { requestId: string }): Promise<Uint8Array>;
  hydrateWorkspace(archive: Uint8Array): Promise<void>;
};

// Real provider proof: setup and admitted commands must both survive hydration.
// Isolated resources only; delete every sandbox and captured snapshot afterward.
test.skipIf(process.env.OPENGENI_LIVE_MODAL_SETUP !== "1")(
  "two cold restores preserve workspace and both Modal command paths",
  async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      modalAppName: "opengeni-restored-command-test",
      modalEnvironment: process.env.OPENGENI_MODAL_ENVIRONMENT,
      modalImageRef: process.env.OPENGENI_MODAL_IMAGE_REF ?? "python:3.12-slim",
      modalTokenId: process.env.OPENGENI_MODAL_TOKEN_ID,
      modalTokenSecret: process.env.OPENGENI_MODAL_TOKEN_SECRET,
      modalTimeoutSeconds: 300,
      modalIdleTimeoutSeconds: 180,
      modalWorkspacePersistence: "snapshot_filesystem",
    });
    const client = createSandboxClient(settings) as { create(): Promise<Session> };
    const modal = new ModalClient({
      tokenId: settings.modalTokenId,
      tokenSecret: settings.modalTokenSecret,
      environment: settings.modalEnvironment,
    });
    let session: Session | undefined;
    const snapshots: string[] = [];
    let nextHandle = 100;
    const complete = async (cmd: string, admitted = false): Promise<string> => {
      const current = session!;
      const pages = [
        await withProviderCommandHandle(admitted ? nextHandle++ : undefined, () =>
          current.execCommand!({ cmd, yieldTimeMs: 1, maxOutputTokens: 1000 }),
        ),
      ];
      const handle = parseExecBannerSessionId(pages[0]!);
      expect(handle).not.toBeNull();
      if (admitted) {
        expect(handle).toBeLessThanOrEqual(2147483647);
        let saved = current.getProviderCommand!(handle!)!;
        expect(saved).not.toBeNull();
        current.bindProviderCommand!(handle!, saved, {
          load: async () => saved,
          acknowledge: async (next: SandboxProviderCommand) => (saved = next),
          reserveInput: async () => 1,
        });
        await current.acknowledgeCommandOutput!(pages[0]!);
      } else expect(handle).toBeGreaterThan(2147483647);
      const deadline = Date.now() + 30_000;
      while (parseExecBannerSessionId(pages.at(-1)!) !== null && Date.now() < deadline) {
        const page = await current.writeStdin!({
          sessionId: handle!,
          chars: "",
          yieldTimeMs: 1000,
        });
        pages.push(page);
        if (admitted) await current.acknowledgeCommandOutput!(page);
      }
      expect(parseExecBannerExitCode(pages.at(-1)!)).toBe(0);
      return pages.join("\n");
    };
    try {
      session = await client.create();
      await complete(
        "mkdir -p /workspace; printf preserved-marker > /workspace/restore-proof; sleep 2",
      );
      for (let cycle = 0; cycle < 2; cycle++) {
        const archive = await session.persistWorkspace({ requestId: crypto.randomUUID() });
        snapshots.push(decodeNativeSnapshotRef(archive)!.snapshotId);
        await session.delete();
        session = undefined;
        session = await client.create();
        await session.hydrateWorkspace(archive);
        expect(await complete("sleep 2; cat /workspace/restore-proof")).toContain(
          "preserved-marker",
        );
        expect(await complete("sleep 2; cat /workspace/restore-proof", true)).toContain(
          "preserved-marker",
        );
      }
    } finally {
      try {
        if (session) await session.delete();
      } finally {
        try {
          const cleanup = await Promise.allSettled(snapshots.map((id) => modal.images.delete(id)));
          const errors = cleanup.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (errors.length) throw new AggregateError(errors, "Modal snapshot cleanup failed");
        } finally {
          modal.close();
        }
      }
    }
  },
  180_000,
);
