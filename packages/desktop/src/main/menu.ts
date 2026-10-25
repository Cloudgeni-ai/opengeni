import { app, Menu, type MenuItemConstructorOptions, type WebContents } from "electron";

import type { DesktopCommand, DesktopMenuAction, DesktopMenuSection } from "../contract";
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
  /**
   * The page's own actions, with their names and keys; the menu bar shows
   * them in place of its built-in commands. Null for pages that don't list
   * actions (older servers), which keep the built-in commands.
   */
  pageActions?: readonly DesktopMenuAction[] | null;
  /** Run one of the page's actions. */
  runPageAction?: (id: string) => void;
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

const SECTIONS: ReadonlySet<DesktopMenuSection> = new Set(["file", "view", "go", "chat", "help"]);
const ACCELERATOR =
  /^(?:(?:CmdOrCtrl|Cmd|Ctrl|Alt|Shift|Super)\+){0,4}(?:[A-Z0-9]|F[0-9]{1,2}|Up|Down|Left|Right|Return|Escape|Tab|Space|Backspace|[,./;'[\]\\=`-])$/u;
const MAX_PAGE_ACTIONS = 48;

/**
 * Reads the actions a page reports for the menu bar. Anything malformed is
 * dropped whole: a page can name and order its own items, never more.
 */
export function readMenuActions(value: unknown): DesktopMenuAction[] | null {
  if (!Array.isArray(value) || value.length > MAX_PAGE_ACTIONS) return null;
  const actions: DesktopMenuAction[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { id, label, section, accelerator, enabled } = item as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z][\w.-]{0,63}$/iu.test(id) || ids.has(id)) return null;
    if (typeof label !== "string" || !label.trim() || label.length > 80) return null;
    if (typeof section !== "string" || !SECTIONS.has(section as DesktopMenuSection)) return null;
    if (accelerator !== null && (typeof accelerator !== "string" || !ACCELERATOR.test(accelerator)))
      return null;
    if (typeof enabled !== "boolean") return null;
    ids.add(id);
    actions.push({
      id,
      label: label.trim(),
      section: section as DesktopMenuSection,
      accelerator,
      enabled,
    });
  }
  return actions;
}

const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
]);

/** macOS menus use title case ("Copy Link"); the page names actions in sentence case. */
export function macMenuLabel(label: string): string {
  return label
    .split(" ")
    .map((word, index) =>
      index > 0 && SMALL_WORDS.has(word.toLowerCase())
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

/**
 * The menu bar: standard roles, the page's actions with their keys (or the
 * built-in commands for pages that don't list them), history, accounts and
 * the workspace settings, which open in the window.
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
  const zoomIn = withContents((contents) => contents.setZoomLevel(contents.getZoomLevel() + 0.5));
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
  const pageActions = model.pageActions && model.pageActions.length > 0 ? model.pageActions : null;
  const page = (section: DesktopMenuSection): MenuItemConstructorOptions[] =>
    (pageActions ?? [])
      .filter((action) => action.section === section)
      .map((action) => ({
        label: mac ? macMenuLabel(action.label) : action.label,
        ...(action.accelerator ? { accelerator: action.accelerator } : {}),
        enabled: action.enabled,
        click: () => model.runPageAction?.(action.id),
      }));
  const withSeparator = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    items.length > 0 ? [...items, { type: "separator" }] : [];
  const fileItems = pageActions ? page("file") : [newSession];
  const history: MenuItemConstructorOptions[] = [
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
  ];
  const helpItems = pageActions ? page("help") : [];
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
            submenu: [...withSeparator(fileItems), { role: "close" as const }],
          },
        ]
      : [
          {
            label: "&File",
            submenu: [
              ...withSeparator(fileItems),
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
        ...(pageActions
          ? withSeparator(page("view"))
          : [
              command("Toggle Sidebar", "toggleSidebar", mac ? "Ctrl+Cmd+S" : "Ctrl+Shift+S"),
              { type: "separator" as const },
              command("Search Sessions…", "searchSessions", "CmdOrCtrl+K"),
              command("Inbox", "openInbox", "CmdOrCtrl+Shift+I"),
              { type: "separator" as const },
              ...history,
              { type: "separator" as const },
            ]),
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
        // Keyboards with their own + key (Nordic, German and others) type + without
        // Shift, so Zoom In answers to it; = stays as the key US keyboards share with +.
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: zoomIn },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: zoomIn, visible: false },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: withContents((contents) => contents.setZoomLevel(contents.getZoomLevel() - 0.5)),
        },
        // macOS adds its own Enter Full Screen item to the View menu.
        ...(mac ? [] : [{ type: "separator" as const }, { role: "togglefullscreen" as const }]),
      ],
    },
    // With the page's actions: a Go menu (the command menu, inbox, history)
    // and a Chat menu for the chat on screen.
    ...(pageActions
      ? [
          { label: mac ? "Go" : "&Go", submenu: [...withSeparator(page("go")), ...history] },
          ...(page("chat").length > 0
            ? [{ label: mac ? "Chat" : "&Chat", submenu: page("chat") }]
            : []),
        ]
      : []),
    { label: "Account", submenu: accounts },
    { role: "windowMenu" },
    ...(mac
      ? helpItems.length > 0
        ? [{ role: "help" as const, submenu: helpItems }]
        : []
      : helpItems.length > 0 || update.length > 0
        ? [
            {
              label: "&Help",
              submenu: [
                ...helpItems,
                ...(helpItems.length > 0 && update.length > 0
                  ? [{ type: "separator" as const }]
                  : []),
                ...update,
              ],
            },
          ]
        : []),
  ];
  return template;
}
