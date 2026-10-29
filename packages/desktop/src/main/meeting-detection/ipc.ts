// The main-process side of the meeting detection bridge: answers the page's
// calls (`@opengeni/desktop/preload/meeting-detection`, or the Opengeni
// desktop shell's own bridge) and keeps every page that asked up to date.

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";

import { DESKTOP_IPC } from "../../contract";
import type { MeetingDetection } from "./index";

/**
 * Answer the meeting detection calls with `detection`. `allow` throws for a
 * sender that may not record, such as a page on another origin or a subframe.
 * A page stops recording and taking choices when it navigates away or closes.
 */
export function handleMeetingDetectionIpc(input: {
  ipcMain: Pick<IpcMain, "handle" | "on">;
  detection: MeetingDetection;
  allow(event: IpcMainInvokeEvent | IpcMainEvent): void;
}): void {
  const { ipcMain, detection, allow } = input;
  const pages = new Set<WebContents>();
  const watched = new WeakSet<WebContents>();
  const watch = (page: WebContents) => {
    pages.add(page);
    if (watched.has(page)) return;
    watched.add(page);
    page.once("destroyed", () => {
      pages.delete(page);
      detection.pageGone(page);
    });
    page.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) detection.pageGone(page);
    });
  };
  detection.onChange(() => {
    for (const page of pages) {
      if (page.isDestroyed()) pages.delete(page);
      else page.send(DESKTOP_IPC.meetingDetectionChanged);
    }
  });
  const handle = (channel: string, run: (arg: unknown) => unknown) => {
    ipcMain.handle(channel, (event, arg: unknown) => {
      allow(event);
      watch(event.sender);
      return run(arg);
    });
  };
  const on = (channel: string, run: (page: WebContents, arg: unknown) => void) => {
    ipcMain.on(channel, (event, arg: unknown) => {
      try {
        allow(event);
      } catch {
        return;
      }
      watch(event.sender);
      run(event.sender, arg);
    });
  };
  handle(DESKTOP_IPC.meetingDetectionStatus, () => detection.status());
  handle(DESKTOP_IPC.meetingDetectionUpdate, (change) => detection.update(change));
  on(DESKTOP_IPC.meetingDetectionRecording, (page, recording) =>
    detection.setRecording(page, recording === true),
  );
  on(DESKTOP_IPC.meetingDetectionListen, (page, listening) =>
    detection.listen(page, listening === true),
  );
}
