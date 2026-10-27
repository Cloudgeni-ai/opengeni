// Dictation from anywhere, in a preload script. The Opengeni desktop shell
// puts it on its bridge; any other Electron app that embeds Opengeni defines
// it with exposeDictation() and answers it in the main process with
// handleDictationIpc() from `@opengeni/desktop/dictation`. Works in sandboxed
// preloads.

import { contextBridge, ipcRenderer, type IpcRenderer, type IpcRendererEvent } from "electron";

import {
  DESKTOP_DICTATION_GLOBAL,
  DESKTOP_IPC,
  type DesktopDictation,
  type DesktopDictationHistoryEntry,
  type DesktopDictationRequest,
  type DesktopDictationStatus,
} from "../contract";

/** The page's dictation calls, sent to the main process over `ipc`. */
export function dictationBridge(ipc: IpcRenderer = ipcRenderer): DesktopDictation {
  // Requests go to the page's newest listener; the app knows whether one listens.
  let requestListener: ((request: DesktopDictationRequest) => void) | null = null;
  ipc.on(DESKTOP_IPC.dictationRequest, (_event: IpcRendererEvent, request: DesktopDictationRequest) => {
    requestListener?.(request);
  });
  return {
    status: () => ipc.invoke(DESKTOP_IPC.dictationStatus) as Promise<DesktopDictationStatus>,
    update: (settings) =>
      ipc.invoke(DESKTOP_IPC.dictationUpdate, settings) as Promise<DesktopDictationStatus>,
    requestPermission: async (id) => {
      await ipc.invoke(DESKTOP_IPC.dictationRequestPermission, id);
    },
    history: () =>
      ipc.invoke(DESKTOP_IPC.dictationHistory) as Promise<DesktopDictationHistoryEntry[]>,
    clearHistory: async () => {
      await ipc.invoke(DESKTOP_IPC.dictationClearHistory);
    },
    onRequest: (listener) => {
      requestListener = listener;
      ipc.send(DESKTOP_IPC.dictationListen, true);
      return () => {
        if (requestListener !== listener) return;
        requestListener = null;
        ipc.send(DESKTOP_IPC.dictationListen, false);
      };
    },
    report: (report) => ipc.send(DESKTOP_IPC.dictationReport, report),
    onChange: (listener) => {
      const handler = () => listener();
      ipc.on(DESKTOP_IPC.dictationChanged, handler);
      return () => {
        ipc.removeListener(DESKTOP_IPC.dictationChanged, handler);
      };
    },
  };
}

/**
 * Define `window.opengeniDictation`, which `DesktopDictationHost` uses to
 * record for the app's dictation shortcuts and the dictation settings use to
 * show and change them. Call it only on your web app's origin.
 */
export function exposeDictation(): void {
  contextBridge.exposeInMainWorld(DESKTOP_DICTATION_GLOBAL, dictationBridge());
}
