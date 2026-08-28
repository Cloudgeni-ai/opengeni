import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import { resolveSandboxRoute } from "../src/activities/agent-turn/sandbox-establish";

describe("managed sandbox logical image identity", () => {
  test("keeps a verified Modal provider image id out of the durable lease fence", async () => {
    const logicalImage =
      "registry.example.com/opengeni-desktop@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const logicalSandboxSettings = testSettings({
      sandboxBackend: "modal",
      modalImageRef: logicalImage,
      modalImageId: undefined,
    });
    const runSettings: Settings = {
      ...logicalSandboxSettings,
      modalImageId: "im-01M0X53D38C3458D71F48QH2T1",
    };
    const sandboxState: Record<string, unknown> = {};
    const media: Record<string, unknown> = {};

    const route = await resolveSandboxRoute({
      input: {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
      } as never,
      settings: logicalSandboxSettings,
      db: {} as never,
      eventing: { modelRunSettings: runSettings } as never,
      sandboxState: sandboxState as never,
      media: media as never,
      fileAuthoritySubjectId: null,
      runSettings,
      logicalSandboxSettings,
    });

    expect(route.groupBoxBackend).toBe("modal");
    expect(route.groupBoxImage).toBe(logicalImage);
    expect(runSettings.modalImageId).toBe("im-01M0X53D38C3458D71F48QH2T1");
  });
});
