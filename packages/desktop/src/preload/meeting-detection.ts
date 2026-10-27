// Call detection, in a preload script. The Opengeni desktop shell puts it on
// its bridge; any other Electron app that shows Opengeni's meetings defines
// it with exposeMeetingDetection() and answers it in the main process with
// handleMeetingDetectionIpc() from `@opengeni/desktop/meeting-detection`.
// Works in sandboxed preloads.

import { contextBridge, ipcRenderer, type IpcRenderer, type IpcRendererEvent } from "electron";

import {
  DESKTOP_IPC,
  DESKTOP_MEETING_DETECTION_GLOBAL,
  type DesktopMeetingDetection,
  type DesktopMeetingDetectionStatus,
  type DesktopMeetingRequest,
} from "../contract";

/** The page's call detection calls, sent to the main process over `ipc`. */
export function meetingDetectionBridge(ipc: IpcRenderer = ipcRenderer): DesktopMeetingDetection {
  // Choices go to the page's newest listener; the app knows whether one listens.
  let requestListener: ((request: DesktopMeetingRequest) => void) | null = null;
  ipc.on(
    DESKTOP_IPC.meetingDetectionRequest,
    (_event: IpcRendererEvent, request: DesktopMeetingRequest) => {
      requestListener?.(request);
    },
  );
  return {
    status: () =>
      ipc.invoke(DESKTOP_IPC.meetingDetectionStatus) as Promise<DesktopMeetingDetectionStatus>,
    update: (change) =>
      ipc.invoke(
        DESKTOP_IPC.meetingDetectionUpdate,
        change,
      ) as Promise<DesktopMeetingDetectionStatus>,
    setRecording: (recording) => ipc.send(DESKTOP_IPC.meetingDetectionRecording, recording),
    onRequest: (listener) => {
      requestListener = listener;
      ipc.send(DESKTOP_IPC.meetingDetectionListen, true);
      return () => {
        if (requestListener !== listener) return;
        requestListener = null;
        ipc.send(DESKTOP_IPC.meetingDetectionListen, false);
      };
    },
    onChange: (listener) => {
      const handler = () => listener();
      ipc.on(DESKTOP_IPC.meetingDetectionChanged, handler);
      return () => {
        ipc.removeListener(DESKTOP_IPC.meetingDetectionChanged, handler);
      };
    },
  };
}

/**
 * Define `window.opengeniMeetingDetection`, which the Opengeni meeting
 * recorder uses to start recording when the person chooses Record on the
 * app's card, and to tell the app while it records. Call it only on your web
 * app's origin, alongside `exposeSystemAudio()`.
 */
export function exposeMeetingDetection(): void {
  contextBridge.exposeInMainWorld(DESKTOP_MEETING_DETECTION_GLOBAL, meetingDetectionBridge());
}
