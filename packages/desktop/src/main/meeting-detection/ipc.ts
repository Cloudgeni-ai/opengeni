// The main-process side of the meeting detection bridge: answers the page's
// calls (`@opengeni/desktop/preload/meeting-detection`, or the Opengeni
// desktop shell's own bridge) and keeps every page that asked up to date.

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";

import { DESKTOP_IPC } from "../../contract";
import { onPageLeft } from "../page-left";
import { recordingMeeting, type MeetingDetection } from "./index";

/**
 * Answer the meeting detection calls with `detection`. `allow` throws for a
 * sender that may not record, such as a page on another origin or a subframe.
 * A page stops recording and taking choices once it has gone to another
 * document, shown an error page, lost its renderer or closed. A navigation that
 * starts but is cancelled, such as a link the app opens in the browser instead,
 * leaves the page as it was.
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
    onPageLeft(page, () => detection.pageGone(page));
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
  const on = (channel: string, run: (page: WebContents, arg: unknown, more: unknown) => void) => {
    ipcMain.on(channel, (event, arg: unknown, more: unknown) => {
      try {
        allow(event);
      } catch {
        return;
      }
      watch(event.sender);
      run(event.sender, arg, more);
    });
  };
  handle(DESKTOP_IPC.meetingDetectionStatus, () => detection.status());
  handle(DESKTOP_IPC.meetingDetectionUpdate, (change) => detection.update(change));
  on(DESKTOP_IPC.meetingDetectionRecording, (page, recording, meeting) =>
    detection.setRecording(page, recording === true, recordingMeeting(meeting)),
  );
  on(DESKTOP_IPC.meetingDetectionListen, (page, listening) =>
    detection.listen(page, listening === true),
  );
}
