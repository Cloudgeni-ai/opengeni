import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BrowserActionCommand } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, CdpConnection, type BrowserCommandRunner } from "../src";

// Chromium answers Page.navigate before the new document commits, and reports
// the commit in an event that can arrive later still. These tests script
// those orderings, which a real browser produces only under load.

const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xd9,
]).toString("base64");

type Call = { id: number; method: string; sessionId?: string; params?: Record<string, any> };
type Document = { loaderId: string; url: string; button: string };

function navigationFixture() {
  const calls: Call[] = [];
  const pages: Record<string, Document> = {
    a: { loaderId: "loader-a", url: "https://example.test/a", button: "Grant access" },
    b: { loaderId: "loader-b", url: "https://example.test/b", button: "Grant access" },
  };
  let current = pages.a!;
  /** Commits that happen when the frame tree has been read this many times. */
  const scheduled: Array<{ reads: number; page: Document; event: boolean }> = [];
  let frameTreeReads = 0;
  /** Called with each command before it is answered, to script commits. */
  let onCommand: (call: Call) => void = () => {};
  let commitOnNavigate: { page: Document; afterReads: number; event: boolean } | null = null;
  let cancelNavigation = false;
  const socket = new EventTarget() as EventTarget & {
    readyState: number;
    binaryType: string;
    send(raw: string): void;
    close(): void;
  };
  const emit = (data: Record<string, unknown>) =>
    queueMicrotask(() =>
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })),
    );
  const commit = (page: Document, event: boolean) => {
    current = page;
    if (event)
      emit({
        method: "Page.frameNavigated",
        sessionId: "session-1",
        params: { frame: { id: "frame-1", loaderId: page.loaderId, url: page.url } },
      });
  };
  const reply = (command: Call) => {
    let result: unknown = {};
    switch (command.method) {
      case "Browser.getVersion":
        result = { product: "Chrome/151.0.0.0" };
        break;
      case "Target.getTargets":
        result = {
          targetInfos: [
            {
              targetId: "target-1",
              type: "page",
              title: "Fixture",
              url: current.url,
              attached: true,
            },
          ],
        };
        break;
      case "Target.attachToTarget":
        result = { sessionId: "session-1" };
        break;
      case "Page.getFrameTree": {
        frameTreeReads += 1;
        for (const pending of scheduled.splice(0)) {
          if (frameTreeReads >= pending.reads) commit(pending.page, pending.event);
          else scheduled.push(pending);
        }
        result = {
          frameTree: { frame: { id: "frame-1", loaderId: current.loaderId, url: current.url } },
        };
        break;
      }
      case "Page.navigate": {
        const page = Object.values(pages).find((entry) => entry.url === command.params?.url);
        result = { frameId: "frame-1", loaderId: page?.loaderId ?? "loader-unknown" };
        if (commitOnNavigate)
          scheduled.push({
            reads: frameTreeReads + commitOnNavigate.afterReads,
            page: commitOnNavigate.page,
            event: commitOnNavigate.event,
          });
        if (cancelNavigation && page) {
          // The browser gives the navigation up after answering it: its
          // document request (whose id is the loader id) is cancelled.
          setTimeout(
            () =>
              emit({
                method: "Network.loadingFailed",
                sessionId: "session-1",
                params: {
                  requestId: page.loaderId,
                  type: "Document",
                  errorText: "net::ERR_ABORTED",
                  canceled: true,
                },
              }),
            50,
          );
        }
        break;
      }
      case "Runtime.evaluate": {
        const expression = String(command.params?.expression);
        result = expression.startsWith("({width:innerWidth")
          ? {
              result: {
                value: {
                  width: 800,
                  height: 600,
                  visualWidth: 800,
                  visualHeight: 600,
                  deviceScaleFactor: 1,
                  maxTouchPoints: 0,
                },
              },
            }
          : { result: { value: "complete" } };
        break;
      }
      case "Accessibility.getFullAXTree":
        result = {
          nodes: [
            {
              nodeId: `${current.loaderId}-root`,
              ignored: false,
              role: { type: "role", value: "RootWebArea" },
              name: { type: "computedString", value: current.url },
              childIds: [`${current.loaderId}-button`],
              backendDOMNodeId: 1,
              frameId: "frame-1",
            },
            {
              nodeId: `${current.loaderId}-button`,
              parentId: `${current.loaderId}-root`,
              ignored: false,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: current.button },
              childIds: [],
              backendDOMNodeId: current === pages.a ? 10 : 20,
            },
          ],
        };
        break;
      case "Page.getLayoutMetrics":
        result = {
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 3, clientHeight: 2 },
          cssContentSize: { x: 0, y: 0, width: 3, height: 2 },
        };
        break;
      case "Page.captureScreenshot":
        result = { data: jpeg };
        break;
      case "DOM.getBoxModel":
        result = {
          model: {
            content: [10, 10, 50, 10, 50, 30, 10, 30],
            border: [10, 10, 50, 10, 50, 30, 10, 30],
            padding: [10, 10, 50, 10, 50, 30, 10, 30],
            margin: [10, 10, 50, 10, 50, 30, 10, 30],
            width: 40,
            height: 20,
          },
        };
        break;
      case "DOM.getContentQuads":
        result = { quads: [[10, 10, 50, 10, 50, 30, 10, 30]] };
        break;
      case "DOM.resolveNode":
        result = {
          object: { type: "object", objectId: `object-${command.params?.backendNodeId}` },
        };
        break;
      case "Page.createIsolatedWorld":
        result = { executionContextId: 7 };
        break;
      case "Runtime.callFunctionOn": {
        // The element is enabled, already in view (nothing scrolls) and on top.
        const declaration = String(command.params?.functionDeclaration);
        result = {
          result: declaration.includes("visualViewport")
            ? { type: "string", value: "0,0" }
            : { type: "boolean", value: !declaration.includes(":disabled") },
        };
        break;
      }
      case "DOM.describeNode":
        result = {
          node: { nodeId: 0, backendNodeId: command.params?.backendNodeId, nodeName: "BUTTON" },
        };
        break;
    }
    queueMicrotask(() =>
      socket.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ id: command.id, result }) }),
      ),
    );
  };
  socket.readyState = WebSocket.CONNECTING;
  socket.send = (raw) => {
    const command = JSON.parse(raw) as Call;
    calls.push(command);
    onCommand(command);
    reply(command);
  };
  socket.close = () => {
    socket.readyState = WebSocket.CLOSED;
    socket.dispatchEvent(new Event("close"));
  };
  const runner: BrowserCommandRunner = {
    async run<T>(args: readonly string[]): Promise<T> {
      if (args[0] === "get") return { cdpUrl: "ws://127.0.0.1:9222/devtools/fixture" } as T;
      if (args[0] === "close") return {} as T;
      throw new Error(`unexpected command: ${args[0]}`);
    },
  };
  const browserSessionId = randomUUID();
  const controllerGeneration = "controller-navigation";
  const driver = new AgentBrowserDriver({
    browserSessionId,
    controllerGeneration,
    runner,
    navigationCommitTimeoutMs: 300,
    connect: async (endpoint) =>
      await CdpConnection.connect(endpoint, {
        createWebSocket: () => {
          queueMicrotask(() => {
            socket.readyState = WebSocket.OPEN;
            socket.dispatchEvent(new Event("open"));
          });
          return socket as unknown as WebSocket;
        },
      }),
  });
  const command = async (action: BrowserActionCommand["action"]): Promise<BrowserActionCommand> => {
    const observation = await driver.observe("target-1");
    return {
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId: "target-1",
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId!,
      actor: { kind: "agent", subjectId: "navigation-commit-test" },
      action,
    };
  };
  const controller = new BrowserInteractionController({
    browserSessionId,
    controllerGeneration,
    driver,
  });
  return {
    driver,
    controller,
    calls,
    pages,
    command,
    current: () => current,
    /** The next Page.navigate commits its page only after `afterReads` more
     * frame-tree reads, with or without a frameNavigated event. */
    commitNavigationLate(page: Document, afterReads: number, event = true) {
      commitOnNavigate = { page, afterReads, event };
    },
    neverCommitNavigation() {
      commitOnNavigate = null;
    },
    cancelNavigationAfterAnswer() {
      commitOnNavigate = null;
      cancelNavigation = true;
    },
    /** Commit `page` silently (its event still in flight) once `method` is sent. */
    commitSilentlyOn(method: string, page: Document) {
      onCommand = (call) => {
        if (call.method !== method) return;
        onCommand = () => {};
        current = page;
      };
    },
    /** Commit `page` silently so that the `reads`-th next frame-tree read is
     * the first to show it. */
    commitSilentlyAtRead(reads: number, page: Document) {
      scheduled.push({ reads: frameTreeReads + reads, page, event: false });
    },
  };
}

const grantAccess = { kind: "role", role: "button", name: "Grant access" } as const;

const inputCalls = (calls: readonly Call[]) =>
  calls.filter((call) => call.method.startsWith("Input."));

test("navigate completes only after its own document committed, and later actions use that document", async () => {
  const fixture = navigationFixture();
  try {
    await fixture.driver.start();
    const before = await fixture.driver.observe("target-1");
    // Chromium answered Page.navigate, but the old document keeps reporting
    // itself (complete and current) for several more reads.
    fixture.commitNavigationLate(fixture.pages.b!, 20, false);
    const receipt = await fixture.controller.run(
      await fixture.command({
        type: "batch",
        actions: [
          { type: "navigate", url: fixture.pages.b!.url },
          { type: "hover", locator: grantAccess },
        ],
      }),
    );
    expect(receipt.error ?? null).toBeNull();
    expect(receipt.state).toBe("completed");
    expect(receipt.observation?.target.url).toBe(fixture.pages.b!.url);
    expect(receipt.observation?.target.documentGeneration).not.toBe(
      before.target.documentGeneration,
    );
    // The hover found the new page's button (node 20), never the old one.
    const boxes = fixture.calls
      .filter((call) => call.method === "DOM.getBoxModel")
      .map((call) => call.params?.backendNodeId);
    expect(boxes).toContain(20);
    expect(boxes).not.toContain(10);
  } finally {
    await fixture.driver.close();
  }
});

test("a navigation that never commits is stopped and reported on the page it left", async () => {
  const fixture = navigationFixture();
  try {
    await fixture.driver.start();
    fixture.neverCommitNavigation();
    const receipt = await fixture.controller.run(
      await fixture.command({
        type: "batch",
        actions: [
          { type: "navigate", url: fixture.pages.b!.url },
          { type: "hover", locator: grantAccess },
        ],
      }),
    );
    // The request may have reached the server, so the outcome stays unknown,
    // but the receipt says the tab kept its page and shows that page.
    expect(receipt.state).toBe("outcome_unknown");
    expect(receipt.error?.message).toContain("did not commit a new page in time");
    expect(fixture.calls.some((call) => call.method === "Page.stopLoading")).toBe(true);
    expect(receipt.observation?.target.url).toBe(fixture.pages.a!.url);
    expect(inputCalls(fixture.calls)).toEqual([]);
  } finally {
    await fixture.driver.close();
  }
}, 10_000);

test("a navigation the browser cancels after answering fails at once on the page it left", async () => {
  const fixture = navigationFixture();
  try {
    await fixture.driver.start();
    fixture.cancelNavigationAfterAnswer();
    const started = Date.now();
    const receipt = await fixture.controller.run(
      await fixture.command({
        type: "batch",
        actions: [
          { type: "navigate", url: fixture.pages.b!.url },
          { type: "hover", locator: grantAccess },
        ],
      }),
    );
    // Reported as soon as the browser gave the navigation up, not after the
    // commit deadline, and never as a completed navigation.
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(receipt.state).toBe("outcome_unknown");
    expect(receipt.error?.message).toContain(
      "browser navigation was cancelled before its page committed; the tab still shows its previous page",
    );
    expect(receipt.observation?.target.url).toBe(fixture.pages.a!.url);
    expect(inputCalls(fixture.calls)).toEqual([]);
  } finally {
    await fixture.driver.close();
  }
});

test("input is refused when the document changed after the action found its element", async () => {
  const fixture = navigationFixture();
  try {
    await fixture.driver.start();
    // The new page commits once the old page's element was measured; its
    // frameNavigated event has not been processed when input would go out.
    fixture.commitSilentlyOn("DOM.getBoxModel", fixture.pages.b!);
    const receipt = await fixture.controller.run(
      // Pointer input lands on whatever page the tab shows at its coordinates.
      await fixture.command({ type: "hover", locator: grantAccess }),
    );
    expect(receipt.state).toBe("failed");
    expect(receipt.error?.code).toBe("document_stale");
    expect(receipt.error?.message).toContain("no input was sent");
    expect(inputCalls(fixture.calls)).toEqual([]);
  } finally {
    await fixture.driver.close();
  }
});

test("an outline read across an unobserved commit is labeled with the document it describes", async () => {
  const fixture = navigationFixture();
  try {
    await fixture.driver.start();
    const before = await fixture.driver.observe("target-1");
    // The commit lands between the observation's own frame read and the
    // accessibility read that follows it.
    fixture.commitSilentlyAtRead(2, fixture.pages.b!);
    const crossed = await fixture.driver.observe("target-1");
    const settled = await fixture.driver.observe("target-1");
    expect(settled.target.documentGeneration).not.toBe(before.target.documentGeneration);
    expect(crossed.target.documentGeneration).toBe(settled.target.documentGeneration);
    expect(crossed.target.url).toBe(fixture.pages.b!.url);
  } finally {
    await fixture.driver.close();
  }
});

test("a screenshot captured while a new document committed shows and names that document", async () => {
  const fixture = navigationFixture();
  try {
    await fixture.driver.start();
    const before = await fixture.driver.observe("target-1");
    fixture.commitSilentlyOn("Page.captureScreenshot", fixture.pages.b!);
    const frame = await fixture.driver.captureScreenshot("target-1", { format: "jpeg" });
    const after = await fixture.driver.observe("target-1");
    expect(after.target.documentGeneration).not.toBe(before.target.documentGeneration);
    expect(frame.documentGeneration).toBe(after.target.documentGeneration!);
    // The first image may show the old page, so the new page was captured.
    expect(fixture.calls.filter((call) => call.method === "Page.captureScreenshot")).toHaveLength(
      2,
    );
  } finally {
    await fixture.driver.close();
  }
});
