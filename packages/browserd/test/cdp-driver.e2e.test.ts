import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, AgentBrowserJsonRunner, imageDimensions } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "drives independent Chrome targets through the target-scoped causal controller",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-cdp-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `cdp_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: false,
    });
    const driver = new AgentBrowserDriver({
      browserSessionId,
      controllerGeneration,
      runner,
    });
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let barrierArrivals = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 30,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/barrier") {
          barrierArrivals += 1;
          if (barrierArrivals === 2) releaseBarrier();
          await barrier;
          const title = url.searchParams.get("title") ?? "Parallel";
          return new Response(parallelFixture(title), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const initial = await driver.start(fixture("First"));
      expect(names(initial)).toContain("Static page content");
      expect(initial.target.title).toBe("First");
      const screenshot = await driver.captureScreenshot(initial.target.id);
      expect(screenshot).toMatchObject({
        targetId: initial.target.id,
        documentGeneration: initial.target.documentGeneration,
        mediaType: "image/png",
      });
      expect([...screenshot.data.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const frames = await driver.subscribeFrames(initial.target.id, {
        format: "jpeg",
        maxWidth: 640,
        maxHeight: 480,
      });
      const streamed = await frameWithin(frames[Symbol.asyncIterator](), 5_000);
      expect(streamed).toMatchObject({
        targetId: initial.target.id,
        documentGeneration: initial.target.documentGeneration,
        frameId: initial.frameId,
        sequence: 1,
        mediaType: "image/jpeg",
      });
      expect([...streamed.data.slice(0, 2)]).toEqual([0xff, 0xd8]);
      expect(imageDimensions(streamed.data, "jpeg")).toEqual({
        width: streamed.width,
        height: streamed.height,
      });
      await frames.close();

      const button = requireNode(initial, "button", "Increment 0");
      const clicked = await driver.dispatch(
        command(initial, {
          type: "click",
          locator: { kind: "ref", ref: button.ref },
        }),
      );
      expect(names(clicked)).toContain("Increment 1");
      const pointerClicked = await driver.dispatch(
        command(clicked, {
          type: "pointer",
          action: "click",
          x: 120,
          y: 315,
        }),
      );
      expect(names(pointerClicked)).toContain("Increment 2");

      const logged = await driver.dispatch(
        command(pointerClicked, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Log failure" },
        }),
      );
      expect(logged.diagnostics.consoleErrorCount).toBe(1);
      const debug = await driver.debug(logged.target.id, { kinds: ["console"] });
      expect(debug.entries.at(-1)).toMatchObject({
        kind: "console",
        level: "error",
        message: "Fixture console failure",
      });
      expect(
        (await driver.debug(logged.target.id, { afterSequence: debug.cursor })).entries,
      ).toEqual([]);

      const asking = await driver.dispatch(
        command(logged, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Ask for name" },
        }),
      );
      expect(asking.dialog).toMatchObject({
        type: "prompt",
        message: "Name?",
        defaultPrompt: "Ada",
      });
      const answered = await driver.dispatch(
        command(asking, {
          type: "handle_dialog",
          response: "accept",
          promptText: "Grace",
        }),
      );
      expect(answered.dialog).toBeNull();
      expect(names(answered)).toContain("Dialog Grace");

      const filled = await driver.dispatch(
        command(answered, {
          type: "fill",
          locator: { kind: "label", text: "Message" },
          value: "hello",
        }),
      );
      expect(values(filled)).not.toContain("hello");
      expect(names(filled)).not.toContain("hello");
      const submitted = await driver.dispatch(
        command(filled, {
          type: "press",
          locator: { kind: "placeholder", text: "Say something" },
          key: "Enter",
        }),
      );
      expect(names(submitted)).toContain("Submitted hello");

      const checked = await driver.dispatch(
        command(submitted, {
          type: "check",
          locator: { kind: "role", role: "checkbox", name: "Enable feature" },
          checked: true,
        }),
      );
      expect(statesFor(checked, "checkbox", "Enable feature")).toContain("checked");
      const selected = await driver.dispatch(
        command(checked, {
          type: "select",
          locator: { kind: "label", text: "Priority" },
          values: ["high"],
        }),
      );
      expect(names(selected)).toContain("Selected high");

      const receipts: string[] = [];
      const controller = new BrowserInteractionController({
        browserSessionId,
        controllerGeneration,
        driver,
        onJournalRecord: ({ receipt }) => {
          receipts.push(receipt.state);
        },
      });
      const operation = command(selected, {
        type: "double_click",
        locator: { kind: "role", role: "button", name: "Increment 2" },
      });
      const [firstReceipt, recoveredReceipt] = await Promise.all([
        controller.run(operation),
        controller.run(operation),
      ]);
      expect(firstReceipt.state).toBe("completed");
      expect(recoveredReceipt).toEqual(firstReceipt);
      expect(receipts).toEqual(["prepared", "dispatched", "completed"]);

      const parallelOrigin = `http://127.0.0.1:${server.port}`;
      const firstParallel = await driver.openTarget("about:blank");
      const secondParallel = await driver.openTarget("about:blank");
      const [firstDone, secondDone] = await Promise.all([
        driver.dispatch(
          command(firstParallel, {
            type: "navigate",
            url: `${parallelOrigin}/barrier?title=Parallel%20A`,
          }),
        ),
        driver.dispatch(
          command(secondParallel, {
            type: "navigate",
            url: `${parallelOrigin}/barrier?title=Parallel%20B`,
          }),
        ),
      ]);
      expect(names(firstDone)).toContain("Done Parallel A");
      expect(names(secondDone)).toContain("Done Parallel B");
      expect(barrierArrivals).toBe(2);

      const replacement = await driver.dispatch(
        command(firstDone, { type: "navigate", url: fixture("Replacement") }),
      );
      expect(replacement.target.title).toBe("Replacement");
      const stale = await controller.run(
        command(firstDone, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Launch work" },
        }),
      );
      expect(stale.state).toBe("failed");
      expect(stale.error?.code).toBe("document_stale");

      const targets = await driver.listTargets();
      expect(targets).toHaveLength(3);
    } finally {
      await driver.close().catch(() => undefined);
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

function command(
  observation: BrowserObservation,
  action: BrowserActionCommand["action"],
): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId,
    actor: { kind: "agent", subjectId: "browserd-cdp-e2e" },
    action,
  };
}

function fixture(title: string): string {
  return dataUrl(`<!doctype html>
    <title>${title}</title>
    <style>#pointer-increment { position: fixed; z-index: 10; left: 100px; top: 300px; width: 120px; height: 30px; }</style>
    <main>
      <p>Static page content</p>
      <button id="increment" onclick="this.textContent='Increment ' + ((Number(this.textContent.split(' ')[1]) || 0) + 1)">Increment 0</button>
      <button id="pointer-increment" onclick="increment.click()">Pointer increment</button>
      <button onclick="console.error('Fixture console failure')">Log failure</button>
      <button onclick="dialogOutput.textContent='Dialog ' + prompt('Name?', 'Ada')">Ask for name</button>
      <form onsubmit="event.preventDefault(); output.textContent='Submitted ' + message.value">
        <label>Message <input id="message" placeholder="Say something"></label>
      </form>
      <label>Enable feature <input type="checkbox"></label>
      <label>Priority
        <select onchange="selection.textContent='Selected ' + this.value">
          <option value="low">Low</option><option value="high">High</option>
        </select>
      </label>
      <p id="dialogOutput"></p><p id="output"></p><p id="selection"></p>
    </main>`);
}

function parallelFixture(title: string): string {
  return `<!doctype html><title>${title}</title><p id="done">Done ${title}</p>`;
}

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function requireNode(observation: BrowserObservation, role: string, name: string) {
  const node = nodes(observation).find(
    (candidate) => candidate.role.toLowerCase() === role && candidate.name === name,
  );
  if (!node) throw new Error(`missing ${role} ${name}`);
  return node;
}

function nodes(observation: BrowserObservation): InteractionSemanticNodeValue[] {
  if (observation.semantic?.kind !== "snapshot") return [];
  const roots = observation.semantic.roots;
  const flattened: ReturnType<typeof nodes> = [];
  const visit = (node: InteractionSemanticNodeValue) => {
    flattened.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return flattened;
}

function names(observation: BrowserObservation): string[] {
  return nodes(observation).flatMap((node) => (node.name ? [node.name] : []));
}

function values(observation: BrowserObservation): unknown[] {
  return nodes(observation).flatMap((node) => (node.value === undefined ? [] : [node.value]));
}

function statesFor(observation: BrowserObservation, role: string, name: string): string[] {
  return requireNode(observation, role, name).states;
}

async function frameWithin(
  frames: AsyncIterator<import("../src").BrowserImageFrame>,
  timeoutMs: number,
): Promise<import("../src").BrowserImageFrame> {
  const result = await Promise.race([
    frames.next(),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error("browser frame timed out");
    }),
  ]);
  if (result.done) throw new Error("browser frame stream ended early");
  return result.value;
}
