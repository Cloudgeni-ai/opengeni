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
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "a covered target already in view is a definite refusal; one that needed scrolling stays unknown",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-covered-click-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `covered_${randomUUID().slice(0, 8)}`,
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
    let cdp: CdpConnection | null = null;
    // A fixed, transparent layer covers the whole page at every scroll
    // offset. "Near" is in view; "Far" needs a (smooth) scroll first.
    const fixture = `data:text/html,${encodeURIComponent(
      '<!doctype html><title>Covered proof</title><style>html{scroll-behavior:smooth}</style><button>Near</button><div style="height:3000px"></div><button>Far</button><div id="layer" style="position:fixed;inset:0"></div><script>globalThis.clicks=0;globalThis.scrolls=0;document.addEventListener("click",()=>clicks++);addEventListener("scroll",()=>scrolls++);</script>',
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
      actor: { kind: "human", subjectId: "covered-click-fixture" },
      observationMode: "none",
      action,
    });
    try {
      const initial = await driver.start(fixture);
      const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
      cdp = await CdpConnection.connect(endpoint.cdpUrl);
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: initial.target.id,
        flatten: true,
      });
      const evaluate = async (expression: string) =>
        (
          await cdp!.send<{ result: { value: unknown } }>(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            { sessionId: attached.sessionId },
          )
        ).result.value;

      const near = { kind: "role", role: "button", name: "Near", exact: true } as const;
      const far = { kind: "role", role: "button", name: "Far", exact: true } as const;

      // Nothing scrolls and no pointer input is sent: a definite refusal.
      for (const action of [
        { type: "click", locator: near },
        { type: "hover", locator: near },
      ] as const) {
        const refused = await controller.run(command(initial, action));
        expect(refused.state).toBe("failed");
        expect(refused.error?.code).toBe("invalid_action");
        expect(refused.error?.message).toContain("covered");
      }
      expect(await evaluate("[clicks, scrollY]")).toEqual([0, 0]);

      // Reaching "Far" scrolls the page and runs its scroll listeners, so the
      // refusal after it cannot claim that nothing happened.
      const scrolled = await controller.run(command(initial, { type: "click", locator: far }));
      expect(scrolled.state).toBe("outcome_unknown");
      expect(scrolled.error?.message).toContain("covered");
      expect(await evaluate("clicks")).toBe(0);
      expect(await evaluate("scrollY")).toBeGreaterThan(0);

      // Once nothing covers it, the in-view click lands exactly once.
      await evaluate(
        'document.getElementById("layer").remove(); scrollTo({ top: 0, behavior: "instant" })',
      );
      const view = await driver.observe(initial.target.id);
      const accepted = await controller.run(command(view, { type: "click", locator: near }));
      expect(accepted.state).toBe("completed");
      expect(await evaluate("clicks")).toBe(1);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
