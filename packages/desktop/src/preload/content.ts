// The bridge in each account's web app. Sandboxed preload: only `electron`'s
// renderer modules are available. The bridge exists only when the page is the
// account's own server; the main process checks the sender again on every call.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  DESKTOP_BRIDGE_GLOBAL,
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_IPC,
  type DesktopAccountsSnapshot,
  type DesktopBridge,
  type DesktopCommand,
  type DesktopPlatform,
  type ThisComputerStatus,
} from "../contract";

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function platform(): DesktopPlatform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const origin = argument("opengeni-origin");

if (origin && window.location.origin === origin) {
  // Menu commands go to the page's newest listener. A page without one (an
  // older server) still gets the navigation commands as a page load.
  let commandListener: ((command: DesktopCommand) => void) | null = null;
  ipcRenderer.on(DESKTOP_IPC.command, (_event, command: DesktopCommand) => {
    if (commandListener) {
      commandListener(command);
      return;
    }
    const workspaceId = /^\/workspaces\/([0-9a-f-]{36})(?:\/|$)/iu.exec(
      window.location.pathname,
    )?.[1];
    if (!workspaceId) return;
    if (command === "newSession") window.location.assign(`/workspaces/${workspaceId}/sessions`);
    if (command === "openInbox") window.location.assign(`/workspaces/${workspaceId}/inbox`);
  });
  const bridge: DesktopBridge = {
    version: DESKTOP_BRIDGE_VERSION,
    platform: platform(),
    capabilities: ["accounts", "thisComputer", "openExternal", "commands"],
    productName: argument("opengeni-product") ?? "Opengeni",
    accounts: {
      list: () => ipcRenderer.invoke(DESKTOP_IPC.accountsList) as Promise<DesktopAccountsSnapshot>,
      switchTo: (accountId) => ipcRenderer.invoke(DESKTOP_IPC.accountsSwitch, accountId),
      add: () => ipcRenderer.invoke(DESKTOP_IPC.accountsAdd),
      signOut: (accountId) => ipcRenderer.invoke(DESKTOP_IPC.accountsSignOut, accountId),
      setWorkspace: (workspaceId) =>
        ipcRenderer.send(DESKTOP_IPC.accountsSetWorkspace, workspaceId),
      restoreWebSession: () =>
        ipcRenderer.invoke(DESKTOP_IPC.accountsRestoreWebSession) as Promise<boolean>,
      onChange: (listener) => subscribe(DESKTOP_IPC.accountsChanged, listener),
    },
    thisComputer: {
      status: (workspaceId) =>
        ipcRenderer.invoke(DESKTOP_IPC.computerStatus, workspaceId) as Promise<ThisComputerStatus>,
      connect: (workspaceId, options) =>
        ipcRenderer.invoke(DESKTOP_IPC.computerConnect, workspaceId, {
          screenControl: Boolean(options.screenControl),
        }) as Promise<ThisComputerStatus>,
      pause: () => ipcRenderer.invoke(DESKTOP_IPC.computerPause),
      resume: () => ipcRenderer.invoke(DESKTOP_IPC.computerResume),
      onChange: (listener) => subscribe(DESKTOP_IPC.computerChanged, () => listener()),
    },
    openExternal: (url) => ipcRenderer.invoke(DESKTOP_IPC.openExternal, url),
    commands: {
      onCommand: (listener) => {
        commandListener = listener;
        return () => {
          if (commandListener === listener) commandListener = null;
        };
      },
    },
    setAppearance: (appearance) => ipcRenderer.send(DESKTOP_IPC.appearanceSet, appearance),
  };
  contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_GLOBAL, bridge);
}
