import { app, Menu, type MenuItemConstructorOptions, type WebContents } from "electron";

export interface MenuModel {
  productName: string;
  accounts: Array<{ id: string; label: string; active: boolean }>;
  switchTo(accountId: string): void;
  addAccount(): void;
  signOut: (() => void) | null;
  openSettings: (() => void) | null;
  /** The page the window shows now, for navigation and reload. */
  contents(): WebContents | null;
}

/** The menu bar: standard roles plus accounts, history and settings on the web. */
export function buildApplicationMenu(model: MenuModel): Menu {
  const mac = process.platform === "darwin";
  const withContents = (action: (contents: WebContents) => void) => () => {
    const contents = model.contents();
    if (contents && !contents.isDestroyed()) action(contents);
  };
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
        ]
      : [
          {
            label: "&File",
            submenu: [settings, { type: "separator" as const }, { role: "quit" as const }],
          },
        ]),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
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
                accelerator: mac ? "Alt+Cmd+I" : "Ctrl+Shift+I",
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
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { label: "Account", submenu: accounts },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}
