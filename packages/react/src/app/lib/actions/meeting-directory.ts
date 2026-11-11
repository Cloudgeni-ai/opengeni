/**
 * The meetings the ⌘K menu already knows: the newest few of each workspace,
 * kept from the last time the menu asked, so the next open lists them at once
 * while it asks again. A cache for speed, never a source of authority: opening
 * a meeting goes through the normal authorized reads.
 */
import { useSyncExternalStore } from "react";
import type { Recording } from "@opengeni/contracts";
import { meetingTitle } from "../../../recordings-model";

export type MeetingRecord = {
  id: string;
  workspaceId: string;
  title: string;
  /** When it started (ms). */
  startedAt: number;
};

type DirectoryState = { meetings: Map<string, readonly MeetingRecord[]>; version: number };

const directories = new Map<string, DirectoryState>();
const listeners = new Map<string, Set<() => void>>();

function directory(subjectId: string): DirectoryState {
  let state = directories.get(subjectId);
  if (!state) {
    state = { meetings: new Map(), version: 0 };
    directories.set(subjectId, state);
  }
  return state;
}

/** Turns listed recordings into records, with the titles the Meetings page shows. */
export function meetingRecords(recordings: readonly Recording[]): MeetingRecord[] {
  const seen = new Set<string>();
  const records: MeetingRecord[] = [];
  for (const recording of recordings) {
    if (!recording?.id || seen.has(recording.id)) continue;
    seen.add(recording.id);
    records.push({
      id: recording.id,
      workspaceId: recording.workspaceId,
      title: meetingTitle(recording),
      startedAt: Date.parse(recording.startedAt) || 0,
    });
  }
  return records;
}

/** The workspace's newest meetings, as the server just listed them; replaces the last list. */
export function rememberRecentMeetings(
  subjectId: string,
  workspaceId: string,
  records: readonly MeetingRecord[],
): void {
  const state = directory(subjectId);
  const next = [...records].sort((a, b) => b.startedAt - a.startedAt);
  const current = state.meetings.get(workspaceId);
  if (
    current &&
    current.length === next.length &&
    current.every(
      (meeting, index) =>
        meeting.id === next[index]!.id &&
        meeting.title === next[index]!.title &&
        meeting.startedAt === next[index]!.startedAt,
    )
  )
    return;
  state.meetings.set(workspaceId, next);
  state.version += 1;
  for (const listener of listeners.get(subjectId) ?? []) listener();
}

/** The workspace's newest meetings the menu knows, newest first. */
export function readRecentMeetings(
  subjectId: string,
  workspaceId: string,
): readonly MeetingRecord[] {
  return directory(subjectId).meetings.get(workspaceId) ?? [];
}

/** Re-renders when the directory changes; read it through `readRecentMeetings`. */
export function useMeetingDirectoryVersion(subjectId: string): number {
  return useSyncExternalStore(
    (listener) => {
      let set = listeners.get(subjectId);
      if (!set) {
        set = new Set();
        listeners.set(subjectId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    () => directory(subjectId).version,
    () => 0,
  );
}

/** A meeting's page in the app, as a plain path (new tab). */
export function meetingPath(workspaceId: string, recordingId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/meetings/${encodeURIComponent(recordingId)}`;
}
