import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { BrowserInteractionController } from "@opengeni/interaction";
import type { BrowserActionCommand } from "@opengeni/contracts";
import { AgentBrowserDriver, type BrowserCdpConnection } from "../src/cdp-driver";
import {
  AttachedChromeCdpConnection,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";
import { CdpTransportError } from "../src/cdp";
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

async function fixture() {
  const bridge = new DetachmentBridge();
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

test("detachment during a semantic read discards that observation and permits a fresh read", async () => {
  const { bridge, connection, driver } = await fixture();
  const held = barrier();
  try {
    const first = await driver.observe("7");
    bridge.beforeCommandReply = async (method) => {
      if (method === "Accessibility.getFullAXTree") await held.hold();
    };
    const observing = driver.observe("7");
    await held.arrived;
    bridge.detach("7", "target_closed");
    await drainDetach(bridge);
    held.release();
    await expect(observing).rejects.toMatchObject({ code: "resource_unavailable" });
    bridge.beforeCommandReply = null;
    const after = await driver.observe("7");
    expect(after.target.targetGeneration).not.toBe(first.target.targetGeneration);
    expect(after.target.documentGeneration).not.toBe(first.target.documentGeneration);
    expect(after.frameId).not.toBe(first.frameId);
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
      expect(bridge.commands.filter((c) => c.type === "debugger.attach")).toHaveLength(1);
    } finally {
      connection.close();
    }
  });
}
