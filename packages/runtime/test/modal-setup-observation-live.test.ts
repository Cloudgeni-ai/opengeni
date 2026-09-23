import { expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { createSandboxClient } from "../src/sandbox";
import type { ChannelASession } from "../src/sandbox/channel-a";
import { parseExecBannerExitCode, parseExecBannerSessionId } from "../src/sandbox/exec-banner";

// Opt-in: creates one isolated provider sandbox and deletes it in finally.
test.skipIf(process.env.OPENGENI_LIVE_MODAL_SETUP !== "1")(
  "live Modal SDK setup yields and completes without a retained-command admission",
  async () => {
    const client = createSandboxClient(
      testSettings({
        sandboxBackend: "modal",
        modalAppName: "opengeni-setup-observation-test",
        modalImageRef: process.env.OPENGENI_MODAL_IMAGE_REF ?? "python:3.12-slim",
        modalTokenId: process.env.OPENGENI_MODAL_TOKEN_ID,
        modalTokenSecret: process.env.OPENGENI_MODAL_TOKEN_SECRET,
        modalTimeoutSeconds: 300,
        modalIdleTimeoutSeconds: 180,
        modalWorkspacePersistence: "tar",
      }),
    ) as {
      create(): Promise<ChannelASession & { delete(): Promise<void> }>;
    };
    const session = await client.create();
    try {
      const initial = await session.execCommand!({
        cmd: "printf 'setup-start|'; sleep 2; printf 'setup-end'; exit 7",
        yieldTimeMs: 1,
        maxOutputTokens: 1000,
      });
      const handle = parseExecBannerSessionId(initial);
      expect(handle).toBeGreaterThan(2147483647);
      const pages = [initial];
      const deadline = Date.now() + 30_000;
      while (parseExecBannerSessionId(pages[pages.length - 1]!) !== null && Date.now() < deadline) {
        pages.push(
          await session.writeStdin!({
            sessionId: handle!,
            chars: "",
            yieldTimeMs: 1000,
            maxOutputTokens: 1000,
          }),
        );
      }
      expect(parseExecBannerExitCode(pages[pages.length - 1]!)).toBe(7);
      expect(pages.join("\n")).toContain("setup-start|");
      expect(pages.join("\n")).toContain("setup-end");
      expect(session.getProviderCommand!(handle!)).toBeNull();
    } finally {
      await session.delete();
    }
  },
  180_000,
);
