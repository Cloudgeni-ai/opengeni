import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { BrowserInteractionController } from "@opengeni/interaction";
import type { BrowserActionCommand } from "@opengeni/contracts";
import { AgentBrowserDriver, type BrowserCdpConnection } from "../src/cdp-driver";
import {
  AttachedChromeCdpConnection,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";
import { CdpCommandTimeoutError, CdpTransportError } from "../src/cdp";
import { AttachedBrowserBridgeError } from "../src/attached-bridge";

class DetachmentBridge implements AttachedBrowserBridgeTransport {
  readonly commands: Array<Readonly<Record<string, unknown>>> = [];
  readonly attached = new Set<string>();
  readonly events: Array<Record<string, unknown>> = [];
  private sequence = 0;
  beforeAttachReply: (() => Promise<void>) | null = null;
  beforeCommandReply: ((method: unknown) => Promise<void>) | null = null;

  detach(tabId: string, reason: "target_closed" | "canceled_by_user"): void {
    this.attached.delete(tabId);
    this.event(tabId, "OpenGeni.debuggerDetached", { reason });
  }

  event(tabId: string, method: string, params: Record<string, unknown>): void {
    this.events.push({ sequence: ++this.sequence, tabId, sessionId: null, method, params });
  }

  async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    this.commands.push(payload);
    switch (payload.type) {
      case "tabs.list":
        return {
          tabs: ["7", "8"].map((id) => ({
            id,
            title: "Fixture",
            active: id === "7",
            controllable: true,
            url: `https://browser.example.test/${id}`,
          })),
        } as T;
      case "debugger.attach":
        this.attached.add(String(payload.tabId));
        await this.beforeAttachReply?.();
        return { attached: true } as T;
      case "debugger.detach":
        this.attached.delete(String(payload.tabId));
        return { detached: true } as T;
      case "debugger.poll": {
        const events = this.events.filter(
          (event) => Number(event.sequence) > Number(payload.afterSequence),
        );
        return { events, cursor: events.at(-1)?.sequence ?? this.sequence, truncated: false } as T;
      }
      case "debugger.command": {
        const id = String(payload.tabId);
        if (!this.attached.has(id)) throw new Error("fixture debugger disconnected");
        let result: unknown = {};
        if (payload.method === "Page.getFrameTree")
          result = {
            frameTree: {
              frame: {
                id: `frame-${id}`,
                loaderId: `loader-${id}`,
                url: `https://browser.example.test/${id}`,
              },
            },
          };
        if (payload.method === "Page.getLayoutMetrics")
          result = {
            cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
            cssVisualViewport: {
              pageX: 0,
              pageY: 0,
              clientWidth: 800,
              clientHeight: 600,
              scale: 1,
            },
            cssContentSize: { x: 0, y: 0, width: 800, height: 600 },
          };
        if (payload.method === "Accessibility.getFullAXTree") result = { nodes: [] };
        if (payload.method === "Runtime.evaluate")
          result = {
            result: {
              value: String((payload.params as Record<string, unknown>)?.expression).includes(
                "innerWidth",
              )
                ? { width: 800, height: 600 }
                : 1,
            },
          };
        await this.beforeCommandReply?.(payload.method);
        return { result } as T;
      }
      default:
        return {} as T;
    }
  }
  close(): void {}
}

/** A bridge like the current extension's: each attachment has a number, and a
 * command naming an attachment that has ended is refused. */
class FencedBridge extends DetachmentBridge {
  private lastAttachment = 0;
  readonly attachments = new Map<string, number>();

  override detach(tabId: string, reason: "target_closed" | "canceled_by_user"): void {
    const attachment = this.attachments.get(tabId);
    this.attachments.delete(tabId);
    this.attached.delete(tabId);
    this.event(tabId, "OpenGeni.debuggerDetached", { reason, attachment });
  }

  /** Chrome ends the tab's attachment, but its detach event is reported
   * only later. */
  detachSilently(tabId: string): number | undefined {
    const attachment = this.attachments.get(tabId);
    this.attachments.delete(tabId);
    this.attached.delete(tabId);
    return attachment;
  }

  override async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    const tabId = String(payload.tabId);
    if (payload.type === "debugger.attach") {
      if (!this.attachments.has(tabId)) this.attachments.set(tabId, ++this.lastAttachment);
      const reply = await super.request<Record<string, unknown>>(payload);
      return { ...reply, attachment: this.attachments.get(tabId) } as T;
    }
    if (
      payload.type === "debugger.command" &&
      this.attachments.has(tabId) &&
      payload.attachment !== undefined &&
      payload.attachment !== this.attachments.get(tabId)
    ) {
      this.commands.push(payload);
      throw new AttachedBrowserBridgeError(
        "debugger_unavailable",
        "The attachment this command was sent for has ended",
        false,
      );
    }
    return await super.request<T>(payload);
  }
}

async function fixture<B extends DetachmentBridge = DetachmentBridge>(
  bridge: B = new DetachmentBridge() as B,
) {
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "151.0.0.0",
  });
  const driver = new AgentBrowserDriver({
    browserSessionId: randomUUID(),
    controllerGeneration: `fixture-${randomUUID()}`,
    engine: "chrome",
    focusEmulation: false,
    runner: {
      async run<T>() {
        return { cdpUrl: "opengeni-attached://local" } as T;
      },
    },
    connect: async () => connection,
  });
  await driver.start();
  return { bridge, connection, driver };
}

async function drainDetach(bridge: DetachmentBridge): Promise<void> {
  const start = bridge.commands.filter((command) => command.type === "debugger.poll").length;
  const deadline = Date.now() + 1000;
  while (bridge.commands.filter((command) => command.type === "debugger.poll").length <= start) {
    if (Date.now() > deadline) throw new Error("fixture polling did not advance");
    await Bun.sleep(1);
  }
  await Bun.sleep(0);
}

test("reattaches only the disconnected tab and invalidates its old causal fences", async () => {
  const { bridge, connection, driver } = await fixture();
  try {
    const before = await driver.observe("7");
    const other = await driver.observe("8");
    bridge.detach("7", "target_closed");
    await drainDetach(bridge);
    const after = await driver.observe("7");
    expect(after.target.targetGeneration).not.toBe(before.target.targetGeneration);
    expect(after.target.documentGeneration).not.toBe(before.target.documentGeneration);
    expect(after.frameId).not.toBe(before.frameId);
    const untouched = await driver.observe("8");
    expect(untouched.target.targetGeneration).toBe(other.target.targetGeneration);
    expect(untouched.target.documentGeneration).toBe(other.target.documentGeneration);
    expect(untouched.frameId).toBe(other.frameId);
    expect(
      bridge.commands.filter((c) => c.type === "debugger.attach" && c.tabId === "7"),
    ).toHaveLength(2);
    expect(
      bridge.commands.filter((c) => c.type === "debugger.attach" && c.tabId === "8"),
    ).toHaveLength(1);
    await expect(
      driver.dispatch({
        protocolVersion: 1,
        actor: { kind: "agent", subjectId: "agent:test" },
        operationId: randomUUID(),
        browserSessionId: before.browserSessionId,
        controllerGeneration: before.target.controllerGeneration,
        targetId: "7",
        expectedTargetGeneration: before.target.targetGeneration,
        expectedDocumentGeneration: before.target.documentGeneration!,
        expectedFrameId: before.frameId,
        observationMode: "none",
        action: { type: "pointer", action: "click", x: 10, y: 10 },
      }),
    ).rejects.toMatchObject({ code: "target_stale" });
    expect(
      bridge.commands.some(
        (c) =>
          c.type === "tabs.create" ||
          c.type === "tabs.close" ||
          c.method === "Page.navigate" ||
          String(c.method).startsWith("Input."),
      ),
    ).toBe(false);
  } finally {
    connection.close();
  }
});

for (const after of ["a lost and refused reattach", "an unresponsive tab"] as const)
  test(`an activation followed by ${after} is an unknown outcome, not a failure`, async () => {
    // The tab really was brought to the front before the failure, so the
    // action may have taken effect.
    class RefusingBridge extends DetachmentBridge {
      refuse = false;
      override async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
        if (payload.type === "debugger.attach" && this.refuse) {
          this.commands.push(payload);
          throw new AttachedBrowserBridgeError(
            "driver_rejected",
            "Another debugger is already attached to the tab with id: 7.",
            false,
          );
        }
        return await super.request<T>(payload);
      }
    }
    const bridge = new RefusingBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    let activated = false;
    let timedOut = false;
    const wrapped: BrowserCdpConnection = {
      on: connection.on.bind(connection),
      waitForEvent: connection.waitForEvent.bind(connection),
      close: connection.close.bind(connection),
      async send<T>(
        method: string,
        params: Readonly<Record<string, unknown>> = {},
        options: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal } = {},
      ) {
        if (after === "an unresponsive tab" && activated && options.sessionId) {
          timedOut = true;
          throw new CdpCommandTimeoutError(method, options.sessionId);
        }
        const reply = await connection.send<T>(method, params, options);
        if (method === "Target.activateTarget") {
          activated = true;
          if (after === "a lost and refused reattach") {
            bridge.refuse = true;
            bridge.detach("7", "target_closed");
            await drainDetach(bridge);
          }
        }
        return reply;
      },
    };
    const browserSessionId = randomUUID();
    const controllerGeneration = `fixture-${randomUUID()}`;
    const driver = new AgentBrowserDriver({
      browserSessionId,
      controllerGeneration,
      engine: "chrome",
      focusEmulation: false,
      runner: {
        async run<T>() {
          return { cdpUrl: "opengeni-attached://local" } as T;
        },
      },
      connect: async () => wrapped,
    });
    await driver.start();
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver,
    });
    try {
      const observation = await controller.observe("7");
      const receipt = await controller.run({
        protocolVersion: 1,
        actor: { kind: "agent", subjectId: "agent:test" },
        operationId: randomUUID(),
        browserSessionId,
        controllerGeneration,
        targetId: "7",
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId,
        action: { type: "activate" },
      });
      expect(after === "a lost and refused reattach" ? bridge.refuse : timedOut).toBe(true);
      expect(receipt.state).toBe("outcome_unknown");
      expect(receipt.error?.code).toBe(
        after === "a lost and refused reattach" ? "outcome_unknown" : "tab_not_responding",
      );
      if (after === "a lost and refused reattach")
        expect(receipt.error?.message).toStartWith("The tab disconnected while browser input");
    } finally {
      await driver.close().catch(() => undefined);
      connection.close();
    }
  });

function barrier() {
  let entered!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    arrived,
    release,
    hold: async () => {
      entered();
      await done;
    },
  };
}

test("detachment before the attach reply never installs a dead session", async () => {
  const bridge = new DetachmentBridge();
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "151.0.0.0",
  });
  const held = barrier();
  bridge.beforeAttachReply = held.hold;
  try {
    const attaching = connection.send("Target.attachToTarget", { targetId: "7" });
    await held.arrived;
    bridge.detach("7", "target_closed");
    await drainDetach(bridge);
    held.release();
    await expect(attaching).rejects.toMatchObject({
      code: "resource_unavailable",
      retryable: true,
    });
    expect(bridge.commands.some((c) => c.type === "debugger.command")).toBe(false);
    bridge.beforeAttachReply = null;
    await expect(
      connection.send("Target.attachToTarget", { targetId: "7" }),
    ).resolves.toHaveProperty("sessionId");
  } finally {
    held.release();
    connection.close();
  }
});

test("late input completion after detachment remains outcome unknown without replay", async () => {
  const { bridge, connection, driver } = await fixture();
  const held = barrier();
  try {
    const observation = await driver.observe("7");
    bridge.beforeCommandReply = async (method) => {
      if (method === "Input.dispatchMouseEvent") await held.hold();
    };
    const input = driver.dispatch({
      protocolVersion: 1,
      actor: { kind: "agent", subjectId: "agent:test" },
      operationId: randomUUID(),
      browserSessionId: observation.browserSessionId,
      controllerGeneration: observation.target.controllerGeneration,
      targetId: "7",
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId,
      observationMode: "none",
      action: { type: "pointer", action: "click", x: 10, y: 10 },
    });
    await held.arrived;
    bridge.detach("7", "target_closed");
    await drainDetach(bridge);
    held.release();
    await expect(input).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(bridge.commands.filter((c) => c.method === "Input.dispatchMouseEvent")).toHaveLength(1);
    expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(1);
    await expect(driver.observe("7")).rejects.toMatchObject({
      code: "resource_unavailable",
      retryable: false,
    });
    await expect(driver.observe("8")).resolves.toMatchObject({ target: { id: "8" } });
    expect(bridge.commands.filter((c) => c.method === "Input.dispatchMouseEvent")).toHaveLength(1);
  } finally {
    held.release();
    connection.close();
  }
});

test("user cancellation is a typed unavailable result without silently reattaching", async () => {
  const { bridge, connection, driver } = await fixture();
  try {
    bridge.detach("7", "canceled_by_user");
    await drainDetach(bridge);
    await expect(driver.observe("7")).rejects.toMatchObject({
      code: "resource_unavailable",
      retryable: false,
    });
    await expect(driver.observe("7")).rejects.toMatchObject({
      code: "resource_unavailable",
      retryable: false,
    });
    expect(
      bridge.commands.filter((c) => c.type === "debugger.attach" && c.tabId === "7"),
    ).toHaveLength(1);
    await expect(driver.observe("8")).resolves.toMatchObject({ target: { id: "8" } });
  } finally {
    connection.close();
  }
});

test("a new tab attachment cannot revive commands using its disconnected session id", async () => {
  const bridge = new DetachmentBridge();
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "151.0.0.0",
  });
  try {
    const first = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
    });
    bridge.detach("7", "target_closed");
    await drainDetach(bridge);
    const second = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
    });
    expect(second.sessionId).not.toBe(first.sessionId);
    const count = bridge.commands.length;
    await expect(
      connection.send("Page.getFrameTree", {}, { sessionId: first.sessionId }),
    ).rejects.toMatchObject({ code: "resource_unavailable" });
    expect(bridge.commands).toHaveLength(count);
    await expect(
      connection.send("Page.getFrameTree", {}, { sessionId: second.sessionId }),
    ).resolves.toHaveProperty("frameTree");
  } finally {
    connection.close();
  }
});

test("detachment during a semantic read discards that observation and reads again on a new attachment", async () => {
  const { bridge, connection, driver } = await fixture();
  const held = barrier();
  try {
    const first = await driver.observe("7");
    let heldAx = false;
    bridge.beforeCommandReply = async (method) => {
      if (method !== "Accessibility.getFullAXTree" || heldAx) return;
      heldAx = true;
      await held.hold();
    };
    const observing = driver.observe("7");
    await held.arrived;
    bridge.detach("7", "target_closed");
    await drainDetach(bridge);
    held.release();
    const after = await observing;
    expect(after.target.targetGeneration).not.toBe(first.target.targetGeneration);
    expect(after.target.documentGeneration).not.toBe(first.target.documentGeneration);
    expect(after.frameId).not.toBe(first.frameId);
    expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(2);
    expect(bridge.commands.some((c) => String(c.method).startsWith("Input."))).toBe(false);
  } finally {
    held.release();
    connection.close();
  }
});

test("detachment during driver initialization cannot publish its old target state", async () => {
  const { bridge, connection, driver } = await fixture();
  const held = barrier();
  try {
    bridge.beforeCommandReply = async (method) => {
      if (method === "Page.enable") await held.hold();
    };
    const observing = driver.observe("8");
    await held.arrived;
    bridge.detach("8", "target_closed");
    await drainDetach(bridge);
    held.release();
    await expect(observing).rejects.toThrow();
    bridge.beforeCommandReply = null;
    await expect(driver.observe("8")).resolves.toMatchObject({ target: { id: "8" } });
    expect(
      bridge.commands.filter((c) => c.type === "debugger.attach" && c.tabId === "8"),
    ).toHaveLength(2);
    await expect(driver.observe("7")).resolves.toMatchObject({ target: { id: "7" } });
    expect(bridge.commands.some((c) => c.type === "tabs.close")).toBe(false);
  } finally {
    held.release();
    connection.close();
  }
});

test("an obsolete session detach event cannot invalidate its replacement attachment", async () => {
  const { bridge, connection, driver } = await fixture();
  try {
    const attached = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
    });
    bridge.detach("7", "target_closed");
    await drainDetach(bridge);
    const current = await driver.observe("7");
    bridge.event("7", "Target.detachedFromTarget", {
      targetId: "7",
      sessionId: attached.sessionId,
    });
    await drainDetach(bridge);
    const after = await driver.observe("7");
    expect(after.target.targetGeneration).toBe(current.target.targetGeneration);
    expect(after.target.documentGeneration).toBe(current.target.documentGeneration);
    expect(after.frameId).toBe(current.frameId);
    expect(
      bridge.commands.filter((c) => c.type === "debugger.attach" && c.tabId === "7"),
    ).toHaveLength(3);
  } finally {
    connection.close();
  }
});

test("a failed input reply cannot admit a replacement attachment before its late command settles", async () => {
  const bridge = new DetachmentBridge();
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "151.0.0.0",
  });
  try {
    const attached = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
    });
    bridge.beforeCommandReply = async (method) => {
      if (method === "Input.dispatchMouseEvent")
        throw new CdpTransportError("fixture reply unavailable");
    };
    await expect(
      connection.send(
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: 10, y: 10 },
        { sessionId: attached.sessionId },
      ),
    ).rejects.toBeInstanceOf(CdpTransportError);
    bridge.detach("7", "target_closed");
    await drainDetach(bridge);
    await expect(connection.send("Target.attachToTarget", { targetId: "7" })).rejects.toMatchObject(
      { code: "resource_unavailable", retryable: false },
    );
    expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(1);
    expect(bridge.commands.filter((c) => c.method === "Input.dispatchMouseEvent")).toHaveLength(1);
    await expect(
      connection.send("Target.attachToTarget", { targetId: "8" }),
    ).resolves.toHaveProperty("sessionId");
  } finally {
    connection.close();
  }
});

for (const kind of ["mousePressed", "keyDown"] as const) {
  test(`an acknowledged ${kind} followed by detach journals unknown without replay`, async () => {
    const bridge = new DetachmentBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    let detached = false;
    const wrapped: BrowserCdpConnection = {
      on: connection.on.bind(connection),
      waitForEvent: connection.waitForEvent.bind(connection),
      close: connection.close.bind(connection),
      async send<T>(
        method: string,
        params: Readonly<Record<string, unknown>> = {},
        options: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal } = {},
      ) {
        const reply = await connection.send<T>(method, params, options);
        if (!detached && params.type === kind) {
          detached = true;
          bridge.detach("7", "target_closed");
          await drainDetach(bridge);
        }
        return reply;
      },
    };
    const browserSessionId = randomUUID();
    const controllerGeneration = `fixture-${randomUUID()}`;
    const driver = new AgentBrowserDriver({
      browserSessionId,
      controllerGeneration,
      engine: "chrome",
      focusEmulation: false,
      runner: {
        async run<T>() {
          return { cdpUrl: "opengeni-attached://local" } as T;
        },
      },
      connect: async () => wrapped,
    });
    await driver.start();
    const journal: string[] = [];
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver,
      onJournalRecord: (record) => {
        journal.push(record.receipt.state);
      },
    });
    try {
      const observation = await controller.observe("7");
      const command: BrowserActionCommand = {
        protocolVersion: 1,
        actor: { kind: "agent", subjectId: "agent:test" },
        operationId: randomUUID(),
        browserSessionId,
        controllerGeneration,
        targetId: "7",
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId,
        observationMode: "none",
        action:
          kind === "mousePressed"
            ? { type: "pointer", action: "click", x: 10, y: 10 }
            : { type: "press", key: "A" },
      };
      const receipt = await controller.run(command);
      const inputs = () => bridge.commands.filter((c) => String(c.method).startsWith("Input."));
      const count = inputs().length;
      expect(inputs().some((c) => (c.params as Record<string, unknown>).type === kind)).toBe(true);
      expect(
        inputs().some(
          (c) =>
            (c.params as Record<string, unknown>).type ===
            (kind === "mousePressed" ? "mouseReleased" : "keyUp"),
        ),
      ).toBe(false);
      expect(receipt.state).toBe("outcome_unknown");
      expect(journal).toEqual(["prepared", "dispatched", "outcome_unknown"]);
      expect((await controller.run(command)).state).toBe("outcome_unknown");
      expect(inputs()).toHaveLength(count);
    } finally {
      connection.close();
    }
  });
}

for (const method of [
  "Page.navigateToHistoryEntry",
  "DOM.focus",
  "DOM.scrollIntoViewIfNeeded",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
  "Page.setInterceptFileChooserDialog",
  "Runtime.callFunctionOn",
  "Page.unknownFutureCommand",
]) {
  test(`queued ${method} cannot run under a replacement attachment`, async () => {
    const held = barrier();
    let deliveredWithReplacement = false;
    class QueuedBridge extends DetachmentBridge {
      override async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
        if (payload.type !== "debugger.command" || payload.method !== method)
          return await super.request<T>(payload);
        this.commands.push(payload);
        await held.hold();
        deliveredWithReplacement =
          this.attached.has(String(payload.tabId)) &&
          this.commands.filter((c) => c.type === "debugger.attach" && c.tabId === payload.tabId)
            .length > 1;
        return { result: {} } as T;
      }
    }
    const bridge = new QueuedBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    let pending: Promise<unknown> | null = null;
    try {
      const first = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
      });
      pending = connection
        .send(method, {}, { sessionId: first.sessionId })
        .catch((error: unknown) => error);
      await held.arrived;
      bridge.detach("7", "target_closed");
      await drainDetach(bridge);
      await expect(
        connection.send("Target.attachToTarget", { targetId: "7" }),
      ).rejects.toMatchObject({
        code: "resource_unavailable",
        retryable: false,
      });
      held.release();
      await pending;
      expect(deliveredWithReplacement).toBe(false);
      expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(1);
    } finally {
      held.release();
      await pending;
      connection.close();
    }
  });
}

for (const code of ["debugger_unavailable", "driver_rejected"] as const) {
  test(`${code} before the detach poll is a typed read failure without input`, async () => {
    const { bridge, connection, driver } = await fixture();
    try {
      await driver.observe("7");
      bridge.beforeCommandReply = async (method) => {
        if (method === "Page.getFrameTree")
          throw new AttachedBrowserBridgeError(code, "synthetic debugger rejection", false);
      };
      await expect(driver.observe("7")).rejects.toMatchObject({
        code: "resource_unavailable",
        retryable: true,
      });
      expect(bridge.commands.some((c) => String(c.method).startsWith("Input."))).toBe(false);
      // A released attachment is read once more on a new one; a refused
      // command leaves the attachment as it was.
      expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(
        code === "debugger_unavailable" ? 2 : 1,
      );
    } finally {
      connection.close();
    }
  });
}

test("input Chrome ends a fenced attachment under is outcome unknown, and the tab attaches again", async () => {
  const bridge = new FencedBridge();
  const { connection, driver } = await fixture(bridge);
  try {
    const observation = await driver.observe("7");
    let ended = false;
    bridge.beforeCommandReply = async (method) => {
      if (method !== "Input.dispatchMouseEvent" || ended) return;
      ended = true;
      // Another extension added a frame: Chrome ends the attachment while it
      // handles the input, and reports the detach before the reply.
      bridge.detach("7", "target_closed");
      await drainDetach(bridge);
      throw new AttachedBrowserBridgeError(
        "driver_rejected",
        "Detached while handling command.",
        false,
      );
    };
    await expect(
      driver.dispatch({
        protocolVersion: 1,
        actor: { kind: "agent", subjectId: "agent:test" },
        operationId: randomUUID(),
        browserSessionId: observation.browserSessionId,
        controllerGeneration: observation.target.controllerGeneration,
        targetId: "7",
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId,
        observationMode: "none",
        action: { type: "pointer", action: "click", x: 10, y: 10 },
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    await expect(driver.observe("7")).resolves.toMatchObject({ target: { id: "7" } });
    expect(bridge.commands.filter((c) => c.type === "debugger.attach").length).toBeGreaterThan(1);
    const inputs = bridge.commands.filter((c) => c.method === "Input.dispatchMouseEvent");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.attachment).toBe(1);
    expect(bridge.commands.at(-1)!.attachment).toBe(2);
  } finally {
    connection.close();
  }
});

test("a late command for an ended attachment is refused and leaves its replacement working", async () => {
  const held = barrier();
  const method = "Runtime.callFunctionOn";
  let ranUnderReplacement = false;
  let heldOnce = false;
  class QueuedFencedBridge extends FencedBridge {
    override async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
      if (payload.type === "debugger.command" && payload.method === method && !heldOnce) {
        heldOnce = true;
        await held.hold();
        try {
          return await super.request<T>(payload);
        } finally {
          ranUnderReplacement = this.attachments.get(String(payload.tabId)) === payload.attachment;
        }
      }
      return await super.request<T>(payload);
    }
  }
  const bridge = new QueuedFencedBridge();
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "151.0.0.0",
  });
  let pending: Promise<unknown> | null = null;
  try {
    const first = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
    });
    pending = connection
      .send(method, {}, { sessionId: first.sessionId })
      .catch((error: unknown) => error);
    await held.arrived;
    bridge.detach("7", "target_closed");
    await drainDetach(bridge);
    const second = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
    });
    held.release();
    await expect(pending).resolves.toMatchObject({ code: "resource_unavailable" });
    expect(ranUnderReplacement).toBe(false);
    await expect(
      connection.send("Page.getFrameTree", {}, { sessionId: second.sessionId }),
    ).resolves.toHaveProperty("frameTree");
  } finally {
    held.release();
    await pending;
    connection.close();
  }
});

test("a detach reported after its replacement attached leaves the replacement working", async () => {
  const bridge = new FencedBridge();
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "151.0.0.0",
  });
  const detached: unknown[] = [];
  connection.on("Target.detachedFromTarget", (event) => detached.push(event.params));
  try {
    await connection.send("Target.attachToTarget", { targetId: "7" });
    const ended = bridge.detachSilently("7");
    const second = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
    });
    expect(bridge.attachments.get("7")).not.toBe(ended);
    bridge.event("7", "OpenGeni.debuggerDetached", { reason: "target_closed", attachment: ended });
    await drainDetach(bridge);
    expect(detached).toEqual([]);
    await expect(
      connection.send("Page.getFrameTree", {}, { sessionId: second.sessionId }),
    ).resolves.toHaveProperty("frameTree");
  } finally {
    connection.close();
  }
});

test("a method the extension refuses before sending leaves the tab attachable after a detach", async () => {
  // Extensions before Inspector.enable was allowed refuse it outright; the
  // driver sends it on every attach to notice a crashed tab.
  const { bridge, connection, driver } = await fixture();
  bridge.beforeCommandReply = async (method) => {
    if (method === "Inspector.enable")
      throw new AttachedBrowserBridgeError(
        "invalid_request",
        "debugger method is outside the browser driver surface",
        false,
      );
  };
  try {
    await driver.observe("7");
    expect(bridge.commands.some((c) => c.method === "Inspector.enable")).toBe(true);
    // Let the refusal of the enable, sent without waiting, come back first.
    await Bun.sleep(20);
    bridge.detach("7", "target_closed");
    await drainDetach(bridge);
    await expect(driver.observe("7")).resolves.toMatchObject({ target: { id: "7" } });
    expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(2);
    // The same on the connection itself, waiting for the refusal.
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "8",
    });
    await expect(connection.send("Inspector.enable", {}, { sessionId })).rejects.toMatchObject({
      code: -32_601,
    });
    bridge.detach("8", "target_closed");
    await drainDetach(bridge);
    await expect(
      connection.send("Target.attachToTarget", { targetId: "8" }),
    ).resolves.toHaveProperty("sessionId");
  } finally {
    connection.close();
  }
});

/** A fenced bridge whose Chrome refuses commands for a tab it no longer
 * debugs with its own wording, as chrome.debugger does before the extension
 * has seen the detach. */
class NotAttachedBridge extends FencedBridge {
  override async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    const tabId = String(payload.tabId);
    if (payload.type === "debugger.command" && !this.attached.has(tabId)) {
      this.commands.push(payload);
      throw new AttachedBrowserBridgeError(
        "driver_rejected",
        `Debugger is not attached to the tab with id: ${tabId}.`,
        false,
      );
    }
    return await super.request<T>(payload);
  }
}

// A 1x1 PNG.
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function controllerFor(
  driver: AgentBrowserDriver,
  observation: { browserSessionId: string; target: { controllerGeneration: string } },
) {
  return new BrowserInteractionController({
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    driver,
  });
}

test("a read Chrome refuses because its attachment ended reads again on a new attachment", async () => {
  // Chrome ended the tab's attachment (another extension added a frame), and
  // the detach is reported only after the next command was refused.
  const bridge = new NotAttachedBridge();
  const { connection, driver } = await fixture(bridge);
  try {
    const first = await driver.observe("7");
    const ended = bridge.detachSilently("7");
    setTimeout(() => {
      bridge.event("7", "OpenGeni.debuggerDetached", {
        reason: "target_closed",
        attachment: ended,
      });
    }, 20);
    const state = await driver.targetState("7");
    expect(state.targetGeneration).not.toBe(first.target.targetGeneration);
    const after = await driver.observe("7");
    expect(after.target.targetGeneration).toBe(state.targetGeneration);
    expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(2);
    expect(
      bridge.commands.some((c) => typeof c.method === "string" && c.method.startsWith("Input.")),
    ).toBe(false);
  } finally {
    connection.close();
  }
});

test("a refused read whose detach is never reported still attaches again", async () => {
  const bridge = new NotAttachedBridge();
  const { connection, driver } = await fixture(bridge);
  try {
    const first = await driver.observe("7");
    bridge.detachSilently("7");
    const after = await driver.observe("7");
    expect(after.target.targetGeneration).not.toBe(first.target.targetGeneration);
    expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(2);
  } finally {
    connection.close();
  }
});

test("a screenshot whose tab debugging ends mid-capture is taken on a new attachment", async () => {
  class ScreenshotBridge extends FencedBridge {
    override async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
      if (payload.type === "debugger.command" && payload.method === "Page.captureScreenshot") {
        await super.request(payload);
        return { result: { data: PIXEL_PNG } } as T;
      }
      return await super.request<T>(payload);
    }
  }
  const bridge = new ScreenshotBridge();
  const { connection, driver } = await fixture(bridge);
  try {
    await driver.observe("7");
    let ended = false;
    bridge.beforeCommandReply = async (method) => {
      if (method !== "Page.captureScreenshot" || ended) return;
      ended = true;
      bridge.detach("7", "target_closed");
      await drainDetach(bridge);
      throw new AttachedBrowserBridgeError(
        "driver_rejected",
        "Detached while handling command.",
        false,
      );
    };
    const frame = await driver.captureScreenshot("7");
    expect(frame.width).toBe(1);
    expect(ended).toBe(true);
    expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(2);
  } finally {
    connection.close();
  }
});

for (const ending of ["during", "before"] as const)
  test(`input whose tab debugging ends ${ending} a later command is unknown and shows the page on a new attachment`, async () => {
    // A click focuses a login field, a password manager adds its inline menu
    // frame, and Chrome ends the attachment before the click finishes.
    const bridge = new NotAttachedBridge();
    const { connection, driver } = await fixture(bridge);
    try {
      const observation = await driver.observe("7");
      let presses = 0;
      bridge.beforeCommandReply = async (method) => {
        if (method !== "Input.dispatchMouseEvent" || ++presses !== 1) return;
        if (ending === "during") {
          bridge.detach("7", "target_closed");
          await drainDetach(bridge);
          throw new AttachedBrowserBridgeError(
            "driver_rejected",
            "Detached while handling command.",
            false,
          );
        }
        // The first press went through; Chrome ends the attachment before
        // the next one and reports it only later.
        const ended = bridge.detachSilently("7");
        setTimeout(() => {
          bridge.event("7", "OpenGeni.debuggerDetached", {
            reason: "target_closed",
            attachment: ended,
          });
        }, 20);
      };
      const receipt = await controllerFor(driver, observation).run({
        protocolVersion: 1,
        actor: { kind: "agent", subjectId: "agent:test" },
        operationId: randomUUID(),
        browserSessionId: observation.browserSessionId,
        controllerGeneration: observation.target.controllerGeneration,
        targetId: "7",
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId,
        action: { type: "pointer", action: "click", x: 10, y: 10 },
      });
      expect(receipt.state).toBe("outcome_unknown");
      expect(receipt.error).toMatchObject({
        code: "outcome_unknown",
        message:
          "The tab disconnected while browser input was being sent. Check the current tabs before continuing; do not repeat the action automatically.",
      });
      // The page as the click left it, read on the new attachment.
      expect(receipt.observation?.target.id).toBe("7");
      expect(receipt.observation?.target.targetGeneration).not.toBe(
        observation.target.targetGeneration,
      );
      expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(2);
      // Nothing was sent again.
      expect(bridge.commands.filter((c) => c.method === "Input.dispatchMouseEvent").length).toBe(
        ending === "during" ? 1 : 2,
      );
    } finally {
      connection.close();
    }
  });

test("commands Chrome refuses while the tab holds another extension's frame fail plainly, without leaving the tab uncertain", async () => {
  // Chrome can keep a tab attached while another extension's page is a frame
  // of it, and then refuses every command without running it. The first
  // refusal may only mean Chrome is ending the attachment, so the read tries
  // a new one; refused there too, it fails plainly.
  const bridge = new FencedBridge();
  const { connection, driver } = await fixture(bridge);
  try {
    const observation = await driver.observe("7");
    let refusal: AttachedBrowserBridgeError | null = new AttachedBrowserBridgeError(
      "driver_rejected",
      "Cannot access a chrome-extension:// URL of different extension",
      false,
      { extensionCode: "driver_failed" },
    );
    bridge.beforeCommandReply = async () => {
      if (refusal) throw refusal;
    };
    const message =
      "Another browser extension has added its own frame to this page (password managers do this for their inline menu), and Chrome does not let the Opengeni Browser extension control a tab while it has one. Update the Opengeni Browser extension, turn off that extension's inline menu for this site, or use a managed browser";
    await expect(driver.observe("7")).rejects.toMatchObject({
      code: "resource_unavailable",
      retryable: false,
      message,
    });
    expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(2);
    const receipt = await controllerFor(driver, observation).run({
      protocolVersion: 1,
      actor: { kind: "agent", subjectId: "agent:test" },
      operationId: randomUUID(),
      browserSessionId: observation.browserSessionId,
      controllerGeneration: observation.target.controllerGeneration,
      targetId: "7",
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId,
      action: { type: "pointer", action: "click", x: 10, y: 10 },
    });
    expect(receipt.state).toBe("failed");
    expect(receipt.error).toMatchObject({ code: "resource_unavailable", message });
    // The extension's own explanation, when it could not remove the frame.
    refusal = new AttachedBrowserBridgeError(
      "driver_rejected",
      "Bitwarden keeps adding its own frame to this page",
      false,
      { extensionCode: "tab_unavailable" },
    );
    await expect(driver.targetState("7")).rejects.toMatchObject({
      code: "resource_unavailable",
      retryable: false,
      message: "Bitwarden keeps adding its own frame to this page",
    });
    // Once the frame is gone the tab works again: nothing was left uncertain.
    refusal = null;
    await expect(driver.observe("7")).resolves.toMatchObject({ target: { id: "7" } });
  } finally {
    connection.close();
  }
});

test("Chrome's frame refusal for an attachment it is ending reads again on a new attachment", async () => {
  // An extension that does not remove other extensions' frames relays
  // Chrome's refusal, which Chrome also gives for a tab it no longer debugs
  // just before the extension reports the detach.
  class EndingFrameRefusalBridge extends FencedBridge {
    override async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
      const tabId = String(payload.tabId);
      if (payload.type === "debugger.command" && !this.attached.has(tabId)) {
        this.commands.push(payload);
        throw new AttachedBrowserBridgeError(
          "driver_rejected",
          "Cannot access a chrome-extension:// URL of different extension",
          false,
          { extensionCode: "driver_failed" },
        );
      }
      return await super.request<T>(payload);
    }
  }
  const bridge = new EndingFrameRefusalBridge();
  const { connection, driver } = await fixture(bridge);
  try {
    const first = await driver.observe("7");
    const ended = bridge.detachSilently("7");
    setTimeout(() => {
      bridge.event("7", "OpenGeni.debuggerDetached", {
        reason: "target_closed",
        attachment: ended,
      });
    }, 20);
    const after = await driver.observe("7");
    expect(after.target.targetGeneration).not.toBe(first.target.targetGeneration);
    expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(2);
    // Input refused the same way before anything was sent is a definite
    // failure, and the tab attaches again for the next call.
    const endedAgain = bridge.detachSilently("7");
    setTimeout(() => {
      bridge.event("7", "OpenGeni.debuggerDetached", {
        reason: "target_closed",
        attachment: endedAgain,
      });
    }, 20);
    const receipt = await controllerFor(driver, after).run({
      protocolVersion: 1,
      actor: { kind: "agent", subjectId: "agent:test" },
      operationId: randomUUID(),
      browserSessionId: after.browserSessionId,
      controllerGeneration: after.target.controllerGeneration,
      targetId: "7",
      expectedTargetGeneration: after.target.targetGeneration,
      expectedDocumentGeneration: after.target.documentGeneration!,
      expectedFrameId: after.frameId,
      action: { type: "pointer", action: "click", x: 10, y: 10 },
    });
    expect(receipt.state).toBe("failed");
    expect(receipt.error).toMatchObject({
      code: "resource_unavailable",
      message: "Browser tab debugging disconnected; observe the tab again",
    });
    await expect(driver.observe("7")).resolves.toMatchObject({ target: { id: "7" } });
    expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(3);
  } finally {
    connection.close();
  }
});
