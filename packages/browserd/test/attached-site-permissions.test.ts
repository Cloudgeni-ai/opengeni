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
/** A tab the person had open before the session started. */
const PERSON_PAGE = "https://mail.example.test/inbox";
const DEVICE = { deviceId: "device-1", connectionGeneration: "generation-1" };

/** A connected Chrome with the person's own tab (9) and the tab the agent
 * opens (7), whose extension sets site permissions the way `answer` says. */
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
        const person = {
          id: "9",
          title: "Inbox",
          active: true,
          controllable: true,
          url: PERSON_PAGE,
        };
        return (payload.type === "tabs.list" ? { tabs: [tab, person] } : { tab }) as T;
      }
      case "debugger.attach":
        return { attached: true, attachment: payload.tabId === "7" ? 5 : 6 } as T;
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
      case "Page.getFrameTree": {
        const tab = String(payload.tabId);
        const url = tab === "7" ? PAGE : PERSON_PAGE;
        return { frameTree: { frame: { id: `frame-${tab}`, loaderId: `loader-${tab}`, url } } };
      }
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
    attachments: DEVICE,
  });
  const driver = createAttachedChromeDriver(
    { browserSessionId: randomUUID(), controllerGeneration: `fixture-${randomUUID()}` },
    { connection, runner: new AttachedChromeRunner(bridge, connection) },
  );
  const observation = await driver.start();
  return { driver, observation, bridge, connection };
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
      // The exact tab, under this session's attachment to it.
      expect(bridge.sitePermissionCommands().at(-1)).toEqual({
        type: "permissions.set",
        tabId: "7",
        attachment: 5,
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

test("before the person allows it, the agent is told to ask them", async () => {
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
        "The person must allow site permissions once in their Chrome first. A tab asking them to is open there; ask them to allow it, then try again.",
    });
  } finally {
    await driver.close();
  }
});

test("after the person closed the page asking them, the agent is told to ask them where to allow it", async () => {
  const bridge = new SitePermissionBridge(true, () => {
    throw new AttachedBrowserBridgeError(
      "driver_rejected",
      "the person was asked and has not allowed site permissions in this Chrome profile",
      false,
      { extensionCode: "consent_declined" },
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
        "The person has not allowed site permissions in their Chrome. Ask them to allow it in the browser extension's popup, then try again.",
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

const NOT_OPENED_TAB =
  "A permission can be set only in a tab this session opened and no other session is using; open the site in a new tab and set it there.";

test("the person's own tab is refused even after the session observed it, and the extension is never asked", async () => {
  const bridge = new SitePermissionBridge(true);
  const { driver } = await start(bridge);
  try {
    const personTab = await driver.selectTarget("9");
    expect(personTab.target.id).toBe("9");
    for (const setting of ["granted", "denied", "prompt"]) {
      await expect(
        driver.dispatch(permission(personTab, { permission: "notifications", setting })),
      ).rejects.toMatchObject({ code: "permission_denied", message: NOT_OPENED_TAB });
    }
    expect(bridge.sitePermissionCommands()).toEqual([]);
  } finally {
    await driver.close();
  }
});

test("a tab the session opened is refused while another session is using it", async () => {
  const bridge = new SitePermissionBridge(true);
  const { driver, observation } = await start(bridge);
  // Another session in this browser holds Chrome's debugger on the same tab.
  const other = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "151.0.0.0",
    attachments: { ...DEVICE, inherited: ["7"] },
  });
  try {
    await expect(
      driver.dispatch(permission(observation, { permission: "camera", setting: "denied" })),
    ).rejects.toMatchObject({ code: "permission_denied", message: NOT_OPENED_TAB });
    expect(bridge.sitePermissionCommands()).toEqual([]);
  } finally {
    await other.close();
    await driver.close();
  }
});

test("the extension's other refusals tell the agent what happened and what to do", async () => {
  for (const [refusal, expected] of [
    [
      new AttachedBrowserBridgeError("driver_rejected", "only http and https sites", false, {
        extensionCode: "unsupported_site",
      }),
      {
        code: "unsupported",
        message:
          "In the person's own Chrome, permissions can be set only for http and https sites with a plain host name or IP address.",
      },
    ],
    [
      new AttachedBrowserBridgeError("driver_rejected", "agents already set 1000", false, {
        extensionCode: "limit_reached",
      }),
      {
        code: "invalid_action",
        message:
          "Agents have already set 1,000 site permissions in the person's Chrome; set ones no longer needed back to prompt, or ask the person to remove some in the extension's popup.",
      },
    ],
    [
      new AttachedBrowserBridgeError("invalid_request", "bridge command is malformed", false),
      {
        code: "invalid_action",
        message:
          "The browser extension in the person's Chrome refused this permission request; nothing was set.",
      },
    ],
    [
      // The extension's own check that an agent opened the tab.
      new AttachedBrowserBridgeError("driver_rejected", "not a tab an agent opened", false, {
        extensionCode: "not_opened_by_agent",
      }),
      { code: "permission_denied", message: NOT_OPENED_TAB },
    ],
  ] as const) {
    const bridge = new SitePermissionBridge(true, () => {
      throw refusal;
    });
    const { driver, observation } = await start(bridge);
    try {
      await expect(
        driver.dispatch(permission(observation, { permission: "camera", setting: "granted" })),
      ).rejects.toMatchObject({ ...expected, retryable: false });
    } finally {
      await driver.close();
    }
  }
});
