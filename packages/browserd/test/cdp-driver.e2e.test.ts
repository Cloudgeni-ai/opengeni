import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  BrowserProtectedAuthFillCommand,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  BrowserSupervisor,
  imageDimensions,
  resolvePinnedAgentBrowserBinary,
} from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;
const headedE2e = process.env.OPENGENI_BROWSERD_HEADED_E2E === "1" ? test : test.skip;
const chromiumE2e =
  process.env.OPENGENI_BROWSERD_E2E === "1" || process.env.OPENGENI_BROWSERD_HEADED_E2E === "1"
    ? test
    : test.skip;

e2e(
  "replaces existing editable text and honors select-all on the browser platform",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-replace-text-");
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `replace_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
      binary: await resolvePinnedAgentBrowserBinary(
        process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
          ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
          : {},
      ),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
      runner,
    });
    try {
      let observation = await driver.start(
        dataUrl(`<!doctype html>
        <input aria-label="Input" value="first">
        <textarea aria-label="Textarea">first</textarea>
        <div contenteditable role="textbox" aria-label="Rich text">first</div>
        <output></output>
        <script>
          document.addEventListener('input', event => {
            document.querySelector('output').textContent = 'Received: ' +
              (event.target.value ?? event.target.textContent);
          });
        </script>`),
      );
      for (const name of ["Input", "Textarea", "Rich text"]) {
        const locator = { kind: "role", role: "textbox", name } as const;
        for (const value of ["replacement", "", "Norwegian æøå 🦊"]) {
          observation = await driver.dispatch(
            command(observation, {
              type: "fill",
              locator,
              value,
            }),
          );
          expect(names(observation)).toContain(`Received: ${value}`.trimEnd());
        }
        observation = await driver.dispatch(
          command(observation, {
            type: "press",
            locator,
            key: "Mod+A",
          }),
        );
        observation = await driver.dispatch(
          command(observation, {
            type: "type",
            locator,
            text: "selected replacement",
          }),
        );
        expect(names(observation)).toContain("Received: selected replacement");
      }
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

headedE2e(
  "opens a slow-response tab without applying the blank-document creation deadline to navigation",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-slow-tab-");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        await Bun.sleep(6_200);
        return new Response("<!doctype html><title>Slow tab</title><button>Ready</button>", {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `slow_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: true,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
      binary: await resolvePinnedAgentBrowserBinary(
        process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
          ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
          : {},
      ),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
      runner,
      focusEmulation: true,
    });
    try {
      await driver.start(fixture("First"));
      const opened = await driver.openTarget(String(server.url));
      expect(opened.target.url).toBe(String(server.url));
      expect(names(opened)).toContain("Ready");
      expect(await driver.listTargets()).toHaveLength(2);
    } finally {
      server.stop(true);
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  40_000,
);

headedE2e(
  "streams a mobile headed tab continuously while another tab stays foregrounded",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-hidden-stream-");
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `hidden_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: true,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
      binary: await resolvePinnedAgentBrowserBinary(
        process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
          ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
          : {},
      ),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
      runner,
      focusEmulation: true,
    });
    let cdp: CdpConnection | null = null;
    let frames: import("../src").BrowserFrameSubscription | null = null;
    try {
      const initial = await driver.start(
        dataUrl(
          '<!doctype html><meta name="viewport" content="width=device-width"><title>Hidden form</title><input aria-label="Name">',
        ),
      );
      const mobile = await driver.dispatch(
        command(initial, {
          type: "viewport",
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true,
        }),
      );
      const typed = await driver.dispatch(
        command(mobile, {
          type: "type",
          locator: { kind: "role", role: "textbox", name: "Name" },
          text: "Preserved input",
        }),
      );
      const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
      cdp = await CdpConnection.connect(endpoint.cdpUrl);
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: typed.target.id,
        flatten: true,
      });
      const foreground = await cdp.send<{ targetId: string }>("Target.createTarget", {
        url: fixture("Foreground sentinel"),
        background: false,
      });
      const foregroundAttached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: foreground.targetId,
        flatten: true,
      });
      const foregroundVisibility = async () => {
        const state = await cdp!.send<{ result: { value: string } }>(
          "Runtime.evaluate",
          { expression: "document.visibilityState", returnByValue: true },
          { sessionId: foregroundAttached.sessionId },
        );
        return state.result.value;
      };
      expect(await foregroundVisibility()).toBe("visible");
      frames = await driver.subscribeFrames(typed.target.id, { format: "jpeg" });
      const iterator = frames[Symbol.asyncIterator]();
      let latest = await frameWithin(iterator, 3_000);
      const deadline = Date.now() + 60_000;
      let received = 0;
      while (Date.now() < deadline) {
        latest = await frameAfter(iterator, latest.sequence, 3_000);
        expect(latest).toMatchObject({
          targetId: typed.target.id,
          targetGeneration: typed.target.targetGeneration,
          documentGeneration: typed.target.documentGeneration,
          width: 390,
          height: 844,
        });
        received += 1;
        if (received % 20 === 0) {
          expect(await foregroundVisibility()).toBe("visible");
        }
      }
      expect(received).toBeGreaterThan(50);
      const state = await cdp.send<{ result: { value: { visibility: string; value: string } } }>(
        "Runtime.evaluate",
        {
          expression:
            "({visibility:document.visibilityState,value:document.querySelector('input').value})",
          returnByValue: true,
        },
        { sessionId: attached.sessionId, timeoutMs: 2_000 },
      );
      expect(state.result.value).toEqual({ visibility: "visible", value: "Preserved input" });
      expect(await foregroundVisibility()).toBe("visible");
      expect(await driver.listTargets()).toContainEqual(
        expect.objectContaining({ id: foreground.targetId }),
      );
    } finally {
      await frames?.close();
      cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);

headedE2e.each([false, true])(
  "streams a mobile headed tab continuously while managed input stays in the background (headed=%j)",
  async (headed) => {
    const directory = await mkdtemp("/tmp/ogb-background-input-");
    const socketDirectory = await mkdtemp("/tmp/ogb-bg-sockets-");
    const reference = {
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
    };
    const supervisor = await BrowserSupervisor.open({
      rootDirectory: join(directory, "state"),
      socketRootDirectory: socketDirectory,
    });
    let cdp: CdpConnection | null = null;
    let frames: import("../src").BrowserFrameSubscription | null = null;
    let detachedDriver: AgentBrowserDriver | null = null;
    try {
      const foreground = await supervisor.createSession({
        ...reference,
        headed,
        initialUrl: fixture("Foreground"),
        ...(process.env.OPENGENI_BROWSER_EXECUTABLE
          ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
          : {}),
      });
      const [port, browserPath] = (
        await Bun.file(
          join(
            directory,
            "state",
            "sessions",
            reference.browserSessionId,
            "profile",
            "DevToolsActivePort",
          ),
        ).text()
      )
        .trim()
        .split("\n");
      if (!port || !/^[0-9]{1,5}$/u.test(port) || !browserPath?.startsWith("/devtools/browser/")) {
        throw new Error("owned Chromium did not publish its debugger endpoint");
      }
      cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${browserPath}`);
      // This independent page has no active-state emulation. Its visibility
      // therefore proves that managed actions did not switch the real tab.
      const front = await cdp.send<{ targetId: string }>("Target.createTarget", {
        url: fixture("Foreground sentinel"),
        background: false,
      });
      const frontAttached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: front.targetId,
        flatten: true,
      });
      const background = await supervisor.openTarget(
        reference,
        dataUrl(`<!doctype html>
        <meta name="viewport" content="width=device-width"><title>Background form</title>
        <input aria-label="Name"><button onclick="requestAnimationFrame(() => {
          const output = document.querySelector('output');
          output.textContent = 'Clicked in background ' + (Number(output.dataset.count || 0) + 1);
          output.dataset.count = String(Number(output.dataset.count || 0) + 1);
        })">Update</button><output></output>`),
      );
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: background.target.id,
        flatten: true,
      });
      const frontVisibility = async () => {
        const state = await cdp!.send<{ result: { value: string } }>(
          "Runtime.evaluate",
          {
            expression: "document.visibilityState",
            returnByValue: true,
          },
          { sessionId: frontAttached.sessionId },
        );
        return state.result.value;
      };
      expect(await frontVisibility()).toBe("visible");
      let observed = background;
      const act = async (action: BrowserActionCommand["action"]) => {
        const result = await supervisor.action(command(observed, action));
        expect(result.state).toBe("completed");
        expect(result.observation).not.toBeNull();
        observed = result.observation!;
        expect(await frontVisibility()).toBe("visible");
      };
      await act({ type: "viewport", width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      const locator = { kind: "role", role: "textbox", name: "Name" } as const;
      const inputValue = async () => {
        const result = await cdp!.send<{ result: { value: string } }>(
          "Runtime.evaluate",
          { expression: "document.querySelector('input').value", returnByValue: true },
          { sessionId: attached.sessionId },
        );
        return result.result.value;
      };
      await act({ type: "fill", locator, value: "first" });
      expect(await inputValue()).toBe("first");
      await act({ type: "fill", locator, value: "replacement" });
      expect(await inputValue()).toBe("replacement");
      await act({ type: "press", locator, key: "Mod+A" });
      await act({ type: "type", locator, text: "Background æøå 🦊" });
      await act({ type: "click", locator: { kind: "role", role: "button", name: "Update" } });
      const deadline = Date.now() + 3_000;
      while (!names(observed).includes("Clicked in background 1") && Date.now() < deadline) {
        await Bun.sleep(25);
        observed = await supervisor.observe(reference, background.target.id);
      }
      // No screenshot or preview stream has run before this animation callback.
      expect(names(observed)).toContain("Clicked in background 1");
      const state = await cdp.send<{ result: { value: { visibility: string; value: string } } }>(
        "Runtime.evaluate",
        {
          expression:
            "({visibility:document.visibilityState,value:document.querySelector('input').value})",
          returnByValue: true,
        },
        { sessionId: attached.sessionId },
      );
      expect(state.result.value).toEqual({ visibility: "visible", value: "Background æøå 🦊" });
      expect(await frontVisibility()).toBe("visible");
      // Disconnecting one controller restores its override without closing
      // the shared owned browser or touching another controller's tab.
      detachedDriver = new AgentBrowserDriver({
        browserSessionId: randomUUID(),
        controllerGeneration: `detached-${randomUUID()}`,
        targetLifecycle: "cdp",
        focusEmulation: true,
        runner: {
          async run<T>(args: readonly string[]): Promise<T> {
            if (args[0] === "get" && args[1] === "cdp-url") {
              return { cdpUrl: `ws://127.0.0.1:${port}${browserPath}` } as T;
            }
            throw new Error("unexpected detached-controller runner command");
          },
        },
      });
      const cleanup = await detachedDriver.start(fixture("Detached background"));
      const cleanupAttached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: cleanup.target.id,
        flatten: true,
      });
      const cleanupVisibility = async () => {
        const current = await cdp!.send<{ result: { value: string } }>(
          "Runtime.evaluate",
          { expression: "document.visibilityState", returnByValue: true },
          { sessionId: cleanupAttached.sessionId },
        );
        return current.result.value;
      };
      expect(await cleanupVisibility()).toBe("visible");
      await detachedDriver.close();
      const cleanupDeadline = Date.now() + 3_000;
      while ((await cleanupVisibility()) !== "hidden" && Date.now() < cleanupDeadline) {
        await Bun.sleep(25);
      }
      expect(await cleanupVisibility()).toBe("hidden");
      expect(await frontVisibility()).toBe("visible");
      await cdp.send("Target.closeTarget", { targetId: cleanup.target.id });
      frames = await supervisor.subscribeFrames(reference, background.target.id, {
        format: "jpeg",
      });
      const iterator = frames[Symbol.asyncIterator]();
      const first = await frameWithin(iterator, 3_000);
      const screenshot = await supervisor.screenshot(reference, background.target.id);
      expect([...screenshot.data.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const next = await frameAfter(iterator, first.sequence, 3_000);
      expect([next.width, next.height]).toEqual([390, 844]);
      expect(await frontVisibility()).toBe("visible");
      // Explicit activation remains available for a human choosing direct control.
      const activated = await supervisor.action(command(observed, { type: "activate" }));
      expect(activated.state).toBe("completed");
      expect(await frontVisibility()).toBe("hidden");
      expect(await supervisor.listTargets(reference)).toContainEqual(
        expect.objectContaining({
          id: foreground.observation.target.id,
          targetGeneration: foreground.observation.target.targetGeneration,
        }),
      );
    } finally {
      await detachedDriver?.close();
      await frames?.close();
      cdp?.close();
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
      await rm(socketDirectory, { recursive: true, force: true });
    }
  },
  60_000,
);

headedE2e(
  "keeps a headed managed tab active for frame-scheduled interaction",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-headed-tab-");
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `headed_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: true,
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
      runner,
      focusEmulation: true,
    });
    let cdp: CdpConnection | null = null;
    try {
      const first = await driver.start(fixture("First"));
      const opened = await driver.openTarget(
        dataUrl(`<!doctype html>
        <title>Deferred control</title>
        <button onclick="requestAnimationFrame(() => { this.textContent = 'Deferred 1' })">Deferred 0</button>`),
      );
      const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
      cdp = await CdpConnection.connect(endpoint.cdpUrl);
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: opened.target.id,
        flatten: true,
      });
      const visible = await cdp.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        {
          expression: "document.visibilityState",
          returnByValue: true,
        },
        { sessionId: attached.sessionId },
      );
      expect(visible.result.value).toBe("visible");
      let clicked = await driver.dispatch(
        command(opened, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Deferred 0" },
        }),
      );
      for (let attempt = 0; attempt < 20 && !names(clicked).includes("Deferred 1"); attempt += 1) {
        await Bun.sleep(25);
        clicked = await driver.observe(opened.target.id);
      }
      expect(names(clicked)).toContain("Deferred 1");
      await driver.selectTarget(first.target.id);
      const screenshot = await driver.captureScreenshot(first.target.id);
      expect([...screenshot.data.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const selected = await cdp.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        {
          expression: "document.visibilityState",
          returnByValue: true,
        },
        { sessionId: attached.sessionId },
      );
      expect(selected.result.value).toBe("visible");
    } finally {
      cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

e2e(
  "keeps scaled mobile frames stable during pointer interaction",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-scale-");
    const runner = await AgentBrowserJsonRunner.create({
      namespace: "scale_" + randomUUID().slice(0, 8),
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: process.env.OPENGENI_BROWSERD_HEADED_E2E === "1",
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
    });
    let frames: Awaited<ReturnType<typeof driver.subscribeFrames>> | undefined;
    try {
      let observation = await driver.start(
        dataUrl(`<!doctype html><meta name="viewport" content="width=device-width">
      <body style="margin:0"><div style="width:469px;height:1400px">
      <button style="position:absolute;left:200px;top:400px;width:30px;height:30px" onclick="this.textContent='Hit'">Aim</button></div>`),
      );
      observation = await driver.dispatch(
        command(observation, {
          type: "viewport",
          width: 390,
          height: 844,
          mobile: true,
          deviceScaleFactor: 1,
        }),
      );
      frames = await driver.subscribeFrames(observation.target.id, {
        format: "jpeg",
        maxWidth: 1280,
        maxHeight: 900,
      });
      const iterator = frames[Symbol.asyncIterator]();
      const first = await frameWithin(iterator, 3_000);
      for (let index = 0; index < 20; index += 1) {
        const frame = await frameWithin(iterator, 3_000);
        expect([frame.width, frame.height, frame.deviceScaleFactor]).toEqual([
          first.width,
          first.height,
          first.deviceScaleFactor,
        ]);
        expect(frame.documentGeneration).toBe(first.documentGeneration);
      }
      // The button center in the streamed image converts back through its published
      // scale, exactly as the human browser surface sends viewport pointer actions.
      const pixelX = Math.round(215 * first.deviceScaleFactor);
      const pixelY = Math.round(415 * first.deviceScaleFactor);
      const clicked = await driver.dispatch(
        command(observation, {
          type: "pointer",
          action: "click",
          x: pixelX / first.deviceScaleFactor,
          y: pixelY / first.deviceScaleFactor,
        }),
      );
      expect(names(clicked)).toContain("Hit");
      expect(first.width).toBeLessThanOrEqual(1280);
      expect(first.height).toBeLessThanOrEqual(900);
    } finally {
      await frames?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

e2e(
  "preserves partial batch uncertainty without claiming controller loss or replaying actions",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-partial-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `partial_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: false,
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
    try {
      const initial = await driver.start(
        dataUrl(`<!doctype html><title>Partial batch</title>
        <button onclick="this.textContent = 'Already opened'; document.querySelector('p').textContent = 'Actions 1'">Open menu</button>
        <p>Actions 0</p>`),
      );
      const locator = { kind: "role", role: "button", name: "Open menu", exact: true } as const;
      const operation = command(initial, {
        type: "batch",
        actions: [
          { type: "click", locator },
          { type: "click", locator },
        ],
      });
      const receipt = await controller.run(operation);
      expect(receipt.state).toBe("outcome_unknown");
      expect(receipt.error).toMatchObject({ code: "outcome_unknown", retryable: false });
      expect(receipt.error?.message).toContain("1 action");
      expect(receipt.error?.message).toContain("locator_not_found");
      expect(names(await driver.observe(initial.target.id))).toContain("Actions 1");
      expect(await controller.run(operation)).toEqual(receipt);
      expect(names(await driver.observe(initial.target.id))).toContain("Actions 1");
      const firstActionFailure = await controller.run(command(initial, { type: "click", locator }));
      expect(firstActionFailure.state).toBe("failed");
      expect(firstActionFailure.error?.code).toBe("locator_not_found");
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

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
    const cdpMethods: string[] = [];
    const driver = new AgentBrowserDriver({
      browserSessionId,
      controllerGeneration,
      runner,
      downloadDirectory: join(directory, "downloads"),
      connect: async (endpoint) => {
        const connection = await CdpConnection.connect(endpoint);
        return {
          send: async <T = Record<string, unknown>>(
            method: string,
            params?: Readonly<Record<string, unknown>>,
            options?: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal },
          ): Promise<T> => {
            cdpMethods.push(method);
            return await connection.send<T>(method, params, options);
          },
          on: connection.on.bind(connection),
          waitForEvent: connection.waitForEvent.bind(connection),
          close: connection.close.bind(connection),
        };
      },
    });
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let barrierArrivals = 0;
    let protectedAuthBody = "";
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
        if (url.pathname === "/auth") {
          return new Response(authFixture(), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname === "/logged-in" && request.method === "POST") {
          protectedAuthBody = await request.text();
          return new Response("<!doctype html><title>Logged in</title><p>Authenticated</p>", {
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
      const fullAxBefore = cdpMethods.filter(
        (method) => method === "Accessibility.getFullAXTree",
      ).length;
      const state = await driver.targetState(initial.target.id);
      expect(state).toMatchObject({
        browserSessionId,
        controllerGeneration,
        targetId: initial.target.id,
        targetGeneration: initial.target.targetGeneration,
        documentGeneration: initial.target.documentGeneration,
        frameId: initial.frameId,
      });
      const readFence = {
        expectedTargetGeneration: state.targetGeneration,
        expectedDocumentGeneration: state.documentGeneration!,
        expectedFrameId: state.frameId!,
      };
      expect(
        await driver.readDom(initial.target.id, {
          kind: "count",
          selector: "button",
          ...readFence,
        }),
      ).toMatchObject({ kind: "count", count: 4, truncated: false });
      expect(
        await driver.readDom(initial.target.id, {
          kind: "element",
          locator: { kind: "css", selector: "#message" },
          attributes: ["placeholder", "type"],
          ...readFence,
        }),
      ).toMatchObject({
        kind: "element",
        count: 1,
        value: "",
        redacted: null,
        attributes: { placeholder: "Say something", type: null },
        truncated: false,
      });
      expect(cdpMethods.filter((method) => method === "Accessibility.getFullAXTree")).toHaveLength(
        fullAxBefore,
      );
      expect(
        await driver.readDom(initial.target.id, {
          kind: "element",
          locator: { kind: "css", selector: "#static-copy" },
          maxChars: 6,
          ...readFence,
        }),
      ).toMatchObject({ kind: "element", text: "Static", truncated: true });
      await expect(
        driver.readDom(initial.target.id, {
          kind: "count",
          selector: "button",
          ...readFence,
          expectedDocumentGeneration: "stale-document",
        }),
      ).rejects.toMatchObject({ code: "document_stale" });
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
        mediaType: "image/jpeg",
      });
      expect(streamed.sequence).toBeGreaterThan(0);
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
      const targetWhilePrompting = await driver.target(asking.target.id);
      expect(targetWhilePrompting).toMatchObject({
        id: asking.target.id,
        targetGeneration: asking.target.targetGeneration,
        documentGeneration: asking.target.documentGeneration,
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
      const unconfirmedFill = await controller.run(
        command(selected, {
          type: "fill",
          locator: { kind: "label", text: "Rejecting editor" },
          value: "silently ignored",
        }),
      );
      expect(unconfirmedFill.state).toBe("outcome_unknown");
      expect(unconfirmedFill.error?.code).toBe("outcome_unknown");
      expect(receipts).toEqual(["prepared", "dispatched", "outcome_unknown"]);
      receipts.length = 0;
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
      const authPage = await driver.openTarget(`${parallelOrigin}/auth`);
      const authState = await driver.targetState(authPage.target.id);
      expect(
        await driver.readDom(authPage.target.id, {
          kind: "element",
          locator: { kind: "css", selector: "#password" },
          attributes: ["name", "type"],
          expectedTargetGeneration: authState.targetGeneration,
          expectedDocumentGeneration: authState.documentGeneration!,
          expectedFrameId: authState.frameId!,
        }),
      ).toMatchObject({
        kind: "element",
        count: 1,
        text: null,
        value: null,
        attributes: {},
        redacted: "password",
        truncated: false,
      });
      expect(
        await driver.readDom(authPage.target.id, {
          kind: "element",
          locator: { kind: "css", selector: "#card" },
          attributes: ["name", "type"],
          expectedTargetGeneration: authState.targetGeneration,
          expectedDocumentGeneration: authState.documentGeneration!,
          expectedFrameId: authState.frameId!,
        }),
      ).toMatchObject({
        kind: "element",
        value: null,
        attributes: {},
        redacted: "payment",
      });
      const privateContainer = await driver.readDom(authPage.target.id, {
        kind: "element",
        locator: { kind: "css", selector: "#private-container" },
        expectedTargetGeneration: authState.targetGeneration,
        expectedDocumentGeneration: authState.documentGeneration!,
        expectedFrameId: authState.frameId!,
      });
      expect(privateContainer).toMatchObject({
        text: null,
        value: null,
        attributes: {},
        redacted: "private",
      });
      expect(JSON.stringify(privateContainer)).not.toContain("fixture-private-secret");
      const paymentContainer = await driver.readDom(authPage.target.id, {
        kind: "element",
        locator: { kind: "css", selector: "#payment-container" },
        expectedTargetGeneration: authState.targetGeneration,
        expectedDocumentGeneration: authState.documentGeneration!,
        expectedFrameId: authState.frameId!,
      });
      expect(paymentContainer).toMatchObject({ text: null, redacted: "payment" });
      expect(JSON.stringify(paymentContainer)).not.toContain("fixture-card-text-secret");
      const paymentChild = await driver.readDom(authPage.target.id, {
        kind: "element",
        locator: { kind: "css", selector: "#card-child" },
        expectedTargetGeneration: authState.targetGeneration,
        expectedDocumentGeneration: authState.documentGeneration!,
        expectedFrameId: authState.frameId!,
      });
      expect(paymentChild).toMatchObject({ text: null, redacted: "payment" });
      expect(JSON.stringify(paymentChild)).not.toContain("fixture-card-text-secret");
      const spoofedPage = await driver.openTarget(
        dataUrl(`<!doctype html><title>Spoofed DOM</title>
          <input id="spoofed-password" type="password" value="fixture-spoofed-password">
          <div id="spoofed-container"><span data-private>fixture-spoofed-private</span></div>
          <script>
            document.getElementById('spoofed-password').getAttribute = function(name) {
              return name === 'type' ? 'text' : Element.prototype.getAttribute.call(this, name);
            };
            document.getElementById('spoofed-container').querySelectorAll = () => [];
          </script>`),
      );
      const spoofedState = await driver.targetState(spoofedPage.target.id);
      const spoofedFences = {
        expectedTargetGeneration: spoofedState.targetGeneration,
        expectedDocumentGeneration: spoofedState.documentGeneration!,
        expectedFrameId: spoofedState.frameId!,
      };
      const spoofedPassword = await driver.readDom(spoofedPage.target.id, {
        kind: "element",
        locator: { kind: "css", selector: "#spoofed-password" },
        ...spoofedFences,
      });
      expect(spoofedPassword).toMatchObject({ value: null, redacted: "password" });
      expect(JSON.stringify(spoofedPassword)).not.toContain("fixture-spoofed-password");
      const spoofedContainer = await driver.readDom(spoofedPage.target.id, {
        kind: "element",
        locator: { kind: "css", selector: "#spoofed-container" },
        ...spoofedFences,
      });
      expect(spoofedContainer).toMatchObject({ text: null, redacted: "private" });
      expect(JSON.stringify(spoofedContainer)).not.toContain("fixture-spoofed-private");
      await driver.closeTarget(spoofedPage.target.id);
      await expect(
        driver.readDom(authPage.target.id, {
          kind: "count",
          selector: 'input[type="password"][value^="f"]',
          expectedTargetGeneration: authState.targetGeneration,
          expectedDocumentGeneration: authState.documentGeneration!,
          expectedFrameId: authState.frameId!,
        }),
      ).rejects.toMatchObject({ code: "invalid_action" });
      await expect(
        driver.readDom(authPage.target.id, {
          kind: "element",
          locator: { kind: "css", selector: 'input[type="password"][value^="f"]' },
          expectedTargetGeneration: authState.targetGeneration,
          expectedDocumentGeneration: authState.documentGeneration!,
          expectedFrameId: authState.frameId!,
        }),
      ).rejects.toMatchObject({ code: "invalid_action" });
      const protectedResult = await driver.protectedFill(
        protectedAuthCommand(authPage, parallelOrigin),
      );
      expect(protectedResult.status).toBe("submitted");
      expect(protectedResult.target.url).toBe(`${parallelOrigin}/logged-in`);
      expect(protectedAuthBody).toContain("username=fixture-user");
      expect(protectedAuthBody).toContain("password=fixture-password");
      expect(JSON.stringify(await driver.debug(authPage.target.id))).not.toContain(
        "fixture-password",
      );
      await expect(driver.captureScreenshot(authPage.target.id)).rejects.toMatchObject({
        code: "permission_denied",
      });
      const protectedState = await driver.targetState(authPage.target.id);
      await expect(
        driver.readDom(authPage.target.id, {
          kind: "count",
          selector: "button",
          expectedTargetGeneration: protectedState.targetGeneration,
          expectedDocumentGeneration: protectedState.documentGeneration!,
          expectedFrameId: protectedState.frameId!,
        }),
      ).rejects.toMatchObject({ code: "permission_denied" });

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

      // A BrowserSession has no daemon-global "active tab" media authority.
      // Independent target streams stay live at the same time and continue to
      // describe their own target while both targets mutate concurrently.
      const firstFrames = await driver.subscribeFrames(firstDone.target.id, {
        format: "jpeg",
        maxWidth: 640,
        maxHeight: 480,
      });
      const secondFrames = await driver.subscribeFrames(secondDone.target.id, {
        format: "jpeg",
        maxWidth: 640,
        maxHeight: 480,
      });
      const [firstSeed, secondSeed] = await Promise.all([
        frameWithin(firstFrames[Symbol.asyncIterator](), 5_000),
        frameWithin(secondFrames[Symbol.asyncIterator](), 5_000),
      ]);
      expect(firstSeed.targetId).toBe(firstDone.target.id);
      expect(secondSeed.targetId).toBe(secondDone.target.id);

      const [firstChanged, secondChanged] = await Promise.all([
        driver.dispatch(command(firstDone, { type: "navigate", url: fixture("Stream A") })),
        driver.dispatch(command(secondDone, { type: "navigate", url: fixture("Stream B") })),
      ]);
      const [firstUpdatedFrame, secondUpdatedFrame] = await Promise.all([
        frameAfter(firstFrames[Symbol.asyncIterator](), firstSeed.sequence, 5_000),
        frameAfter(secondFrames[Symbol.asyncIterator](), secondSeed.sequence, 5_000),
      ]);
      expect(firstUpdatedFrame).toMatchObject({
        targetId: firstChanged.target.id,
        documentGeneration: firstChanged.target.documentGeneration,
      });
      expect(secondUpdatedFrame).toMatchObject({
        targetId: secondChanged.target.id,
        documentGeneration: secondChanged.target.documentGeneration,
      });
      await Promise.all([firstFrames.close(), secondFrames.close()]);

      const replacement = await driver.dispatch(
        command(firstChanged, { type: "navigate", url: fixture("Replacement") }),
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
      expect(targets).toHaveLength(4);
    } finally {
      await driver.close().catch(() => undefined);
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

e2e(
  "a popup closing during a click stays uncertain without losing its parent or replaying input",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-popup-close-");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return new Response(
          new URL(request.url).pathname === "/popup"
            ? '<title>Popup</title><button onclick="window.close()">Close popup</button>'
            : '<title>Parent</title><input aria-label="Draft" value="unsaved draft"><button onclick="window.open(&quot;/popup&quot;)">Open popup</button>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `close_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const browserSessionId = randomUUID(),
      controllerGeneration = randomUUID();
    const driver = new AgentBrowserDriver({ browserSessionId, controllerGeneration, runner });
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver,
    });
    try {
      const parent = await driver.start(String(server.url));
      await controller.run(
        command(parent, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Open popup", exact: true },
        }),
      );
      let popup = (await driver.listTargets()).find((target) => target.id !== parent.target.id);
      for (let n = 0; !popup && n < 40; n++) {
        await Bun.sleep(25);
        popup = (await driver.listTargets()).find((target) => target.id !== parent.target.id);
      }
      expect(popup).toBeDefined();
      const observed = await driver.observe(popup!.id);
      const close = command(observed, {
        type: "click",
        locator: { kind: "role", role: "button", name: "Close popup", exact: true },
      });
      const receipt = await controller.run(close);
      expect(receipt.state).toBe("outcome_unknown");
      expect(receipt.error).toMatchObject({ code: "outcome_unknown", retryable: false });
      expect(await controller.run(close)).toEqual(receipt);
      expect((await driver.listTargets()).map((target) => target.id)).toEqual([parent.target.id]);
      const retained = await driver.observe(parent.target.id);
      expect(retained.target.targetGeneration).toBe(parent.target.targetGeneration);
      expect(retained.target.documentGeneration).toBe(parent.target.documentGeneration);
      expect(
        await driver.readDom(parent.target.id, {
          kind: "element",
          locator: { kind: "css", selector: "input" },
          expectedTargetGeneration: parent.target.targetGeneration,
          expectedDocumentGeneration: parent.target.documentGeneration!,
          expectedFrameId: parent.frameId!,
        }),
      ).toMatchObject({ kind: "element", value: "unsaved draft" });
    } finally {
      server.stop(true);
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  40_000,
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
    expectedFrameId: observation.frameId!,
    actor: { kind: "agent", subjectId: "browserd-cdp-e2e" },
    action,
  };
}

function protectedAuthCommand(
  observation: BrowserObservation,
  origin: string,
): BrowserProtectedAuthFillCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration!,
    expectedFrameId: observation.frameId!,
    actor: { kind: "system", subjectId: "protected-auth-e2e" },
    authorityId: "password-authority",
    credentialVersion: 1,
    allowedOrigins: [origin],
    fields: [
      {
        fieldId: "username",
        locator: { kind: "css", selector: "#username" },
        purpose: "identifier",
        value: "fixture-user",
      },
      {
        fieldId: "password",
        locator: { kind: "css", selector: "#password" },
        purpose: "password",
        value: "fixture-password",
      },
    ],
    submit: { type: "click", locator: { kind: "css", selector: "#login" } },
  };
}

function fixture(title: string): string {
  return dataUrl(`<!doctype html>
    <title>${title}</title>
    <style>#pointer-increment { position: fixed; z-index: 10; left: 100px; top: 300px; width: 120px; height: 30px; }</style>
    <main>
      <p id="static-copy">Static page content</p>
      <button id="increment" onclick="this.textContent='Increment ' + ((Number(this.textContent.split(' ')[1]) || 0) + 1)">Increment 0</button>
      <button id="pointer-increment" onclick="increment.click()">Pointer increment</button>
      <button onclick="console.error('Fixture console failure')">Log failure</button>
      <button onclick="dialogOutput.textContent='Dialog ' + prompt('Name?', 'Ada')">Ask for name</button>
      <form onsubmit="event.preventDefault(); output.textContent='Submitted ' + message.value">
        <label>Message <input id="message" placeholder="Say something"></label>
      </form>
      <label>Rejecting editor <input oninput="this.value=''" /></label>
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

function authFixture(): string {
  return `<!doctype html>
    <title>Auth</title>
    <form method="post" action="/logged-in">
      <label>Username <input id="username" name="username" autocomplete="username"></label>
      <label>Password <input id="password" name="password" type="password" autocomplete="current-password" oninput="console.error('credential:' + this.value)"></label>
      <button id="login" type="submit">Sign in</button>
    </form>
    <input id="card" name="card-number" autocomplete="cc-number" value="fixture-card-secret">
    <section id="private-container">Public intro <span data-private>fixture-private-secret</span></section>
    <section id="payment-container">Public intro <span id="card-number"><span id="card-child">fixture-card-text-secret</span></span></section>`;
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

async function frameAfter(
  frames: AsyncIterator<import("../src").BrowserImageFrame>,
  sequence: number,
  timeoutMs: number,
): Promise<import("../src").BrowserImageFrame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await frameWithin(frames, deadline - Date.now());
    if (frame.sequence > sequence) return frame;
  }
  throw new Error("browser frame did not advance");
}

headedE2e(
  "reads real native select options without rewriting the page and preserves selection events",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-select-");
    const runner = await AgentBrowserJsonRunner.create({
      namespace: "sel_" + randomUUID().slice(0, 8),
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: true,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
      binary: await resolvePinnedAgentBrowserBinary(
        process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
          ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
          : {},
      ),
    });
    let detachOnResolve = false;
    let accessibilityReads = 0;
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
      focusEmulation: true,
      connect: async (endpoint) => {
        const connection = await CdpConnection.connect(endpoint);
        return {
          send: async <T = Record<string, unknown>>(
            method: string,
            params?: Readonly<Record<string, unknown>>,
            options?: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal },
          ): Promise<T> => {
            if (method.startsWith("Accessibility.get")) accessibilityReads++;
            if (detachOnResolve && method === "DOM.resolveNode" && params?.executionContextId) {
              detachOnResolve = false;
              await connection.send(
                "Runtime.evaluate",
                { expression: "document.querySelector('select').remove()" },
                options,
              );
              await connection.send("HeapProfiler.collectGarbage", {}, options);
            }
            return await connection.send<T>(method, params, options);
          },
          on: connection.on.bind(connection),
          waitForEvent: connection.waitForEvent.bind(connection),
          close: connection.close.bind(connection),
        };
      },
    });
    const focused = (view: BrowserObservation): InteractionSemanticNodeValue | undefined => {
      const queue = view.semantic?.kind === "snapshot" ? [...view.semantic.roots] : [];
      while (queue.length) {
        const node = queue.pop()!;
        if (node.ref === view.focusedRef) return node;
        if (node.children) queue.push(...node.children);
      }
    };
    try {
      let view = await driver.start(
        dataUrl(
          '<style>select{position:absolute;left:10px;top:40px;width:200px;height:40px}button{position:absolute;left:10px;top:150px;width:200px;height:40px}</style><button onclick="this.textContent=\'Counter 1\'">Counter 0</button><label>Priority<select id="priority" oninput="document.querySelector(\'p\').textContent += \' input:\' + this.value" onchange="document.querySelector(\'p\').textContent += \' change:\' + this.value"><option value="low">Low</option><optgroup label="More"><option value="high">High</option><option value="blocked" disabled>Blocked</option></optgroup></select></label><p>Events</p>',
        ),
      );
      expect(driver.focusedInputObservations).toBe(true);
      view = (await driver.dispatch({
        ...command(view, { type: "pointer", action: "click", x: 110, y: 60 }),
        observationMode: "input",
      }))!;
      expect(view).not.toBeNull();
      expect(focused(view)?.native?.data).toEqual({
        kind: "native-select",
        multiple: false,
        disabled: false,
        options: [
          { value: "low", label: "Low", selected: true, disabled: false },
          { value: "high", label: "High", selected: false, disabled: false },
          { value: "blocked", label: "Blocked", selected: false, disabled: true },
        ],
      });
      // Keyboard users can open the same popup and explicitly read its focused
      // options even on controllers whose input observation mode is click-only.
      await driver.dispatch({
        ...command(view, { type: "press", key: "Escape" }),
        observationMode: "none",
      });
      await driver.dispatch({
        ...command(view, { type: "press", key: "Alt+ArrowDown" }),
        observationMode: "none",
      });
      view = await driver.observe(view.target.id);
      expect(focused(view)?.native?.data).toMatchObject({ kind: "native-select", multiple: false });
      const ref = view.focusedRef!;
      await expect(
        driver.dispatch(
          command(view, {
            type: "select",
            locator: { kind: "ref", ref },
            values: ["blocked"],
          }),
        ),
      ).rejects.toThrow("not a selectable control");
      view = await driver.dispatch(
        command(view, { type: "select", locator: { kind: "ref", ref }, values: ["high"] }),
      );
      expect(names(view)).toContain("Events input:high change:high");
      const readsBeforeOrdinaryClick = accessibilityReads;
      expect(
        await driver.dispatch({
          ...command(view, { type: "pointer", action: "click", x: 110, y: 170 }),
          observationMode: "input",
        }),
      ).toBeNull();
      expect(accessibilityReads).toBe(readsBeforeOrdinaryClick);
      view = await driver.observe(view.target.id);
      expect(names(view)).toContain("Counter 1");
      expect(
        (
          await driver.readDom(view.target.id, {
            kind: "count",
            selector: "select",
            expectedTargetGeneration: view.target.targetGeneration,
            expectedDocumentGeneration: view.target.documentGeneration!,
            expectedFrameId: view.frameId!,
          })
        ).count,
      ).toBe(1);
      view = await driver.dispatch(
        command(view, { type: "pointer", action: "click", x: 110, y: 60 }),
      );
      detachOnResolve = true;
      view = await driver.observe(view.target.id);
      expect(detachOnResolve).toBe(false);
      expect(focused(view)?.native).toBeUndefined();
      expect((await driver.captureScreenshot(view.target.id)).data.byteLength).toBeGreaterThan(100);
      expect(names(await driver.observe(view.target.id))).toContain("Counter 1");
      view = await driver.dispatch(
        command(view, {
          type: "navigate",
          url: dataUrl(
            "<div data-private><label>Private<select><option>Private option</option></select></label></div>",
          ),
        }),
      );
      view = await driver.dispatch(
        command(view, { type: "click", locator: { kind: "label", text: "Private" } }),
      );
      expect(focused(view)?.native).toBeUndefined();
      view = await driver.dispatch(
        command(view, {
          type: "navigate",
          url: dataUrl(
            "<label>Many<select>" +
              Array.from({ length: 201 }, (_, i) => "<option>" + i + "</option>").join("") +
              "</select></label>",
          ),
        }),
      );
      view = await driver.dispatch(
        command(view, { type: "click", locator: { kind: "label", text: "Many" } }),
      );
      expect(focused(view)?.native).toBeUndefined();
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);

for (const mode of [
  "scroll",
  "small semantic target",
  "small coordinate target",
  "removed target",
] as const) {
  chromiumE2e(
    `completes native drag lifecycle with ${mode}`,
    async () => {
      const directory = await mkdtemp("/tmp/ogb-drag-");
      const runner = await AgentBrowserJsonRunner.create({
        namespace: `drag_${randomUUID().slice(0, 8)}`,
        sessionName: "s",
        socketDirectory: join(directory, "s"),
        profileDirectory: join(directory, "profile"),
        downloadDirectory: join(directory, "downloads"),
        screenshotDirectory: join(directory, "screenshots"),
        headed: process.env.OPENGENI_BROWSERD_HEADED_E2E === "1",
        ...(process.env.OPENGENI_BROWSER_EXECUTABLE
          ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
          : {}),
        binary: await resolvePinnedAgentBrowserBinary(
          process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
            ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
            : {},
        ),
      });
      const driver = new AgentBrowserDriver({
        browserSessionId: randomUUID(),
        controllerGeneration: randomUUID(),
        runner,
        focusEmulation: true,
      });
      let cdp: CdpConnection | null = null;
      try {
        const initial = await driver.start(
          dataUrl(`<!doctype html>
          <style>
            body{margin:0} button{position:absolute;left:100px;width:100px;padding:0;border:0}
            #source{top:100px;height:40px} #destination{top:${mode === "scroll" ? 1400 : 600}px;height:10px}
          </style>
          <button id="source" draggable="true">Source</button>
          <button id="destination">Destination</button>
          <script>
            globalThis.events=[];globalThis.moved=false;
            source.addEventListener('dragstart',e=>{
              events.push('start');e.dataTransfer.setData('text/plain','source');
              ${mode === "removed target" ? "destination.remove();" : ""}
            });
            source.addEventListener('dragend',()=>events.push('end'));
            destination.addEventListener('dragover',e=>e.preventDefault());
            destination.addEventListener('drop',e=>{
              e.preventDefault();events.push('drop');globalThis.moved=true;
            });
          </script>`),
        );
        const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
        cdp = await CdpConnection.connect(endpoint.cdpUrl);
        const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
          targetId: initial.target.id,
          flatten: true,
        });
        const options = { sessionId: attached.sessionId };
        await cdp.send(
          "Emulation.setDeviceMetricsOverride",
          {
            width: 800,
            height: 720,
            deviceScaleFactor: 1,
            mobile: false,
          },
          options,
        );
        const page = await driver.observe(initial.target.id);
        const action = command(
          page,
          mode === "small coordinate target"
            ? {
                type: "pointer",
                action: "drag",
                x: 150,
                y: 120,
                endX: 150,
                endY: 605,
              }
            : {
                type: "drag",
                from: { kind: "role", role: "button", name: "Source", exact: true },
                to: { kind: "role", role: "button", name: "Destination", exact: true },
              },
        );
        if (mode === "removed target") {
          await expect(driver.dispatch(action)).rejects.toThrow();
        } else {
          await driver.dispatch(action);
        }
        const result = await cdp.send<{ result: { value: unknown } }>(
          "Runtime.evaluate",
          {
            expression: "({events,moved,scrolled:scrollY>0})",
            returnByValue: true,
          },
          options,
        );
        expect(result.result.value).toEqual({
          events: mode === "removed target" ? ["start", "end"] : ["start", "drop", "end"],
          moved: mode !== "removed target",
          scrolled: mode === "scroll",
        });
      } finally {
        cdp?.close();
        await driver.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
}
