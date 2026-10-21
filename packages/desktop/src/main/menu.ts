import { app, Menu, type MenuItemConstructorOptions, type WebContents } from "electron";

import type { DesktopCommand } from "../contract";
import type { UpdateMenuState } from "./updates";

export interface MenuModel {
  productName: string;
  accounts: Array<{ id: string; label: string; active: boolean }>;
  switchTo(accountId: string): void;
  addAccount(): void;
  signOut: (() => void) | null;
  openSettings: (() => void) | null;
  /** Ask the signed-in page to carry out a command; null while no account shows. */
  command: ((command: DesktopCommand) => void) | null;
  /** App updates; null when this build doesn't update itself. */
  updates: { state: UpdateMenuState; run(): void } | null;
  /** The page the window shows now, for navigation and reload. */
  contents(): WebContents | null;
}

/** The update item reads like the Mac convention: check, progress, then restart. */
export function updateMenuItem(
  updates: NonNullable<MenuModel["updates"]>,
): MenuItemConstructorOptions {
  const { state } = updates;
  switch (state.kind) {
    case "checking":
      return { label: "Checking for Updates…", enabled: false };
    case "downloading":
      return { label: `Downloading ${state.version}…`, enabled: false };
    case "ready":
      return { label: `Restart to Update to ${state.version}`, click: () => updates.run() };
    case "idle":
      return { label: "Check for Updates…", click: () => updates.run() };
  }
}

/**
 * The menu bar: standard roles, the everyday commands with their usual
 * shortcuts (new session, search, sidebar, inbox), history, accounts and the
 * workspace settings, which open in the window.
 */
export function buildApplicationMenu(model: MenuModel): Menu {
  return Menu.buildFromTemplate(applicationMenuTemplate(model));
}

export function applicationMenuTemplate(model: MenuModel): MenuItemConstructorOptions[] {
  const mac = process.platform === "darwin";
  const update = model.updates ? [updateMenuItem(model.updates)] : [];
  const withContents = (action: (contents: WebContents) => void) => () => {
    const contents = model.contents();
    if (contents && !contents.isDestroyed()) action(contents);
  };
  const command = (
    label: string,
    name: DesktopCommand,
    accelerator: string,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    enabled: Boolean(model.command),
    click: () => model.command?.(name),
  });
  const newSession = command("New Session", "newSession", "CmdOrCtrl+N");
  const settings: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    enabled: Boolean(model.openSettings),
    click: () => model.openSettings?.(),
  };
  const accounts: MenuItemConstructorOptions[] = [
    ...model.accounts.map(
      (account, index): MenuItemConstructorOptions => ({
        label: account.label,
        type: "radio",
        checked: account.active,
        ...(index < 9 ? { accelerator: `CmdOrCtrl+Alt+${index + 1}` } : {}),
        click: () => model.switchTo(account.id),
      }),
    ),
    ...(model.accounts.length > 0 ? [{ type: "separator" as const }] : []),
    { label: "Add Account…", click: () => model.addAccount() },
    {
      label: "Sign Out",
      enabled: Boolean(model.signOut),
      click: () => model.signOut?.(),
    },
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: model.productName,
            submenu: [
              { role: "about" as const },
              ...update,
              { type: "separator" as const },
              settings,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
          {
            label: "File",
            submenu: [newSession, { type: "separator" as const }, { role: "close" as const }],
          },
        ]
      : [
          {
            label: "&File",
            submenu: [
              newSession,
              { type: "separator" as const },
              settings,
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        command("Toggle Sidebar", "toggleSidebar", mac ? "Ctrl+Cmd+S" : "Ctrl+Shift+S"),
        { type: "separator" },
        command("Search Sessions…", "searchSessions", "CmdOrCtrl+K"),
        command("Inbox", "openInbox", "CmdOrCtrl+Shift+I"),
        { type: "separator" },
        {
          label: "Back",
          accelerator: mac ? "Cmd+[" : "Alt+Left",
          click: withContents((contents) => contents.navigationHistory.goBack()),
        },
        {
          label: "Forward",
          accelerator: mac ? "Cmd+]" : "Alt+Right",
          click: withContents((contents) => contents.navigationHistory.goForward()),
        },
        { type: "separator" },
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: withContents((contents) => contents.reload()),
        },
        ...(app.isPackaged
          ? []
          : [
              {
                label: "Developer Tools",
                accelerator: mac ? "Alt+Cmd+I" : "F12",
                click: withContents((contents) => contents.toggleDevTools()),
              },
            ]),
        { type: "separator" },
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: withContents((contents) => contents.setZoomLevel(0)),
        },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          click: withContents((contents) => contents.setZoomLevel(contents.getZoomLevel() + 0.5)),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: withContents((contents) => contents.setZoomLevel(contents.getZoomLevel() - 0.5)),
        },
        // macOS adds its own Enter Full Screen item to the View menu.
        ...(mac ? [] : [{ type: "separator" as const }, { role: "togglefullscreen" as const }]),
      ],
    },
    { label: "Account", submenu: accounts },
    { role: "windowMenu" },
    ...(!mac && update.length > 0 ? [{ label: "&Help", submenu: update }] : []),
  ];
  return template;
}
