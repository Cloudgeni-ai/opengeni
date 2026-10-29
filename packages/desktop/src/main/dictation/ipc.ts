// The main-process side of the dictation bridge: answers the page's calls
// (`@opengeni/desktop/preload/dictation`, or the Opengeni desktop shell's own
// bridge) and keeps every page that asked up to date.

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";

import { DESKTOP_IPC, type DesktopDictationReport } from "../../contract";
import type { Dictation } from "./index";
import { parseDictationAudio } from "./settings";

/**
 * Answer the dictation calls with this controller. `allow` throws for a sender
 * that may not dictate, such as a page on another origin or a subframe. A page
 * stops recording for the shortcuts when it navigates away or closes.
 */
export function handleDictationIpc(input: {
  ipcMain: Pick<IpcMain, "handle" | "on">;
  dictation: Dictation;
  allow(event: IpcMainInvokeEvent | IpcMainEvent): void;
}): void {
  const { ipcMain, dictation, allow } = input;
  const pages = new Set<WebContents>();
  const watched = new WeakSet<WebContents>();
  const watch = (page: WebContents) => {
    pages.add(page);
    if (watched.has(page)) return;
    watched.add(page);
    const gone = () => {
      pages.delete(page);
      dictation.listen(page, false);
    };
    page.once("destroyed", gone);
    page.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) dictation.listen(page, false);
    });
  };
  dictation.onChange(() => {
    for (const page of pages) {
      if (page.isDestroyed()) pages.delete(page);
      else page.send(DESKTOP_IPC.dictationChanged);
    }
  });
  const handle = (channel: string, run: (event: IpcMainInvokeEvent, arg: unknown) => unknown) => {
    ipcMain.handle(channel, (event, arg: unknown) => {
      allow(event);
      watch(event.sender);
      return run(event, arg);
    });
  };
  handle(DESKTOP_IPC.dictationStatus, () => dictation.status());
  handle(DESKTOP_IPC.dictationUpdate, (_event, change) => dictation.update(change));
  handle(DESKTOP_IPC.dictationRequestPermission, async (_event, id) => {
    if (id === "accessibility") await dictation.requestPermission(id);
  });
  handle(DESKTOP_IPC.dictationHistory, () => dictation.history());
  handle(DESKTOP_IPC.dictationClearHistory, () => dictation.clearHistory());
  handle(DESKTOP_IPC.dictationHistoryAudio, (_event, id) =>
    typeof id === "string" ? dictation.historyAudio(id) : null,
  );
  handle(DESKTOP_IPC.dictationTranscribeAgain, (_event, id) => {
    if (typeof id === "string") dictation.transcribeAgain(id);
  });
  ipcMain.on(DESKTOP_IPC.dictationListen, (event, listening: unknown) => {
    try {
      allow(event);
    } catch {
      return;
    }
    watch(event.sender);
    dictation.listen(event.sender, listening === true);
  });
  ipcMain.on(DESKTOP_IPC.dictationReport, (event, report: unknown) => {
    try {
      allow(event);
    } catch {
      return;
    }
    const parsed = parseDictationReport(report);
    if (parsed) dictation.report(event.sender, parsed);
  });
}

/** A page's report, or null when it isn't one. */
export function parseDictationReport(value: unknown): DesktopDictationReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Record<string, unknown>;
  const dictationId = report.dictationId;
  if (typeof dictationId !== "string" || dictationId.length > 100) return null;
  switch (report.phase) {
    case "recording":
      return {
        dictationId,
        phase: "recording",
        startedAt: typeof report.startedAt === "number" ? report.startedAt : Date.now(),
        level:
          typeof report.level === "number" && Number.isFinite(report.level)
            ? Math.min(1, Math.max(0, report.level))
            : null,
      };
    case "transcribing":
      return { dictationId, phase: report.phase };
    case "cancelled": {
      const audio = parseDictationAudio(report.audio);
      return { dictationId, phase: "cancelled", ...(audio ? { audio } : {}) };
    }
    case "done": {
      if (typeof report.text !== "string") return null;
      const audio = parseDictationAudio(report.audio);
      return {
        dictationId,
        phase: "done",
        text: report.text.slice(0, 200_000),
        ...(audio ? { audio } : {}),
      };
    }
    case "failed":
      return {
        dictationId,
        phase: "failed",
        message:
          typeof report.message === "string" && report.message.trim()
            ? report.message.slice(0, 300)
            : "Dictation failed.",
        retryable: report.retryable === true,
      };
    default:
      return null;
  }
}
