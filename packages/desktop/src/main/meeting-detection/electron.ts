// Meeting detection wired to Electron: the card in the corner of the screen,
// the switch in the app's data folder, and a short record of what it asked.
// One call for any Electron app.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { nativeImage } from "electron";

import { systemAudioUsable } from "../system-audio";
import { MeetingPromptCard } from "./card";
import {
  MeetingDetection,
  MeetingDetectionStore,
  ownAppRoot,
  type MeetingDetectionOptions,
} from "./index";
import type { MeetingWords } from "./words";

/** The record of what detection asked, kept under this size (with one older file beside it). */
const LOG_MAX_BYTES = 256 * 1024;

/**
 * Lines appended to `meeting-detection.log` in `dir`, with the time. Lines
 * name the call app (its id) and what happened, nothing about the call.
 */
export function meetingDetectionFileLog(dir: string): (message: string, error?: unknown) => void {
  const path = join(dir, "meeting-detection.log");
  return (message, error) => {
    try {
      mkdirSync(dir, { recursive: true });
      try {
        if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.old`);
      } catch {
        // No file yet.
      }
      const detail =
        error === undefined ? "" : ` ${error instanceof Error ? error.message : String(error)}`;
      appendFileSync(path, `${new Date().toISOString()} ${message}${detail}\n`, { mode: 0o600 });
    } catch {
      // A full disk or a missing folder never stops detection.
    }
  };
}

export interface CreateMeetingDetectionOptions {
  /**
   * The bundled audio helper (named by `systemAudioHelperName()`), the same
   * one that records the computer's audio, or null when the app has none.
   */
  helperPath: string | null;
  /** The app's id (its macOS bundle id), which its own processes' ids start with. */
  appId: string;
  /** Where the switch is kept: `app.getPath("userData")`. */
  dataDir: string;
  /** Where the record of what detection asked goes: `app.getPath("logs")`. None by default. */
  logDir?: string;
  /** The app's icon on the card: a PNG. None by default. */
  iconPath?: string;
  /** The card's words, in the app's language; read each time a card shows. English by default. */
  words?: () => MeetingWords;
  /** The person chose to record or stop: bring the app's window up, opening it if it is closed. */
  reveal(): void;
  /**
   * Of the pages that take the person's choices, the one that records. None
   * waits for another page. The newest by default.
   */
  chooseTarget?: MeetingDetectionOptions["chooseTarget"];
  log?: (message: string, error?: unknown) => void;
}

/**
 * Meeting detection for an Electron app. Answer the page with
 * `handleMeetingDetectionIpc`, call `start()` once the app is ready and
 * `stop()` as it quits.
 */
export function createMeetingDetection(options: CreateMeetingDetectionOptions): MeetingDetection {
  const file = options.logDir ? meetingDetectionFileLog(options.logDir) : null;
  let icon: string | null | undefined;
  const iconPath = options.iconPath;
  return new MeetingDetection({
    helperPath: options.helperPath,
    available: systemAudioUsable(options.helperPath),
    own: {
      pid: process.pid,
      bundlePrefix: options.appId,
      root: ownAppRoot(process.execPath, process.platform),
      platform: process.platform,
    },
    store: new MeetingDetectionStore(options.dataDir),
    view: new MeetingPromptCard({
      platform: process.platform,
      ...(options.words ? { words: options.words } : {}),
      icon: () => {
        if (icon === undefined) {
          const image = iconPath ? nativeImage.createFromPath(iconPath) : null;
          icon = image && !image.isEmpty() ? image.resize({ width: 64 }).toDataURL() : null;
        }
        return icon;
      },
    }),
    reveal: options.reveal,
    ...(options.chooseTarget ? { chooseTarget: options.chooseTarget } : {}),
    log: (message, error) => {
      file?.(message, error);
      options.log?.(message, error);
    },
  });
}
