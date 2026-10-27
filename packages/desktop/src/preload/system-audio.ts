// Other apps' audio for the Opengeni meeting recorder, in a preload script.
// The Opengeni desktop shell puts it on its bridge; any other Electron app that
// shows Opengeni's meetings defines it on its own with exposeSystemAudio(),
// and answers it in the main process with handleSystemAudioIpc() from
// `@opengeni/desktop/system-audio`. Works in sandboxed preloads.

import { contextBridge, ipcRenderer, type IpcRenderer, type IpcRendererEvent } from "electron";

import {
  DESKTOP_IPC,
  DESKTOP_SYSTEM_AUDIO_GLOBAL,
  type DesktopSystemAudio,
  type DesktopSystemAudioError,
} from "../contract";

/** The recorder's calls, sent to the main process over `ipc`. */
export function systemAudioBridge(ipc: IpcRenderer = ipcRenderer): DesktopSystemAudio {
  return {
    start: async () => {
      const result = (await ipc.invoke(DESKTOP_IPC.systemAudioStart)) as
        | { ok: true; captureId: string; sampleRate: number }
        | { ok: false; error: DesktopSystemAudioError };
      if (!result.ok) throw result.error;
      return { captureId: result.captureId, sampleRate: result.sampleRate };
    },
    stop: async (captureId) => {
      await ipc.invoke(DESKTOP_IPC.systemAudioStop, captureId);
    },
    onSamples: (listener) => {
      const handler = (_event: IpcRendererEvent, id: string, samples: Float32Array) =>
        listener(id, samples);
      ipc.on(DESKTOP_IPC.systemAudioSamples, handler);
      return () => {
        ipc.removeListener(DESKTOP_IPC.systemAudioSamples, handler);
      };
    },
    onEnded: (listener) => {
      const handler = (
        _event: IpcRendererEvent,
        id: string,
        error: DesktopSystemAudioError | null,
      ) => listener(id, error);
      ipc.on(DESKTOP_IPC.systemAudioEnded, handler);
      return () => {
        ipc.removeListener(DESKTOP_IPC.systemAudioEnded, handler);
      };
    },
  };
}

/**
 * Define `window.opengeniSystemAudio`, which the Opengeni meeting recorder
 * uses to record other apps' audio as its own track instead of offering a
 * tab's. Call it only on your web app's origin, and only when the main process
 * can record here (systemAudioUsable()).
 */
export function exposeSystemAudio(): void {
  contextBridge.exposeInMainWorld(DESKTOP_SYSTEM_AUDIO_GLOBAL, systemAudioBridge());
}
