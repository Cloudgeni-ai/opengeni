import { afterEach, describe, expect, mock, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";

import { electronStub } from "./electron-stub";

mock.module("electron", () => electronStub);

const { applicationMenuTemplate, updateMenuItem } = await import("../src/main/menu");
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
