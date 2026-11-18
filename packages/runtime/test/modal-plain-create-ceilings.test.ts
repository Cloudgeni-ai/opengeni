import { describe, expect, spyOn, test } from "bun:test";
import { ModalSandboxClient } from "@openai/agents-extensions/sandbox/modal";
import { Manifest } from "@openai/agents/sandbox";
import { testSettings } from "@opengeni/testing/settings";
import { modalProvider, OpenGeniModalSandboxClient } from "../src/sandbox/providers/modal";
import * as createSession from "../src/sandbox/providers/modal-create-session";

// A cold start with no durable admission callback (viewer, Channel A,
// rematerialization, rig verification) used to call the pinned adapter's
// create: its own Modal client, the reservation only (0.125 cores, 128 MiB),
// no ceilings and no create boundary. Every create now takes Opengeni's
// bounded create with the tier's ceilings.

function clientFor(sandboxResourceClass: "unpaid" | "standard"): OpenGeniModalSandboxClient {
  const settings = testSettings({
    sandboxBackend: "modal",
    modalAppName: "opengeni-test",
    modalTokenId: "test-token-id",
    modalTokenSecret: "test-token-secret",
  });
  return modalProvider.build({
    settings: { ...settings, sandboxResourceClass },
    environment: {},
    exposedPorts: [],
  }) as OpenGeniModalSandboxClient;
}

describe("plain Modal create", () => {
  test("takes the bounded create with the tier's ceilings, never the pinned adapter", async () => {
    const session = { state: {} } as never;
    const bounded = spyOn(createSession, "createModalSessionWithLifecycle").mockResolvedValue(
      session,
    );
    const pinned = spyOn(ModalSandboxClient.prototype, "create");
    try {
      const manifest = new Manifest();
      expect(await clientFor("unpaid").create({ manifest })).toBe(session);
      expect(await clientFor("standard").create({ manifest })).toBe(session);
      expect(pinned).not.toHaveBeenCalled();
      expect(bounded).toHaveBeenCalledTimes(2);
      const [unpaid, standard] = bounded.mock.calls.map((call) => call[0]);
      expect(unpaid).toMatchObject({
        cpu: 0.125,
        cpuLimit: 2,
        memoryMiB: 128,
        memoryLimitMiB: 4096,
      });
      expect(standard).toMatchObject({
        cpu: 0.125,
        cpuLimit: 16,
        memoryMiB: 128,
        memoryLimitMiB: 32768,
      });
      expect(bounded.mock.calls[0]?.[1]).toEqual({ manifest });
    } finally {
      bounded.mockRestore();
      pinned.mockRestore();
    }
  });

  test("refuses the positional manifest-options form instead of dropping it", async () => {
    const pinned = spyOn(ModalSandboxClient.prototype, "create");
    try {
      await expect(
        clientFor("unpaid").create(new Manifest() as never, {} as never),
      ).rejects.toThrow("positional manifest options");
      expect(pinned).not.toHaveBeenCalled();
    } finally {
      pinned.mockRestore();
    }
  });
});
