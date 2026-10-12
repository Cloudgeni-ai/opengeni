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
  "a click reaches a row action that only accepts the pointer while its row is hovered",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-hover-reveal-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `hover_${randomUUID().slice(0, 8)}`,
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
    // A table row whose action button is invisible and pointer-transparent
    // until the pointer is over the row, and a button that never accepts it.
    const fixture = `data:text/html,${encodeURIComponent(
      `<!doctype html><title>Hover proof</title><style>.add{opacity:0;pointer-events:none}tr:hover .add{opacity:1;pointer-events:auto}.inert{pointer-events:none}</style><table><tr><td>Wall paint</td><td><button class="add">Add resource</button></td></tr></table><div><button class="inert">Inert</button></div><script>globalThis.clicks=[];document.querySelectorAll("button").forEach((button)=>button.addEventListener("click",()=>clicks.push(button.textContent)));</script>`,
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
      actor: { kind: "human", subjectId: "hover-reveal-fixture" },
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
      // Precondition: before any pointer movement the hit test falls through
      // the hidden button to its cell.
      expect(
        await evaluate(
          '(() => { const r = document.querySelector(".add").getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).tagName; })()',
        ),
      ).toBe("TD");

      const clicked = await controller.run(
        command(initial, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Add resource", exact: true },
        }),
      );
      expect(clicked.error ?? null).toBeNull();
      expect(clicked.state).toBe("completed");
      expect(await evaluate("clicks")).toEqual(["Add resource"]);

      // A control that stays pointer-transparent is still refused. The pointer
      // moved onto it first, so the outcome is reported as unknown.
      const inert = await controller.run(
        command(initial, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Inert", exact: true },
        }),
      );
      expect(inert.state).toBe("outcome_unknown");
      expect(await evaluate("clicks")).toEqual(["Add resource"]);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
