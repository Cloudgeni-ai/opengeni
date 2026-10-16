import { expect, test } from "bun:test";
import { InteractionDefiniteDriverError } from "@opengeni/interaction";
import { AgentBrowserDriver } from "../src";
import {
  AttachedChromeCdpConnection,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";

type Tab = { id: string; title: string; url: string; active: boolean; controllable: boolean };

/** Chrome as the extension sees it: a navigation to a page the extension may
 * not control lands there, and Chrome detaches the debugger mid-command. */
class RefusingChrome implements AttachedBrowserBridgeTransport {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly tabs: Tab[] = [
    {
      id: "7",
      title: "User work",
      url: "https://example.com/",
      active: true,
      controllable: true,
    },
  ];
  private readonly events: Array<Record<string, unknown>> = [];
  private sequence = 0;
  closeTabDuringNavigation = false;
  cancelDuringNavigation = false;

  async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    this.commands.push({ ...payload });
    switch (payload.type) {
      case "tabs.list":
        return { tabs: this.tabs.map((tab) => ({ ...tab })) } as T;
      case "tabs.create": {
        const tab = {
          id: String(100 + this.tabs.length),
          title: "",
          url: String(payload.url),
          active: false,
          controllable: true,
        };
        this.tabs.push(tab);
        return { tab } as T;
      }
      case "tabs.close":
        this.tabs.splice(
          this.tabs.findIndex((tab) => tab.id === payload.tabId),
          1,
        );
        return { tabs: this.tabs } as T;
      case "debugger.attach":
        return { attached: true } as T;
      case "debugger.detach":
        return { detached: true } as T;
      case "debugger.poll": {
        const events = this.events.filter(
          (event) => (event.sequence as number) > (payload.afterSequence as number),
        );
        return { events, cursor: this.sequence, truncated: false } as T;
      }
      case "debugger.command": {
        if (payload.method !== "Page.navigate") return { result: {} } as T;
        // The page redirected somewhere the extension may not control.
        const tab = this.tabs.find((candidate) => candidate.id === payload.tabId)!;
        Object.assign(tab, { url: "https://chromewebstore.google.com/", controllable: false });
        if (this.closeTabDuringNavigation) this.tabs.splice(this.tabs.indexOf(tab), 1);
        this.events.push({
          sequence: ++this.sequence,
          tabId: payload.tabId,
          sessionId: null,
          method: "OpenGeni.debuggerDetached",
          params: { reason: this.cancelDuringNavigation ? "canceled_by_user" : "target_closed" },
        });
        throw new Error("Detached while handling command.");
      }
      default:
        return {} as T;
    }
  }

  close(): void {}
}

function connect(chrome: RefusingChrome): AttachedChromeCdpConnection {
  return new AttachedChromeCdpConnection(chrome, { browserName: "Chrome", browserVersion: "151" });
}

test.each([
  "https://chromewebstore.google.com/detail/x",
  "https://chrome.google.com/webstore/",
  "chrome://settings/",
  "CHROME-EXTENSION://abc/page.html",
  "about:config",
])("refuses %s before a tab is created or navigated", async (url) => {
  const chrome = new RefusingChrome();
  const connection = connect(chrome);
  try {
    const created = await connection
      .send("Target.createTarget", { url })
      .catch((error: unknown) => error);
    expect(created).toBeInstanceOf(InteractionDefiniteDriverError);
    expect(created).toMatchObject({ code: "unsupported", retryable: false });
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
    });
    await expect(connection.send("Page.navigate", { url }, { sessionId })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(chrome.commands.map((command) => command.type)).not.toContain("tabs.create");
    expect(chrome.commands.map((command) => command.method)).not.toContain("Page.navigate");
  } finally {
    connection.close();
  }
});

test("a navigation Chrome ends control of is a definite unsupported failure", async () => {
  const chrome = new RefusingChrome();
  const connection = connect(chrome);
  try {
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
    });
    const failure = await connection
      .send("Page.navigate", { url: "https://example.com/to-store" }, { sessionId })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InteractionDefiniteDriverError);
    expect(failure).toMatchObject({ code: "unsupported", retryable: false });
    expect((failure as Error).message).toContain("Chrome ended control of this tab");
  } finally {
    connection.close();
  }
});

test.each([
  ["closed the tab", { closeTabDuringNavigation: true }],
  ["canceled debugging", { cancelDuringNavigation: true }],
] as const)("a navigation failure is not called refused when the user %s", async (_, change) => {
  const chrome = Object.assign(new RefusingChrome(), change);
  const connection = connect(chrome);
  try {
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
    });
    const failure = await connection
      .send("Page.navigate", { url: "https://example.com/to-store" }, { sessionId })
      .catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(InteractionDefiniteDriverError);
  } finally {
    connection.close();
  }
});

test.each([undefined, "chrome://settings/"])(
  "the driver refuses a restricted page before creating a tab (open %p)",
  async (openUrl) => {
    const chrome = new RefusingChrome();
    const connection = connect(chrome);
    const driver = new AgentBrowserDriver({
      browserSessionId: crypto.randomUUID(),
      controllerGeneration: "restricted-page-test",
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
      const failure = await (
        openUrl ? driver.openTarget(openUrl) : driver.start("https://chromewebstore.google.com/")
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "unsupported" });
      expect(chrome.commands.map((command) => command.type)).not.toContain("tabs.create");
      expect(chrome.tabs.map((tab) => tab.id)).toEqual(["7"]);
    } finally {
      connection.close();
    }
  },
);
