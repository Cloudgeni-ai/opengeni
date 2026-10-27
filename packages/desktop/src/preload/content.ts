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
  type DesktopComputerCapabilities,
  type DesktopMeetingDetectionStatus,
  type DesktopMeetingRequest,
  type DesktopMenuAction,
  type DesktopPlatform,
  type DesktopUpdateState,
  type ThisComputerStatus,
} from "../contract";
import { systemAudioBridge } from "./system-audio";

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
const systemAudio = process.argv.includes("--opengeni-system-audio");

if (origin && window.location.origin === origin) {
  // Menu commands go to the page's newest listener. A page without one (an
  // older server) still gets the navigation commands as a page load.
  let commandListener: ((command: DesktopCommand) => void) | null = null;
  ipcRenderer.on(
    DESKTOP_IPC.command,
    (_event, command: DesktopCommand, fallbackPath: string | null | undefined) => {
      if (commandListener) {
        commandListener(command);
        return;
      }
      // The shell's page for the command, on this origin only.
      if (typeof fallbackPath === "string" && /^\/(?![/\\])/u.test(fallbackPath))
        window.location.assign(fallbackPath);
    },
  );
  // Menu bar actions: the page lists them, the shell runs the chosen one back
  // through the newest listener. Leaving the page drops its actions, so the
  // menu falls back to its own items until the next page reports again.
  let menuActionListener: ((id: string) => void) | null = null;
  let reportedMenuActions = false;
  ipcRenderer.on(DESKTOP_IPC.menuAction, (_event, id: string) => {
    menuActionListener?.(id);
  });
  window.addEventListener("pagehide", () => {
    if (reportedMenuActions) ipcRenderer.send(DESKTOP_IPC.menuActionsSet, []);
  });
  // Captures go to the page's newest listener. One that arrives before the
  // page listens (the window was just opened for it) waits briefly for it.
  let appShotListener: ((result: DesktopAppShotResult) => void) | null = null;
  let waitingAppShot: { result: DesktopAppShotResult; at: number } | null = null;
  ipcRenderer.on(DESKTOP_IPC.appShotsCaptured, (_event, result: DesktopAppShotResult) => {
    if (appShotListener) appShotListener(result);
    else waitingAppShot = { result, at: Date.now() };
  });
  // Likewise a meeting notification's choice, which can arrive as the page loads.
  let meetingListener: ((request: DesktopMeetingRequest) => void) | null = null;
  let waitingMeeting: { request: DesktopMeetingRequest; at: number } | null = null;
  ipcRenderer.on(DESKTOP_IPC.meetingDetectionRequest, (_event, request: DesktopMeetingRequest) => {
    if (meetingListener) meetingListener(request);
    else waitingMeeting = { request, at: Date.now() };
  });
  const appVersion = argument("opengeni-app-version");
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
      "menuActions",
      "updates",
      ...(systemAudio ? (["systemAudio"] as const) : []),
      ...(systemAudio ? (["meetingDetection"] as const) : []),
      "computerCapabilities",
      "captureWindow",
    ],
    productName: argument("opengeni-product") ?? "Opengeni",
    ...(appVersion ? { appVersion } : {}),
    captureWindow: () => ipcRenderer.invoke(DESKTOP_IPC.captureWindow),
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
    menuActions: {
      set: (actions: DesktopMenuAction[]) => {
        reportedMenuActions = true;
        ipcRenderer.send(DESKTOP_IPC.menuActionsSet, actions);
      },
      onAction: (listener) => {
        menuActionListener = listener;
        return () => {
          if (menuActionListener === listener) menuActionListener = null;
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
    updates: {
      state: () => ipcRenderer.invoke(DESKTOP_IPC.updatesState) as Promise<DesktopUpdateState>,
      install: () => ipcRenderer.invoke(DESKTOP_IPC.updatesInstall),
      onChange: (listener) => subscribe(DESKTOP_IPC.updatesChanged, listener),
    },
    ...(systemAudio
      ? {
          systemAudio: systemAudioBridge(ipcRenderer),
          meetingDetection: {
            status: () =>
              ipcRenderer.invoke(
                DESKTOP_IPC.meetingDetectionStatus,
              ) as Promise<DesktopMeetingDetectionStatus>,
            update: (change: { enabled?: boolean }) =>
              ipcRenderer.invoke(
                DESKTOP_IPC.meetingDetectionUpdate,
                change,
              ) as Promise<DesktopMeetingDetectionStatus>,
            setRecording: (recording: boolean) =>
              ipcRenderer.send(DESKTOP_IPC.meetingDetectionRecording, recording),
            onRequest: (listener: (request: DesktopMeetingRequest) => void) => {
              meetingListener = listener;
              const waiting = waitingMeeting;
              waitingMeeting = null;
              if (waiting && Date.now() - waiting.at < 60_000) {
                queueMicrotask(() => meetingListener?.(waiting.request));
              }
              return () => {
                if (meetingListener === listener) meetingListener = null;
              };
            },
            onChange: (listener: () => void) =>
              subscribe(DESKTOP_IPC.meetingDetectionChanged, () => listener()),
          },
        }
      : {}),
    computerCapabilities: {
      status: () =>
        ipcRenderer.invoke(DESKTOP_IPC.capabilitiesStatus) as Promise<DesktopComputerCapabilities>,
      update: (change) =>
        ipcRenderer.invoke(
          DESKTOP_IPC.capabilitiesUpdate,
          change,
        ) as Promise<DesktopComputerCapabilities>,
      requestMicrophone: () =>
        ipcRenderer.invoke(
          DESKTOP_IPC.capabilitiesRequestMicrophone,
        ) as Promise<DesktopComputerCapabilities>,
      onChange: (listener) => subscribe(DESKTOP_IPC.capabilitiesChanged, () => listener()),
    },
  };
  contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_GLOBAL, bridge);
}
