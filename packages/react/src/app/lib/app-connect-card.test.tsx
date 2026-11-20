import { describe, expect, test } from "bun:test";
import type { ToolGatewaySiteSetupItem } from "@opengeni/sdk";
import { actRun, registerDom, renderComponent } from "../../../test/render-hook";

registerDom();
const { AppConnectCardView, runSiteConnectCardItem } = await import("./app-connect-card");

const connect: ToolGatewaySiteSetupItem = {
  key: "connect:Gmail:",
  action: "connect",
  connector: "Gmail",
  capabilityId: "capability-gmail",
  connectionId: null,
  account: null,
  shared: false,
  tools: [{ serverId: "gmail", toolName: "send_message" }],
  openUrl: null,
};
const reconnect: ToolGatewaySiteSetupItem = {
  ...connect,
  key: "reconnect:Google Calendar:ada@example.com",
  action: "reconnect",
  connector: "Google Calendar",
  capabilityId: "capability-calendar",
  connectionId: "connection-1",
  account: "ada@example.com",
  shared: true,
};

describe("the App connect card", () => {
  test("one button per tool to connect, and a close button; nothing when all is ready", async () => {
    const clicked: string[] = [];
    let dismissed = 0;
    const view = await renderComponent(
      <AppConnectCardView
        items={[connect, reconnect]}
        onConnect={(key) => clicked.push(key)}
        onDismiss={() => {
          dismissed += 1;
        }}
      />,
    );
    const card = document.body.querySelector<HTMLElement>("[data-app-connect-card]")!;
    expect(card.getAttribute("aria-label")).toBe("Connect tools for this app");
    const buttons = [...card.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Connect Gmail", "Reconnect Google Calendar", ""]);
    await actRun(() => card.querySelectorAll("button")[1]!.click());
    await actRun(() => card.querySelector<HTMLButtonElement>("[aria-label=Dismiss]")!.click());
    expect(clicked).toEqual([reconnect.key]);
    expect(dismissed).toBe(1);
    await view.unmount();

    const empty = await renderComponent(
      <AppConnectCardView items={[]} onConnect={() => undefined} onDismiss={() => undefined} />,
    );
    expect(document.body.querySelector("[data-app-connect-card]")).toBeNull();
    await empty.unmount();
  });

  test("Connect and Reconnect open the console's own dialogs for that capability and account", async () => {
    const seen: unknown[] = [];
    const consent = {
      connectForToolCall: async (prompt: unknown) => {
        seen.push(prompt);
        return true;
      },
      recoverToolCall: async (prompt: unknown) => {
        seen.push(prompt);
        return true;
      },
    };
    const signal = new AbortController().signal;
    expect(await runSiteConnectCardItem(consent, "workspace", connect, signal)).toBe(true);
    expect(await runSiteConnectCardItem(consent, "workspace", reconnect, signal)).toBe(true);
    expect(seen[0]).toMatchObject({
      connect: { capabilityId: "capability-gmail", name: "Gmail" },
      workspaceId: "workspace",
    });
    expect(seen[1]).toMatchObject({
      failure: {
        reconnect: {
          connectionId: "connection-1",
          capabilityId: "capability-calendar",
          shared: true,
        },
      },
      workspaceId: "workspace",
    });
    // Nothing to connect with: no dialog.
    expect(
      await runSiteConnectCardItem(
        consent,
        "workspace",
        { ...connect, capabilityId: null },
        signal,
      ),
    ).toBe(false);
    expect(seen).toHaveLength(2);
  });
});
