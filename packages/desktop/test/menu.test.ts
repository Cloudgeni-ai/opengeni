import { afterEach, describe, expect, mock, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";

import { electronStub } from "./electron-stub";

mock.module("electron", () => electronStub);

const { applicationMenuTemplate, macMenuLabel, readMenuActions, updateMenuItem } =
  await import("../src/main/menu");
type Model = Parameters<typeof applicationMenuTemplate>[0];

const realPlatform = process.platform;
function onPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}
afterEach(() => onPlatform(realPlatform));

function model(updates: Model["updates"]): Model {
  return {
    productName: "Product",
    accounts: [],
    switchTo: () => undefined,
    addAccount: () => undefined,
    signOut: null,
    openSettings: null,
    command: null,
    updates,
    contents: () => null,
  };
}

function submenu(template: MenuItemConstructorOptions[], label: string) {
  const menu = template.find((item) => item.label === label);
  return (menu?.submenu ?? []) as MenuItemConstructorOptions[];
}

describe("update menu item", () => {
  const run = () => undefined;
  test("follows the check, download and restart steps", () => {
    expect(updateMenuItem({ state: { kind: "idle" }, run })).toMatchObject({
      label: "Check for Updates…",
    });
    expect(updateMenuItem({ state: { kind: "checking" }, run })).toMatchObject({
      label: "Checking for Updates…",
      enabled: false,
    });
    expect(updateMenuItem({ state: { kind: "downloading", version: "1.2.0" }, run })).toMatchObject(
      { label: "Downloading 1.2.0…", enabled: false },
    );
    const ready = updateMenuItem({ state: { kind: "ready", version: "1.2.0" }, run });
    expect(ready.label).toBe("Restart to Update to 1.2.0");
    expect(ready.enabled).not.toBe(false);
  });
});

describe("application menu", () => {
  const updates = { state: { kind: "idle" as const }, run: () => undefined };

  test("macOS puts updates under the app menu and leaves full screen to the system", () => {
    onPlatform("darwin");
    const template = applicationMenuTemplate(model(updates));
    const appMenu = submenu(template, "Product").map((item) => item.label ?? item.role);
    expect(appMenu.slice(0, 2)).toEqual(["about", "Check for Updates…"]);
    expect(submenu(template, "View").some((item) => item.role === "togglefullscreen")).toBe(false);
    expect(template.some((item) => item.label === "&Help")).toBe(false);
  });

  test("Windows and Linux get a Help menu and their own full screen item", () => {
    onPlatform("linux");
    const template = applicationMenuTemplate(model(updates));
    expect(submenu(template, "&Help").map((item) => item.label)).toEqual(["Check for Updates…"]);
    expect(submenu(template, "View").some((item) => item.role === "togglefullscreen")).toBe(true);
  });

  test("builds without updates leave the item out", () => {
    onPlatform("linux");
    const template = applicationMenuTemplate(model(null));
    expect(template.some((item) => item.label === "&Help")).toBe(false);
  });
});

describe("page actions in the menu bar", () => {
  const actions = [
    {
      id: "chat.new",
      label: "New chat",
      section: "file",
      accelerator: "CmdOrCtrl+N",
      enabled: true,
    },
    {
      id: "commandMenu.open",
      label: "Command menu",
      section: "go",
      accelerator: "CmdOrCtrl+K",
      enabled: true,
    },
    {
      id: "chat.copyLink",
      label: "Copy link",
      section: "chat",
      accelerator: "CmdOrCtrl+Shift+,",
      enabled: false,
    },
    {
      id: "help.shortcuts",
      label: "Keyboard shortcuts",
      section: "help",
      accelerator: "CmdOrCtrl+/",
      enabled: true,
    },
  ];

  test("reads well-formed actions and rejects anything else whole", () => {
    expect(readMenuActions(actions)).toHaveLength(4);
    expect(readMenuActions([])).toEqual([]);
    expect(readMenuActions("nope")).toBeNull();
    expect(readMenuActions([{ ...actions[0], section: "window" }])).toBeNull();
    expect(readMenuActions([{ ...actions[0], accelerator: "CmdOrCtrl+Q; rm" }])).toBeNull();
    expect(readMenuActions([actions[0], actions[0]])).toBeNull();
    expect(readMenuActions([{ ...actions[0], accelerator: null }])).toHaveLength(1);
  });

  test("replace the built-in commands and add Go, Chat and Help menus", () => {
    onPlatform("darwin");
    const ran: string[] = [];
    const template = applicationMenuTemplate({
      ...model(null),
      command: () => undefined,
      pageActions: readMenuActions(actions),
      runPageAction: (id) => ran.push(id),
    });
    const file = submenu(template, "File");
    expect(file[0]).toMatchObject({ label: "New Chat", accelerator: "CmdOrCtrl+N" });
    expect(submenu(template, "View").some((item) => item.label === "Search Sessions…")).toBe(false);
    const go = submenu(template, "Go").map((item) => item.label ?? item.type);
    expect(go).toEqual(["Command Menu", "separator", "Back", "Forward"]);
    const chat = submenu(template, "Chat");
    expect(chat[0]).toMatchObject({ label: "Copy Link", enabled: false });
    const help = template.find((item) => item.role === "help");
    const helpItems = (help?.submenu ?? []) as MenuItemConstructorOptions[];
    expect(helpItems[0]?.label).toBe("Keyboard Shortcuts");
    (file[0]!.click as () => void)();
    expect(ran).toEqual(["chat.new"]);
  });

  test("pages without actions keep the built-in commands", () => {
    onPlatform("darwin");
    const template = applicationMenuTemplate({ ...model(null), pageActions: null });
    expect(submenu(template, "View").some((item) => item.label === "Search Sessions…")).toBe(true);
    expect(template.some((item) => item.label === "Go")).toBe(false);
  });

  test("Zoom In answers to the + key as well as =", () => {
    onPlatform("darwin");
    const view = submenu(applicationMenuTemplate(model(null)), "View");
    const zoomIn = view.filter((item) => item.label === "Zoom In");
    expect(zoomIn.map((item) => [item.accelerator, item.visible ?? true])).toEqual([
      ["CmdOrCtrl+Plus", true],
      ["CmdOrCtrl+=", false],
    ]);
  });

  test("macOS menus use title case", () => {
    expect(macMenuLabel("Pin or unpin chat")).toBe("Pin or Unpin Chat");
    expect(macMenuLabel("Search messages")).toBe("Search Messages");
  });
});
