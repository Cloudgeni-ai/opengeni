import { describe, expect, test } from "bun:test";
import {
  BrowserInteractionController,
  InteractionControllerError,
  InteractionDefiniteDriverError,
  InteractionOutcomeUnknownDriverError,
} from "@opengeni/interaction";
import { AttachedBrowserBridgeError } from "../src/attached-bridge";
import {
  CdpCommandTimeoutError,
  CdpProtocolError,
  CdpSessionDetachedError,
  CdpTransportError,
} from "../src/cdp";
import {
  AttachedChromeCdpConnection,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";

class FakeBridge implements AttachedBrowserBridgeTransport {
  readonly commands: Array<Record<string, unknown>> = [];
  closed = false;
  pollCount = 0;
  eventSent = false;

  async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    this.commands.push({ ...payload });
    switch (payload.type) {
      case "tabs.list":
        return {
          tabs: [
            {
              id: "7",
              title: "Opengeni",
              url: "https://opengeni.ai/",
              active: true,
              controllable: true,
            },
          ],
        } as T;
      case "debugger.attach":
        return { attached: true } as T;
      case "debugger.detach":
        return { detached: true } as T;
      case "debugger.command":
        return { result: { frameTree: { frame: { id: "main" } } } } as T;
      case "debugger.poll": {
        this.pollCount += 1;
        if (this.pollCount === 1) return { events: [], cursor: 5, truncated: false } as T;
        if (!this.commands.some((command) => command.type === "debugger.attach"))
          return { events: [], cursor: 5, truncated: false } as T;
        if (!this.eventSent) {
          this.eventSent = true;
          return {
            events: [
              {
                sequence: 6,
                tabId: "7",
                sessionId: null,
                method: "Page.frameNavigated",
                params: { frame: { id: "main" } },
              },
            ],
            cursor: 6,
            truncated: false,
          } as T;
        }
        return { events: [], cursor: 6, truncated: false } as T;
      }
      default:
        return {} as T;
    }
  }

  close(): void {
    this.closed = true;
  }
}

describe("AttachedChromeCdpConnection", () => {
  test("a tab close whose profile connection ended is an unknown outcome, not a failure", async () => {
    const closing = (failure: Error) =>
      new AttachedChromeCdpConnection(
        {
          async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
            if (payload.type === "tabs.close") throw failure;
            return {} as T;
          },
          close() {},
        },
        { browserName: "Chrome", browserVersion: "151.0.0.0" },
      );
    for (const failure of [
      // The profile's connection ended with the command pending (Chrome
      // closed the profile, or the extension stopped).
      new AttachedBrowserBridgeError("resource_unavailable", "attached browser unavailable", true),
      new AttachedBrowserBridgeError("transport_failed", "attached browser bridge closed", true),
      new AttachedBrowserBridgeError("timeout", "attached browser command timed out", true),
    ]) {
      const connection = closing(failure);
      const error = await connection
        .send("Target.closeTarget", { targetId: "7" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InteractionOutcomeUnknownDriverError);
      expect(error).toMatchObject({ code: "outcome_unknown", retryable: false });
      connection.close();
    }
    // Chrome says the tab is already gone.
    const gone = closing(
      new AttachedBrowserBridgeError("driver_rejected", "No tab with id: 7.", false),
    );
    const error = await gone
      .send("Target.closeTarget", { targetId: "7" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InteractionDefiniteDriverError);
    expect(error).toMatchObject({ code: "target_not_found" });
    gone.close();
  });

  test("reports Chrome refusing to debug a tab as a definite failure that says what to do", async () => {
    const refusing = (failure: Error) => {
      const bridge = new FakeBridge();
      const request = bridge.request.bind(bridge);
      bridge.request = async <T = unknown>(payload: Readonly<Record<string, unknown>>) => {
        if (payload.type === "debugger.attach") {
          bridge.commands.push({ ...payload });
          throw failure;
        }
        return await request<T>(payload);
      };
      return {
        bridge,
        connection: new AttachedChromeCdpConnection(bridge, {
          browserName: "Chrome",
          browserVersion: "151.0.0.0",
        }),
      };
    };
    const attach = async (failure: Error) => {
      const { bridge, connection } = refusing(failure);
      try {
        const error = await connection
          .send("Target.attachToTarget", { targetId: "7" })
          .catch((caught: unknown) => caught);
        expect(bridge.commands.map((command) => command.type)).toContain("debugger.attach");
        return error as Error & { code?: unknown; retryable?: unknown };
      } finally {
        connection.close();
      }
    };

    // An older extension relays Chrome's refusal while a password manager's
    // inline menu frame is in the page unchanged.
    const frame = await attach(
      new AttachedBrowserBridgeError(
        "driver_rejected",
        "Cannot access a chrome-extension:// URL of different extension",
        false,
        { extensionCode: "driver_failed" },
      ),
    );
    expect(frame).toBeInstanceOf(InteractionControllerError);
    expect(frame).toMatchObject({ code: "resource_unavailable", retryable: false });
    expect(frame.message).toBe(
      "Another browser extension has added its own frame to this page (password managers do this for their inline menu), and Chrome does not let the Opengeni Browser extension control a tab while it has one. Update the Opengeni Browser extension, turn off that extension's inline menu for this site, or use a managed browser",
    );

    // A newer extension explains its refusal itself; keep its words.
    const explained = await attach(
      new AttachedBrowserBridgeError(
        "driver_rejected",
        "A password manager keeps adding its own frame to this page; turn off its inline menu",
        false,
        { extensionCode: "tab_unavailable" },
      ),
    );
    expect(explained).toBeInstanceOf(InteractionControllerError);
    expect(explained).toMatchObject({ code: "resource_unavailable", retryable: false });
    expect(explained.message).toBe(
      "A password manager keeps adding its own frame to this page; turn off its inline menu",
    );

    // Any other refusal names Chrome's reason, bounded.
    const otherReason = "Cannot access a chrome:// URL";
    const other = await attach(
      new AttachedBrowserBridgeError("driver_rejected", otherReason, false, {
        extensionCode: "driver_failed",
      }),
    );
    expect(other).toBeInstanceOf(InteractionControllerError);
    expect(other).toMatchObject({ code: "resource_unavailable", retryable: false });
    expect(other.message).toBe(
      "Chrome would not let the Opengeni Browser extension control this tab (Cannot access a chrome:// URL); retrying will not help until that changes. Use another tab or a managed browser",
    );
    const long = await attach(
      new AttachedBrowserBridgeError("driver_rejected", "界".repeat(400), false),
    );
    expect(Buffer.byteLength(long.message)).toBeLessThanOrEqual(
      Buffer.byteLength(other.message) - Buffer.byteLength(otherReason) + 300,
    );
    expect(long.message).toContain("界…); retrying will not help");

    // Another debugger (DevTools, or a racing attach) can let go: retry.
    const debugged = await attach(
      new AttachedBrowserBridgeError(
        "driver_rejected",
        "Another debugger is already attached to the tab with id: 7.",
        false,
        { extensionCode: "driver_failed" },
      ),
    );
    expect(debugged).toBeInstanceOf(InteractionControllerError);
    expect(debugged).toMatchObject({ code: "operation_conflict", retryable: true });
    expect(debugged.message).toBe(
      "Another debugger is attached to this tab, so the Opengeni Browser extension cannot control it right now. Try again in a moment; if it keeps happening, close DevTools for this tab or use another tab",
    );

    // A tab that is gone is not found, not a refusal, in both chrome.tabs'
    // and chrome.debugger's wording.
    for (const wording of ["No tab with id: 7.", "No tab with given id 7."]) {
      const gone = await attach(new AttachedBrowserBridgeError("driver_rejected", wording, false));
      expect(gone).toBeInstanceOf(InteractionDefiniteDriverError);
      expect(gone).toMatchObject({ code: "target_not_found" });
    }

    // A lost connection or timeout stays a transport failure worth retrying.
    const lost = await attach(
      new AttachedBrowserBridgeError("transport_failed", "attached browser bridge closed", true),
    );
    expect(lost).toBeInstanceOf(CdpTransportError);
  });

  test("an observation of a tab Chrome will not debug fails with the refusal, not a retry", async () => {
    const { AgentBrowserDriver } = await import("../src/cdp-driver");
    const bridge = new FakeBridge();
    const request = bridge.request.bind(bridge);
    bridge.request = async <T = unknown>(payload: Readonly<Record<string, unknown>>) => {
      if (payload.type === "debugger.attach")
        throw new AttachedBrowserBridgeError(
          "driver_rejected",
          "Cannot access a chrome-extension:// URL of different extension",
          false,
          { extensionCode: "driver_failed" },
        );
      return await request<T>(payload);
    };
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: crypto.randomUUID(),
      controllerGeneration: "attach-refusal-test",
      targetLifecycle: "cdp",
      runner: {
        async run<T>(args: readonly string[]): Promise<T> {
          if (args[0] === "get") return { cdpUrl: "opengeni-attached://local" } as T;
          return {} as T;
        },
      },
      connect: async () => connection,
    });
    try {
      const failure = await driver.observe("7").catch((error: unknown) => error);
      // Before, this was a CDP protocol error that the controller answered as
      // a retryable "browser observation unavailable".
      expect(failure).not.toBeInstanceOf(CdpProtocolError);
      expect(failure).toBeInstanceOf(InteractionControllerError);
      expect(failure).toMatchObject({ code: "resource_unavailable", retryable: false });
      expect((failure as Error).message).toContain("password managers do this");
    } finally {
      await driver.close().catch(() => undefined);
      connection.close();
    }
  });

  test("every read and action on a tab Chrome will not debug fails with the refusal, never an unclassified error", async () => {
    const { AgentBrowserDriver } = await import("../src/cdp-driver");
    const bridge = new FakeBridge();
    const request = bridge.request.bind(bridge);
    let refusal = "Cannot access a chrome-extension:// URL of different extension";
    bridge.request = async <T = unknown>(payload: Readonly<Record<string, unknown>>) => {
      if (payload.type === "debugger.attach")
        throw new AttachedBrowserBridgeError("driver_rejected", refusal, false, {
          extensionCode: "driver_failed",
        });
      return await request<T>(payload);
    };
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    const browserSessionId = crypto.randomUUID();
    const controllerGeneration = "attach-refusal-actions-test";
    const driver = new AgentBrowserDriver({
      browserSessionId,
      controllerGeneration,
      targetLifecycle: "cdp",
      runner: {
        async run<T>(args: readonly string[]): Promise<T> {
          if (args[0] === "get") return { cdpUrl: "opengeni-attached://local" } as T;
          return {} as T;
        },
      },
      connect: async () => connection,
    });
    const refused = (failure: unknown) => {
      // Before, each of these was a CDP protocol error: the controller
      // answered screenshots and tab state (activate and the action fence)
      // with an unclassified 500.
      expect(failure).not.toBeInstanceOf(CdpProtocolError);
      expect(failure).toBeInstanceOf(InteractionControllerError);
      expect(failure).toMatchObject({ code: "resource_unavailable", retryable: false });
      expect((failure as Error).message).toContain("password managers do this");
    };
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver,
    });
    try {
      refused(await driver.targetState("7").catch((error: unknown) => error));
      refused(await driver.captureScreenshot("7").catch((error: unknown) => error));
      for (const action of [
        { type: "pointer", action: "click", x: 10, y: 10 },
        {
          type: "fill",
          locator: { kind: "css", selector: "input[type=password]" },
          value: "hello",
        },
        { type: "type", locator: { kind: "css", selector: "input" }, text: "hello" },
        { type: "press", key: "Enter" },
      ] as const) {
        const command = {
          protocolVersion: 1,
          actor: { kind: "agent", subjectId: "agent:test" },
          operationId: crypto.randomUUID(),
          browserSessionId,
          controllerGeneration,
          targetId: "7",
          expectedTargetGeneration: "1",
          expectedDocumentGeneration: "1",
          expectedFrameId: "main",
          observationMode: "none",
          action,
        } as const;
        const receipt = await controller.run(command);
        // No input reached the page, so the action definitely did not run;
        // before, the controller answered with an unclassified failure.
        expect(receipt.state).toBe("failed");
        expect(receipt.error).toMatchObject({ code: "resource_unavailable", retryable: false });
        expect(receipt.error?.message).toContain("password managers do this");
        // Refused only at dispatch (the tab was detached since the
        // controller's check), it is still a definite failure, not an
        // unknown outcome.
        const dispatched = await driver
          .dispatch({ ...command, operationId: crypto.randomUUID() })
          .catch((error: unknown) => error);
        expect(dispatched).toBeInstanceOf(InteractionDefiniteDriverError);
        expect(dispatched).toMatchObject({ code: "resource_unavailable", retryable: false });
        expect((dispatched as Error).message).toContain("password managers do this");
      }
      // Another debugger holding the tab is a definite refusal worth retrying.
      refusal = "Another debugger is already attached to the tab with id: 7.";
      const busy = await driver
        .dispatch({
          protocolVersion: 1,
          actor: { kind: "agent", subjectId: "agent:test" },
          operationId: crypto.randomUUID(),
          browserSessionId,
          controllerGeneration,
          targetId: "7",
          expectedTargetGeneration: "1",
          expectedDocumentGeneration: "1",
          expectedFrameId: "main",
          observationMode: "none",
          action: { type: "press", key: "Enter" },
        })
        .catch((error: unknown) => error);
      expect(busy).toBeInstanceOf(InteractionDefiniteDriverError);
      expect(busy).toMatchObject({ code: "operation_conflict", retryable: true });
      // Nothing reached the page.
      expect(bridge.commands.some((command) => String(command.method).startsWith("Input."))).toBe(
        false,
      );
    } finally {
      await driver.close().catch(() => undefined);
      connection.close();
    }
  });

  test("reports a tab's download browser-wide with the file Chrome saved", async () => {
    const commands: Array<Record<string, unknown>> = [];
    let polls = 0;
    let finds = 0;
    const bridge: AttachedBrowserBridgeTransport = {
      async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
        commands.push({ ...payload });
        if (payload.type === "downloads.find") {
          finds += 1;
          // Chrome lists the download as complete a moment after reporting it,
          // beside an earlier file of the same address and another size.
          return {
            downloads:
              finds === 1
                ? []
                : [
                    { id: 3, filePath: "/Users/user/Downloads/report.pdf", sizeBytes: 9 },
                    { id: 4, filePath: "/Users/user/Downloads/report (1).pdf", sizeBytes: 5 },
                  ],
          } as T;
        }
        if (payload.type !== "debugger.poll") return {} as T;
        polls += 1;
        if (polls === 1) return { events: [], cursor: 0, truncated: false } as T;
        if (polls === 2) {
          const event = (sequence: number, method: string, params: Record<string, unknown>) => ({
            sequence,
            tabId: "7",
            sessionId: null,
            method,
            params,
          });
          return {
            events: [
              event(1, "Page.downloadWillBegin", {
                frameId: "main",
                guid: "guid-1",
                url: "https://example.test/report",
                suggestedFilename: "report.pdf",
              }),
              event(2, "Page.downloadProgress", {
                guid: "guid-1",
                totalBytes: 5,
                receivedBytes: 5,
                state: "inProgress",
              }),
              event(3, "Page.downloadProgress", {
                guid: "guid-1",
                totalBytes: 5,
                receivedBytes: 5,
                state: "completed",
              }),
              // A repeated completion cannot settle it twice.
              event(4, "Page.downloadProgress", {
                guid: "guid-1",
                totalBytes: 5,
                receivedBytes: 5,
                state: "completed",
              }),
            ],
            cursor: 4,
            truncated: false,
          } as T;
        }
        return { events: [], cursor: 4, truncated: false } as T;
      },
      close() {},
    };
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    const began: Array<Record<string, unknown>> = [];
    const progress: Array<Record<string, unknown>> = [];
    connection.on("Browser.downloadWillBegin", (event) => began.push(event.params));
    connection.on("Browser.downloadProgress", (event) => progress.push(event.params));
    const deadline = Date.now() + 5_000;
    while (!progress.some((event) => event.state === "completed") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 300));
    connection.close();

    expect(began).toEqual([
      expect.objectContaining({ guid: "guid-1", suggestedFilename: "report.pdf" }),
    ]);
    expect(progress.map((event) => event.state)).toEqual(["inProgress", "completed"]);
    expect(progress[1]).toMatchObject({
      guid: "guid-1",
      receivedBytes: 5,
      filePath: "/Users/user/Downloads/report (1).pdf",
    });
    const find = commands.find((command) => command.type === "downloads.find")!;
    expect(find.url).toBe("https://example.test/report");
    expect(Date.parse(String(find.startedAfter))).toBeLessThanOrEqual(Date.now());
    expect(finds).toBe(2);
  });

  test("reports a download without a path when the extension cannot find files", async () => {
    let polls = 0;
    const bridge: AttachedBrowserBridgeTransport = {
      async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
        if (payload.type === "downloads.find") {
          throw new AttachedBrowserBridgeError(
            "bridge_failed",
            "bridge command type is unsupported",
            false,
          );
        }
        if (payload.type !== "debugger.poll") return {} as T;
        polls += 1;
        if (polls !== 2) return { events: [], cursor: polls > 2 ? 2 : 0, truncated: false } as T;
        return {
          events: [
            {
              sequence: 1,
              tabId: "7",
              sessionId: null,
              method: "Page.downloadWillBegin",
              params: { frameId: "main", guid: "guid-2", url: "https://example.test/a" },
            },
            {
              sequence: 2,
              tabId: "7",
              sessionId: null,
              method: "Page.downloadProgress",
              params: { guid: "guid-2", totalBytes: 1, receivedBytes: 1, state: "completed" },
            },
          ],
          cursor: 2,
          truncated: false,
        } as T;
      },
      close() {},
    };
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    const completed = await connection.waitForEvent("Browser.downloadProgress", {
      timeoutMs: 5_000,
    });
    connection.close();
    expect(completed.params).toEqual({
      guid: "guid-2",
      totalBytes: 1,
      receivedBytes: 1,
      state: "completed",
    });
  });

  test("reports Chrome's protocol refusals as definite CDP errors that keep the tab", async () => {
    const bridge = new FakeBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
        flatten: true,
      });
      const request = bridge.request.bind(bridge);
      let message = '{"code":-32000,"message":"Not allowed"}';
      bridge.request = async (payload) => {
        if (payload.type === "debugger.command")
          throw new AttachedBrowserBridgeError("driver_rejected", message, false);
        return request(payload);
      };
      const refused = await connection
        .send("DOM.setFileInputFiles", { files: ["/tmp/a"], backendNodeId: 1 }, { sessionId })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(CdpProtocolError);
      expect(refused).toMatchObject({ code: -32_000, message: "Not allowed" });
      bridge.request = request;
      // A refused command left nothing in flight, so the tab can be attached again.
      const again = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
        flatten: true,
      });
      bridge.request = async (payload) => {
        if (payload.type === "debugger.command")
          throw new AttachedBrowserBridgeError("driver_rejected", message, false);
        return request(payload);
      };
      message = "Chrome command failed";
      const opaque = await connection
        .send("Input.dispatchMouseEvent", {}, { sessionId: again.sessionId })
        .catch((error: unknown) => error);
      expect(opaque).toMatchObject({ code: -32_000, message: "Chrome command failed" });
      bridge.request = request;
      // An unexplained failure of input may still arrive later.
      await expect(
        connection.send("Target.attachToTarget", { targetId: "7", flatten: true }),
      ).rejects.toThrow("disconnected during input");
    } finally {
      connection.close();
    }
  });

  test("flushes events Chrome sent before a command reply to listeners", async () => {
    // Chrome sends the navigation a click starts before it answers the next
    // command, but here events reach browserd only when it polls for them.
    const events: Array<Record<string, unknown>> = [];
    const bridge = new FakeBridge();
    const request = bridge.request.bind(bridge);
    bridge.request = async <T>(payload: Readonly<Record<string, unknown>>): Promise<T> => {
      if (payload.type === "debugger.command") {
        events.push({
          sequence: events.length + 1,
          tabId: "7",
          sessionId: null,
          method: "Page.frameRequestedNavigation",
          params: { frameId: "main", disposition: "currentTab" },
        });
        return { result: {} } as T;
      }
      if (payload.type === "debugger.poll") {
        const after = payload.afterSequence as number;
        const available = events.filter((event) => (event.sequence as number) > after);
        // Polls are slow, so a reply alone never shows the events before it.
        if (available.length > 0) await new Promise((resolve) => setTimeout(resolve, 30));
        return { events: available, cursor: events.length, truncated: false } as T;
      }
      return request(payload);
    };
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
        flatten: true,
      });
      let seen = 0;
      connection.on("Page.frameRequestedNavigation", () => (seen += 1), sessionId);
      for (let round = 1; round <= 3; round += 1) {
        await connection.send("Input.dispatchMouseEvent", {}, { sessionId });
        expect(seen).toBe(round - 1);
        await connection.flushEvents();
        expect(seen).toBe(round);
      }
    } finally {
      connection.close();
    }
  });

  test("keeps target command timeouts distinct from lost bridge transport", async () => {
    const bridge = new FakeBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
        flatten: true,
      });
      const request = bridge.request.bind(bridge);
      let code: "timeout" | "transport_failed" = "timeout";
      bridge.request = async (payload) => {
        if (payload.type === "debugger.command")
          throw new AttachedBrowserBridgeError(code, "synthetic bridge failure", true);
        return request(payload);
      };
      await expect(connection.send("Runtime.evaluate", {}, { sessionId })).rejects.toBeInstanceOf(
        CdpCommandTimeoutError,
      );
      await expect(connection.send("Page.getFrameTree", {}, { sessionId })).rejects.toMatchObject({
        method: "Page.getFrameTree",
        sessionId,
      });
      code = "transport_failed";
      const lost = await connection
        .send("Page.getFrameTree", {}, { sessionId })
        .catch((error: unknown) => error);
      expect(lost).toBeInstanceOf(CdpTransportError);
      expect(lost).not.toBeInstanceOf(CdpCommandTimeoutError);
    } finally {
      connection.close();
    }
  });

  test.each([
    ["darwin", "Macintosh"],
    ["win32", "Windows NT"],
    ["linux", "Linux"],
  ] as const)("retains %s keyboard platform in browser metadata", async (platform, marker) => {
    const connection = new AttachedChromeCdpConnection(new FakeBridge(), {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
      platform,
    });
    try {
      const version = await connection.send<{ userAgent: string }>("Browser.getVersion");
      expect(version.userAgent).toContain(marker);
      expect(/Macintosh|Mac OS/u.test(version.userAgent)).toBe(platform === "darwin");
    } finally {
      connection.close();
    }
  });

  test("virtualizes browser targets and tunnels target-scoped CDP with events", async () => {
    const bridge = new FakeBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });

    await expect(connection.send("Browser.getVersion")).resolves.toMatchObject({
      product: "Chrome/151.0.0.0",
    });
    await expect(connection.send("Target.getTargets")).resolves.toEqual({
      targetInfos: [
        expect.objectContaining({
          targetId: "7",
          type: "page",
          title: "Opengeni",
          url: "https://opengeni.ai/",
        }),
      ],
    });
    const attached = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
      flatten: true,
    });
    expect(attached.sessionId).toStartWith("attached:7:");

    const navigated = new Promise<void>((resolveEvent) => {
      connection.on(
        "Page.frameNavigated",
        (event) => {
          expect(event.sessionId).toBe(attached.sessionId);
          expect(event.params).toEqual({ frame: { id: "main" } });
          resolveEvent();
        },
        attached.sessionId,
      );
    });
    await expect(
      connection.send("Page.getFrameTree", {}, { sessionId: attached.sessionId }),
    ).resolves.toEqual({ frameTree: { frame: { id: "main" } } });
    await navigated;
    expect(bridge.commands).toContainEqual(
      expect.objectContaining({
        type: "debugger.command",
        tabId: "7",
        method: "Page.getFrameTree",
      }),
    );

    await connection.shutdown();
    expect(bridge.commands).toContainEqual({ type: "debugger.detach", tabId: "7" });
    expect(bridge.closed).toBe(true);
  });

  test("polls slowly while unused and resumes fast polling on the next command", async () => {
    const bridge = new FakeBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    connection.on("Page.frameNavigated", () => undefined);

    // Fast while recently used.
    await Bun.sleep(500);
    expect(bridge.pollCount).toBeGreaterThan(4);

    // After the quiet spell, at most about one poll a second.
    await Bun.sleep(2_000);
    const idleStart = bridge.pollCount;
    await Bun.sleep(1_100);
    expect(bridge.pollCount - idleStart).toBeLessThanOrEqual(2);

    // A command wakes the idle wait at once and polling is fast again.
    const beforeCommand = bridge.pollCount;
    await connection.send("Target.getTargets");
    await Bun.sleep(300);
    expect(bridge.pollCount - beforeCommand).toBeGreaterThan(3);

    await connection.shutdown();
  }, 10_000);

  test("keeps polling fast while a command runs past the quiet window", async () => {
    class SlowListBridge extends FakeBridge {
      slow = false;
      override async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
        if (payload.type === "tabs.list" && this.slow) await Bun.sleep(3_500);
        return await super.request<T>(payload);
      }
    }
    const bridge = new SlowListBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    connection.on("Page.frameNavigated", () => undefined);
    bridge.slow = true;
    const command = connection.send("Target.getTargets");

    await Bun.sleep(2_500);
    const during = bridge.pollCount;
    await Bun.sleep(500);
    expect(bridge.pollCount - during).toBeGreaterThan(4);

    await command;
    await connection.shutdown();
  }, 10_000);
});

for (const lost of [false, true]) {
  test(
    lost
      ? "discards a real retained-history gap and keeps the connection usable"
      : "drains legacy paginated event bursts without declaring history loss",
    async () => {
      const start = lost ? 2 : 1;
      const events = Array.from({ length: 1001 }, (_, index) => ({
        sequence: start + index,
        tabId: "7",
        sessionId: null,
        method: "Network.loadingFinished",
        params: {},
      }));
      let polls = 0;
      let received = 0;
      const bridge: AttachedBrowserBridgeTransport = {
        close() {},
        async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
          if (polls++ === 0) return { events: [], cursor: 0, truncated: false } as T;
          const available = events.filter(
            (event) => event.sequence > (payload.afterSequence as number),
          );
          const page = available.slice(0, payload.limit as number);
          return {
            events: page,
            cursor: page.at(-1)?.sequence ?? events.at(-1)!.sequence,
            truncated:
              (payload.afterSequence as number) < start - 1 || available.length > page.length,
          } as T;
        },
      };
      const connection = new AttachedChromeCdpConnection(bridge, {
        browserName: "Chrome",
        browserVersion: "151",
      });
      connection.on("Network.loadingFinished", () => {
        received += 1;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await expect(connection.send("Browser.getVersion")).resolves.toMatchObject({
          product: "Chrome/151",
        });
        expect(received).toBe(lost ? 0 : 1001);
      } finally {
        await connection.close();
      }
    },
  );
}

type StreamEvent = {
  sequence: number;
  tabId: string;
  sessionId: null;
  method: string;
  params: Record<string, unknown>;
};

/** An extension event buffer whose history can be lost and whose polls can fail. */
class StreamBridge implements AttachedBrowserBridgeTransport {
  readonly commands: Array<Record<string, unknown>> = [];
  events: StreamEvent[] = [];
  sequence = 0;
  failingPolls = 0;
  pollFailure: Error = new AttachedBrowserBridgeError("timeout", "poll timed out", true);
  heldInput: Promise<void> | null = null;
  heldNavigation: Promise<void> | null = null;
  heldAttach: Promise<void> | null = null;

  push(method: string, params: Record<string, unknown> = {}): void {
    this.sequence += 1;
    this.events.push({ sequence: this.sequence, tabId: "7", sessionId: null, method, params });
  }

  /** Chrome emitted more events than the extension retains. */
  overflow(): void {
    this.push("Network.requestWillBeSent");
    this.push("OpenGeni.debuggerDetached", { reason: "target_closed" });
    this.push("Page.frameNavigated", { frame: { id: "lost" } });
    this.events = this.events.slice(-1);
  }

  async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    this.commands.push({ ...payload });
    switch (payload.type) {
      case "tabs.list":
        return {
          tabs: [
            {
              id: "7",
              title: "Tab",
              url: "https://example.com/",
              active: true,
              controllable: true,
            },
          ],
        } as T;
      case "debugger.attach":
        if (this.heldAttach) await this.heldAttach;
        return { attached: true } as T;
      case "debugger.detach":
        return { detached: true } as T;
      case "debugger.command":
        if (payload.method === "Input.dispatchMouseEvent" && this.heldInput) await this.heldInput;
        if (payload.method === "Page.navigate" && this.heldNavigation) {
          await this.heldNavigation;
          throw new AttachedBrowserBridgeError("bridge_failed", "navigation reply lost", true);
        }
        return { result: {} } as T;
      case "debugger.poll": {
        if (this.failingPolls > 0) {
          this.failingPolls -= 1;
          throw this.pollFailure;
        }
        const after = payload.afterSequence as number;
        const first = this.events[0]?.sequence ?? this.sequence + 1;
        const page = this.events
          .filter((event) => event.sequence > after)
          .slice(0, payload.limit as number);
        return {
          events: page,
          cursor: page.at(-1)?.sequence ?? this.sequence,
          truncated: this.events.length > 0 && after < first - 1,
        } as T;
      }
      default:
        return {} as T;
    }
  }

  close(): void {}
}

async function eventually(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("attached Chrome event stream recovery", () => {
  test("treats tabs as detached after lost history, then re-attaches and delivers events", async () => {
    const bridge = new StreamBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    try {
      const first = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
      });
      const detached: Array<Record<string, unknown>> = [];
      connection.on("Target.detachedFromTarget", (event) => detached.push(event.params));
      bridge.overflow();
      await eventually(() => detached.length > 0, "the resynchronized detach");
      expect(detached).toEqual([
        { sessionId: first.sessionId, targetId: "7", reason: "event_stream_resynchronized" },
      ]);
      // The lost detach and navigation are not replayed as if they were seen.
      expect(detached).toHaveLength(1);
      await expect(
        connection.send("Page.getFrameTree", {}, { sessionId: first.sessionId }),
      ).rejects.toMatchObject({ code: "resource_unavailable", retryable: true });

      await eventually(
        () => bridge.commands.filter((command) => command.type === "debugger.poll").length > 4,
        "polling to resume",
      );
      const second = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
      });
      expect(second.sessionId).not.toBe(first.sessionId);
      const navigated = new Promise<Record<string, unknown>>((resolveEvent) => {
        connection.on(
          "Page.frameNavigated",
          (event) => resolveEvent(event.params),
          second.sessionId,
        );
      });
      bridge.push("Page.frameNavigated", { frame: { id: "fresh" } });
      await expect(navigated).resolves.toEqual({ frame: { id: "fresh" } });
      await expect(connection.send("Target.getTargets")).resolves.toMatchObject({
        targetInfos: [expect.objectContaining({ targetId: "7", attached: true })],
      });
      // Chrome's attachment was never dropped, so only shutdown detaches it.
      expect(bridge.commands.some((command) => command.type === "debugger.detach")).toBe(false);
      await connection.shutdown();
      expect(bridge.commands).toContainEqual({ type: "debugger.detach", tabId: "7" });
    } finally {
      connection.close();
    }
  });

  test("recovers from failed polls instead of failing every later call", async () => {
    const bridge = new StreamBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
      });
      const detached = new Promise<void>((resolveEvent) => {
        connection.on("Target.detachedFromTarget", () => resolveEvent());
      });
      bridge.failingPolls = 3;
      await detached;
      await expect(connection.send("Target.getTargets")).resolves.toMatchObject({
        targetInfos: [expect.objectContaining({ targetId: "7" })],
      });
      await eventually(() => bridge.failingPolls === 0, "the failed polls");
      const attached = await eventuallyAttach(connection);
      expect(attached).not.toBe(sessionId);
      const seen = new Promise<void>((resolveEvent) => {
        connection.on("Page.loadEventFired", () => resolveEvent(), attached);
      });
      bridge.push("Page.loadEventFired");
      await seen;
    } finally {
      connection.close();
    }
  });

  test("tells the agent to open a new session when the profile reconnected", async () => {
    const bridge = new StreamBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    try {
      await connection.send("Target.attachToTarget", { targetId: "7" });
      const polls = () => bridge.commands.filter((command) => command.type === "debugger.poll");
      const before = polls().length;
      bridge.pollFailure = new AttachedBrowserBridgeError(
        "fenced",
        "attached browser connection changed",
        true,
      );
      bridge.failingPolls = Number.POSITIVE_INFINITY;
      await eventually(() => polls().length > before, "the fenced poll");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const failure = await connection.send("Target.getTargets").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InteractionControllerError);
      expect(failure).toMatchObject({ code: "resource_unavailable", retryable: false });
      expect((failure as Error).message).toContain("open a new browser session");
    } finally {
      connection.close();
    }
  });

  test("keeps a tab with input in flight uncertain across a resynchronization", async () => {
    const bridge = new StreamBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    let releaseInput = () => {};
    bridge.heldInput = new Promise<void>((resolveInput) => {
      releaseInput = resolveInput;
    });
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
      });
      const click = connection
        .send("Input.dispatchMouseEvent", { type: "mousePressed" }, { sessionId })
        .catch((error: unknown) => error);
      const detached = new Promise<void>((resolveEvent) => {
        connection.on("Target.detachedFromTarget", () => resolveEvent());
      });
      bridge.overflow();
      await detached;
      releaseInput();
      await click;
      await eventually(
        () => bridge.commands.filter((command) => command.type === "debugger.poll").length > 4,
        "polling to resume",
      );
      await expect(
        connection.send("Target.attachToTarget", { targetId: "7" }),
      ).rejects.toMatchObject({ code: "resource_unavailable", retryable: false });
    } finally {
      releaseInput();
      connection.close();
    }
  });

  test("refuses an attach that spans a stream break but still detaches it at shutdown", async () => {
    const bridge = new StreamBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    let releaseAttach = () => {};
    try {
      await connection.send("Target.getTargets");
      connection.on("Page.loadEventFired", () => undefined);
      await eventually(
        () => bridge.commands.some((command) => command.type === "debugger.poll"),
        "polling to start",
      );
      bridge.heldAttach = new Promise<void>((resolveAttach) => {
        releaseAttach = resolveAttach;
      });
      const attach = connection
        .send("Target.attachToTarget", { targetId: "7" })
        .catch((error: unknown) => error);
      await eventually(
        () => bridge.commands.some((command) => command.type === "debugger.attach"),
        "the attach request",
      );
      bridge.failingPolls = 1;
      await eventually(() => bridge.failingPolls === 0, "the stream break");
      releaseAttach();
      expect(await attach).toMatchObject({ code: "resource_unavailable", retryable: true });
      await connection.shutdown();
      expect(bridge.commands).toContainEqual({ type: "debugger.detach", tabId: "7" });
    } finally {
      releaseAttach();
      connection.close();
    }
  });

  test("does not mistake a resynchronization for Chrome refusing a navigation", async () => {
    const bridge = new StreamBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    let releaseNavigation = () => {};
    bridge.heldNavigation = new Promise<void>((resolveNavigation) => {
      releaseNavigation = resolveNavigation;
    });
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
      });
      const navigation = connection
        .send("Page.navigate", { url: "https://example.com/next" }, { sessionId })
        .catch((error: unknown) => error);
      const detached = new Promise<void>((resolveEvent) => {
        connection.on("Target.detachedFromTarget", () => resolveEvent());
      });
      bridge.overflow();
      await detached;
      releaseNavigation();
      const failure = await navigation;
      // The navigation may have run: its outcome is unknown, not a refusal.
      expect(failure).not.toBeInstanceOf(InteractionDefiniteDriverError);
      expect(failure).toBeInstanceOf(CdpSessionDetachedError);
    } finally {
      releaseNavigation();
      connection.close();
    }
  });
});

/** Attaching is refused (retryably) while the stream is still recovering. */
async function eventuallyAttach(connection: AttachedChromeCdpConnection): Promise<string> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
      });
      return sessionId;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

test("CDP target lifecycle still detaches Chrome debugging when the driver closes", async () => {
  const { AttachedChromeRunner } = await import("../src/attached-cdp");
  const { AgentBrowserDriver } = await import("../src/cdp-driver");
  const bridge = new FakeBridge();
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "151",
  });
  await connection.send("Target.attachToTarget", { targetId: "7" });
  const driver = new AgentBrowserDriver({
    browserSessionId: crypto.randomUUID(),
    controllerGeneration: "test",
    targetLifecycle: "cdp",
    runner: new AttachedChromeRunner(bridge, connection),
    connect: async () => connection,
  });
  await driver.close();
  expect(bridge.commands).toContainEqual({ type: "debugger.detach", tabId: "7" });
  expect(bridge.closed).toBe(true);
});
