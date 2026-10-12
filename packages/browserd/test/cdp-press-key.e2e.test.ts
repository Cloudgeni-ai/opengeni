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
  "unsupported keys and unfocusable locators are refused before any input",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-press-key-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `press_${randomUUID().slice(0, 8)}`,
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
    const fixture = `data:text/html,${encodeURIComponent(
      '<!doctype html><title>Press proof</title><input aria-label="Text"><button>Card</button><script>globalThis.keys=[];document.addEventListener("keydown",e=>keys.push(e.key));document.querySelector("input").focus();</script>',
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
      actor: { kind: "human", subjectId: "press-key-fixture" },
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
      const activeTag = () => evaluate("document.activeElement?.tagName ?? null");
      expect(await activeTag()).toBe("INPUT");

      const button = { kind: "role", role: "button", name: "Card", exact: true } as const;
      for (const key of ["Shift", "Mod", "Ctrl+F25", "Ctrl+Hyper+A", "NotAKey"]) {
        const refused = await controller.run(
          command(initial, { type: "press", locator: button, key }),
        );
        expect(refused.state).toBe("failed");
        expect(refused.error?.code).toBe("invalid_action");
        // No focus moved and no key reached the page.
        expect(await activeTag()).toBe("INPUT");
        expect(await evaluate("keys.length")).toBe(0);
      }

      const accepted = await controller.run(
        command(initial, { type: "press", locator: button, key: "Escape" }),
      );
      expect(accepted.state).toBe("completed");
      expect(await activeTag()).toBe("BUTTON");
      expect(await evaluate("keys")).toEqual(["Escape"]);

      // Function and navigation keys reach the page with their standard
      // names, including the common short spellings.
      await evaluate(
        'globalThis.codes=[];document.addEventListener("keydown",e=>codes.push([e.key,e.code,e.keyCode,e.ctrlKey]))',
      );
      for (const key of ["F2", "f12", "Home", "End", "PageUp", "pgdn", "Insert", "Ctrl+F5"]) {
        const pressed = await controller.run(
          command(initial, { type: "press", locator: button, key }),
        );
        expect(pressed.state).toBe("completed");
      }
      expect(await evaluate("codes")).toEqual([
        ["F2", "F2", 113, false],
        ["F12", "F12", 123, false],
        ["Home", "Home", 36, false],
        ["End", "End", 35, false],
        ["PageUp", "PageUp", 33, false],
        ["PageDown", "PageDown", 34, false],
        ["Insert", "Insert", 45, false],
        ["F5", "F5", 116, true],
      ]);
      await evaluate("globalThis.keys=['Escape']");

      // The document node is focusable in the accessibility snapshot but is
      // not an Element, so Chromium refuses DOM.focus. That refusal must be a
      // definite invalid_action with no key sent, not an unknown outcome.
      const view = await driver.observe(initial.target.id);
      const queue = view.semantic?.kind === "snapshot" ? [...view.semantic.roots] : [];
      let documentRef: string | undefined;
      while (queue.length && !documentRef) {
        const node = queue.pop()!;
        if (node.role === "document" || node.role === "RootWebArea") documentRef = node.ref;
        if (node.children) queue.push(...node.children);
      }
      expect(documentRef).toBeDefined();
      const refusedFocus = await controller.run(
        command(view, {
          type: "press",
          locator: { kind: "ref", ref: documentRef! },
          key: "Escape",
        }),
      );
      expect(refusedFocus.state).toBe("failed");
      expect(refusedFocus.error?.code).toBe("invalid_action");
      expect(await activeTag()).toBe("BUTTON");
      expect(await evaluate("keys")).toEqual(["Escape"]);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
