import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  resolvePinnedAgentBrowserBinary,
} from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "a wait whose locator matches several elements settles on any visible match",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-wait-any-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `waitany_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: false,
      binary: await resolvePinnedAgentBrowserBinary(
        process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
          ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
          : {},
      ),
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({ browserSessionId, controllerGeneration, runner });
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver,
    });
    // Two always-visible "Delete" buttons, a "Next" button that exists twice
    // but only appears after a delay, and two toasts that leave after a delay.
    const fixture = `data:text/html,${encodeURIComponent(
      `<!doctype html><title>Wait proof</title><button>Delete</button><button>Delete</button><button class="next" hidden>Next</button><button class="next" hidden>Next</button><div class="toast">Saved</div><div class="toast">Saved</div><script>setTimeout(()=>document.querySelectorAll(".next")[1].hidden=false,400);setTimeout(()=>document.querySelectorAll(".toast").forEach((t)=>t.remove()),400);</script>`,
    )}`;
    const command = (
      observation: BrowserObservation,
      action: BrowserActionCommand["action"],
    ): BrowserActionCommand => ({
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId!,
      actor: { kind: "human", subjectId: "wait-any-fixture" },
      observationMode: "none",
      action,
    });
    try {
      const initial = await driver.start(fixture);
      const deleteVisible = await controller.run(
        command(initial, {
          type: "wait",
          condition: "visible",
          locator: { kind: "role", role: "button", name: "Delete" },
          timeoutMs: 5_000,
        }),
      );
      expect(deleteVisible.error ?? null).toBeNull();
      expect(deleteVisible.state).toBe("completed");

      const nextVisible = await controller.run(
        command(initial, {
          type: "wait",
          condition: "visible",
          locator: { kind: "css", selector: ".next" },
          timeoutMs: 5_000,
        }),
      );
      expect(nextVisible.error ?? null).toBeNull();
      expect(nextVisible.state).toBe("completed");

      const toastsHidden = await controller.run(
        command(initial, {
          type: "wait",
          condition: "hidden",
          locator: { kind: "css", selector: ".toast" },
          timeoutMs: 5_000,
        }),
      );
      expect(toastsHidden.error ?? null).toBeNull();
      expect(toastsHidden.state).toBe("completed");

      // "hidden" still waits while any match remains visible.
      const deleteHidden = await controller.run(
        command(initial, {
          type: "wait",
          condition: "hidden",
          locator: { kind: "role", role: "button", name: "Delete" },
          timeoutMs: 600,
        }),
      );
      expect(deleteHidden.error?.code).toBe("timeout");

      // Acting on an ambiguous locator is still refused.
      const click = await controller.run(
        command(initial, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Delete", exact: true },
        }),
      );
      expect(click.error?.code).toBe("locator_ambiguous");
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
