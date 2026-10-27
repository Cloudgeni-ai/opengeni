import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import {
  AttachedChromeCdpConnection,
  AttachedChromeRunner,
  createAttachedChromeDriver,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";
import { AttachedBrowserBridgeError } from "../src/attached-bridge";

const PAGE = "https://meet.example.test:8443/room/42?join=1";

/** A connected Chrome with one agent tab, whose extension sets site
 * permissions the way `answer` says. */
class SitePermissionBridge implements AttachedBrowserBridgeTransport {
  readonly commands: Array<Readonly<Record<string, unknown>>> = [];

  constructor(
    private readonly knowsSitePermissions: boolean,
    private readonly answer: () => unknown = () => ({ setting: "granted" }),
  ) {}

  async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    this.commands.push(payload);
    switch (payload.type) {
      case "ping":
        return (
          this.knowsSitePermissions ? { pong: true, sitePermissions: true } : { pong: true }
        ) as T;
      case "permissions.set":
        return this.answer() as T;
      case "tabs.list":
      case "tabs.create": {
        const tab = { id: "7", title: "Call", active: false, controllable: true, url: PAGE };
        return (payload.type === "tabs.list" ? { tabs: [tab] } : { tab }) as T;
      }
      case "debugger.poll":
        return { events: [], cursor: 0, truncated: false } as T;
      case "debugger.command":
        return { result: this.result(payload) } as T;
      default:
        return {} as T;
    }
  }

  close(): void {}

  sitePermissionCommands(): Array<Readonly<Record<string, unknown>>> {
    return this.commands.filter(
      (command) => command.type === "ping" || command.type === "permissions.set",
    );
  }

  private result(payload: Readonly<Record<string, unknown>>): unknown {
    switch (payload.method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "frame-7", loaderId: "loader-7", url: PAGE } } };
      case "Page.getLayoutMetrics":
        return {
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
      case "Accessibility.getFullAXTree":
        return { nodes: [] };
      case "Runtime.evaluate":
        return {
          result: {
            value: String((payload.params as Record<string, unknown>)?.expression).includes(
              "innerWidth",
            )
              ? { width: 800, height: 600 }
              : 1,
          },
        };
      default:
        return {};
    }
  }
}

async function start(bridge: SitePermissionBridge) {
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "151.0.0.0",
  });
  const driver = createAttachedChromeDriver(
    { browserSessionId: randomUUID(), controllerGeneration: `fixture-${randomUUID()}` },
    { connection, runner: new AttachedChromeRunner(bridge, connection) },
  );
  const observation = await driver.start();
  return { driver, observation };
}

function permission(
  observation: BrowserObservation,
  action: { permission: string; setting: string },
): BrowserActionCommand {
  return {
    protocolVersion: 1,
    actor: { kind: "agent", subjectId: "agent:test" },
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration!,
    expectedFrameId: observation.frameId,
    observationMode: "none",
    action: { type: "permission", ...action },
  } as BrowserActionCommand;
}

test("the person's own Chrome sets a site permission for the exact site of the agent's tab", async () => {
  const bridge = new SitePermissionBridge(true);
  const { driver, observation } = await start(bridge);
  try {
    for (const [name, sent] of [
      ["microphone", "microphone"],
      ["camera", "camera"],
      ["geolocation", "geolocation"],
      ["notifications", "notifications"],
    ] as const) {
      await driver.dispatch(permission(observation, { permission: name, setting: "granted" }));
      expect(bridge.sitePermissionCommands().at(-1)).toEqual({
        type: "permissions.set",
        origin: "https://meet.example.test:8443",
        permission: sent,
        setting: "granted",
      });
    }
    await driver.dispatch(permission(observation, { permission: "camera", setting: "prompt" }));
    expect(bridge.sitePermissionCommands().at(-1)).toMatchObject({ setting: "prompt" });
  } finally {
    await driver.close();
  }
});

test("permissions Chrome does not let an extension set are refused without asking it", async () => {
  const bridge = new SitePermissionBridge(true);
  const { driver, observation } = await start(bridge);
  try {
    for (const name of [
      "midi",
      "midi_sysex",
      "sensors",
      "idle_detection",
      "local_fonts",
      "window_management",
    ]) {
      await expect(
        driver.dispatch(permission(observation, { permission: name, setting: "granted" })),
      ).rejects.toMatchObject({
        code: "unsupported",
        message:
          "In the person's own Chrome, only camera, microphone, geolocation and notifications permissions can be set.",
      });
    }
    expect(bridge.sitePermissionCommands()).toEqual([]);
  } finally {
    await driver.close();
  }
});

test("an extension from before site permissions is told apart without sending it the command", async () => {
  const bridge = new SitePermissionBridge(false);
  const { driver, observation } = await start(bridge);
  try {
    await expect(
      driver.dispatch(permission(observation, { permission: "microphone", setting: "granted" })),
    ).rejects.toMatchObject({
      code: "unsupported",
      message:
        "The browser extension in the person's Chrome is too old to set site permissions; Chrome updates it on its own.",
    });
    expect(bridge.sitePermissionCommands()).toEqual([{ type: "ping" }]);
  } finally {
    await driver.close();
  }
});

test("before the person allows it, the agent is told to wait for them", async () => {
  const bridge = new SitePermissionBridge(true, () => {
    throw new AttachedBrowserBridgeError(
      "driver_rejected",
      "the person has not allowed site permissions in this Chrome profile",
      false,
      { extensionCode: "consent_required" },
    );
  });
  const { driver, observation } = await start(bridge);
  try {
    await expect(
      driver.dispatch(permission(observation, { permission: "microphone", setting: "granted" })),
    ).rejects.toMatchObject({
      code: "permission_denied",
      retryable: false,
      message:
        "The person must allow site permissions once in their Chrome first. A tab asking them to has opened there; try again after they allow it.",
    });
  } finally {
    await driver.close();
  }
});

test("a tab that left the site before the extension set the permission is stale", async () => {
  const bridge = new SitePermissionBridge(true, () => {
    throw new AttachedBrowserBridgeError(
      "driver_rejected",
      "no controlled tab shows this site now",
      false,
      { extensionCode: "tab_changed" },
    );
  });
  const { driver, observation } = await start(bridge);
  try {
    await expect(
      driver.dispatch(permission(observation, { permission: "camera", setting: "denied" })),
    ).rejects.toMatchObject({
      code: "document_stale",
      retryable: true,
      message: "The tab left this site before the permission was set; observe the tab again.",
    });
  } finally {
    await driver.close();
  }
});
