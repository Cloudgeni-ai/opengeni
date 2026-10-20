// The bridge in each account's web app. Sandboxed preload: only `electron`'s
// renderer modules are available. The bridge exists only when the page is the
// account's own server; the main process checks the sender again on every call.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  DESKTOP_BRIDGE_GLOBAL,
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_IPC,
  type DesktopAccountsSnapshot,
  type DesktopAppShotResult,
  type DesktopAppShotStatus,
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
  // Captures go to the page's newest listener. One that arrives before the
  // page listens (the window was just opened for it) waits briefly for it.
  let appShotListener: ((result: DesktopAppShotResult) => void) | null = null;
  let waitingAppShot: { result: DesktopAppShotResult; at: number } | null = null;
  ipcRenderer.on(DESKTOP_IPC.appShotsCaptured, (_event, result: DesktopAppShotResult) => {
    if (appShotListener) appShotListener(result);
    else waitingAppShot = { result, at: Date.now() };
  });
  const bridge: DesktopBridge = {
    version: DESKTOP_BRIDGE_VERSION,
    platform: platform(),
    capabilities: [
      "accounts",
      "thisComputer",
      "thisComputerPermissions",
      "thisComputerDisconnect",
      "openExternal",
      "commands",
      "appShots",
    ],
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
      requestPermission: (id) => ipcRenderer.invoke(DESKTOP_IPC.computerRequestPermission, id),
      disconnect: (workspaceId) => ipcRenderer.invoke(DESKTOP_IPC.computerDisconnect, workspaceId),
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
    appShots: {
      status: () => ipcRenderer.invoke(DESKTOP_IPC.appShotsStatus) as Promise<DesktopAppShotStatus>,
      update: (settings) =>
        ipcRenderer.invoke(DESKTOP_IPC.appShotsUpdate, settings) as Promise<DesktopAppShotStatus>,
      requestPermission: (id) => ipcRenderer.invoke(DESKTOP_IPC.appShotsRequestPermission, id),
      onCapture: (listener) => {
        appShotListener = listener;
        const waiting = waitingAppShot;
        waitingAppShot = null;
        if (waiting && Date.now() - waiting.at < 60_000) {
          queueMicrotask(() => appShotListener?.(waiting.result));
        }
        return () => {
          if (appShotListener === listener) appShotListener = null;
        };
      },
      onChange: (listener) => subscribe(DESKTOP_IPC.appShotsChanged, () => listener()),
    },
  };
  contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_GLOBAL, bridge);
}
