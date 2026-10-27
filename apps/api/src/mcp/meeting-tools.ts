// Agents find and read recorded meetings, and write their notes. They act as
// the person the session works for, so an agent sees exactly the meetings
// that person can see: their own Only me recordings and everything shared
// with the workspace. Transcripts are given as compact speaker-named lines
// with people's corrections applied, in parts a model can page through.
import {
  defaultRecordingSpeakerName,
  RECORDING_NOTE_MAX_BYTES,
  type AccessGrant,
  type Recording,
  type RecordingNote,
  type RecordingSpeaker,
  type RecordingTranscriptVersion,
} from "@opengeni/contracts";
import { siteViewerForGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  getManagedUserProfilesByIds,
  getRecording,
  getRecordingSearchDetails,
  getRecordingTranscriptPage,
  listRecordingLiveSegments,
  listRecordingNotes,
  listRecordings,
  listRecordingTranscriptVersions,
  RecordingConflictError,
  RecordingNotFoundError,
  saveRecordingNote,
  type RecordingActor,
} from "@opengeni/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

type JsonResult = (value: unknown) => {
  content: { type: "text"; text: string }[];
};

export type RegisterMeetingToolsInput = {
  server: McpServer;
  deps: ApiRouteDeps;
  grant: AccessGrant;
  /** The session whose agent saves notes, recorded with them. */
  sessionId: string;
  authorize: () => Promise<void>;
  json: JsonResult;
};

/** How much transcript one meeting_read returns by default, in characters. */
export const MEETING_READ_DEFAULT_CHARS = 20_000;
export const MEETING_READ_MAX_CHARS = 60_000;
/** The most of each note meeting_read shows; longer notes end with a cut mark. */
export const MEETING_READ_NOTE_CHARS = 20_000;
const TRANSCRIPT_FETCH = 2_000;
const LIVE_FETCH = 1_000;

const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/u;

/** "12:31" or "1:05:00" into milliseconds; null when it isn't one. */
export function parseMeetingTimestamp(value: string): number | null {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (seconds >= 60 || (match[1] !== undefined && minutes >= 60)) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000;
}

/** Milliseconds as "m:ss", or "h:mm:ss" from an hour on. */
export function formatMeetingTimestamp(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

function meetingStatus(recording: Recording): string {
  switch (recording.state) {
    case "capturing":
      return "recording";
    case "processing":
      return "transcribing";
    case "ready":
      return "ready";
    default:
      return recording.transcript?.state === "failed" ? "transcript failed" : recording.state;
  }
}

function speakerName(speaker: RecordingSpeaker): string {
  return speaker.source === "suggested" ? `${speaker.name} (suggested)` : speaker.name;
}

function versionSummary(version: RecordingTranscriptVersion) {
  return {
    version: version.versionNumber,
    model: version.model,
    state: version.state,
    current: version.isCurrent,
    ...(version.languages.length > 0 ? { languages: version.languages } : {}),
  };
}

type Line = { startMilliseconds: number; speaker: string | null; text: string };

/**
 * Consecutive segments by the same speaker read as one line stamped with its
 * start, so a transcript costs few tokens and still reads like a meeting.
 */
function joinTurns(segments: readonly Line[]): Line[] {
  const lines: Line[] = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const previous = lines.at(-1);
    if (previous && previous.speaker === segment.speaker) {
      previous.text = `${previous.text} ${text}`;
    } else {
      lines.push({ ...segment, text });
    }
  }
  return lines;
}

function renderLine(line: Line): string {
  const at = `[${formatMeetingTimestamp(line.startMilliseconds)}]`;
  return line.speaker ? `${at} ${line.speaker}: ${line.text}` : `${at} ${line.text}`;
}

type ReadCursor =
  | { kind: "transcript"; after: number; toMilliseconds: number | null }
  | { kind: "live"; after: number };

function encodeCursor(cursor: ReadCursor): string {
  return cursor.kind === "live"
    ? `live:${cursor.after}`
    : `t:${cursor.after}:${cursor.toMilliseconds ?? ""}`;
}

function decodeCursor(value: string): ReadCursor | null {
  const live = /^live:(\d+)$/u.exec(value);
  if (live) return { kind: "live", after: Number(live[1]) };
  const transcript = /^t:(\d+):(\d*)$/u.exec(value);
  if (!transcript) return null;
  return {
    kind: "transcript",
    after: Number(transcript[1]),
    toMilliseconds: transcript[2] ? Number(transcript[2]) : null,
  };
}

function encodeSearchCursor(before: { startedAt: string; id: string }): string {
  return `${before.startedAt}|${before.id}`;
}

function decodeSearchCursor(value: string): { startedAt: Date; id: string } | null {
  const [startedAt, id] = value.split("|");
  const date = new Date(startedAt ?? "");
  if (Number.isNaN(date.getTime()) || !id || !z.uuid().safeParse(id).success) return null;
  return { startedAt: date, id };
}

function failure(json: JsonResult, code: string, message: string) {
  return { ...json({ error: { code, message } }), isError: true };
}

export function registerMeetingTools(input: RegisterMeetingToolsInput): void {
  const { server, deps, grant, sessionId, authorize, json } = input;

  /** The person the agent acts for; without one it sees only shared meetings. */
  async function actor(): Promise<RecordingActor> {
    await authorize();
    const viewer = await siteViewerForGrant(deps.db, grant);
    return { workspaceId: grant.workspaceId, subjectId: viewer.subjectId ?? grant.subjectId };
  }

  server.registerTool(
    "meetings_search",
    {
      description:
        "Find recorded meetings the person you act for can see: their own and those shared with the workspace. Filter by words said or in the title, a named speaker, when they started, or a product's reference. Newest first, with each meeting's speakers and, when searching for words, the first transcript lines that contain them. Read a meeting with meeting_read.",
      inputSchema: {
        query: z
          .string()
          .max(200)
          .optional()
          .describe("Words said in the meeting or in its title."),
        person: z
          .string()
          .max(200)
          .optional()
          .describe("A speaker's name or part of it, or their people id."),
        startedFrom: z.iso
          .datetime({ offset: true })
          .optional()
          .describe("Only meetings started at or after this ISO date and time."),
        startedTo: z.iso
          .datetime({ offset: true })
          .optional()
          .describe("Only meetings started before this ISO date and time."),
        externalRef: z
          .string()
          .max(512)
          .optional()
          .describe("The reference a product stored with its meetings, such as a project id."),
        limit: z.number().int().min(1).max(25).default(10),
        cursor: z.string().max(200).optional().describe("nextCursor from the previous page."),
      },
    },
    async (request) => {
      const before = request.cursor ? decodeSearchCursor(request.cursor) : undefined;
      if (before === null) {
        return failure(json, "invalid_cursor", "Pass nextCursor exactly as it was returned.");
      }
      const who = await actor();
      const page = await listRecordings(deps.db, {
        ...who,
        query: request.query?.trim() || undefined,
        person: request.person?.trim() || undefined,
        startedFrom: request.startedFrom ? new Date(request.startedFrom) : undefined,
        startedTo: request.startedTo ? new Date(request.startedTo) : undefined,
        externalRef: request.externalRef?.trim() || undefined,
        before,
        limit: request.limit,
      });
      const searchDetails = await getRecordingSearchDetails(deps.db, {
        ...who,
        recordingIds: page.recordings.map((recording) => recording.id),
        query: request.query,
      });
      return json({
        meetings: page.recordings.map((recording) => {
          const found = searchDetails.get(recording.id);
          return {
            id: recording.id,
            title: recording.title,
            startedAt: recording.startedAt,
            duration: formatMeetingTimestamp(recording.durationMilliseconds),
            status: meetingStatus(recording),
            visibility: recording.visibility === "private" ? "only_me" : "workspace",
            speakers: (found?.speakers ?? []).map(speakerName),
            ...(recording.externalRef ? { externalRef: recording.externalRef } : {}),
            ...(found && found.matches.length > 0
              ? {
                  matches: found.matches.map((match) =>
                    renderLine({
                      startMilliseconds: match.startMilliseconds,
                      speaker: match.speaker,
                      text: match.text,
                    }),
                  ),
                }
              : {}),
          };
        }),
        nextCursor: page.nextBefore ? encodeSearchCursor(page.nextBefore) : null,
      });
    },
  );

  server.registerTool(
    "meeting_read",
    {
      description:
        'Read a recorded meeting the person you act for can see: its details, speakers, notes and transcript, as lines like "[12:31] Ingrid Solberg: …" with names and corrections applied. The notepad is what people jotted down during the meeting; the notes are its written-up summary, with their revision for meeting_notes_save. Long transcripts come in parts: pass nextCursor to continue, or from and to (such as "12:00" and "1:05:00") to read one stretch. While a meeting is still being recorded, the lines are its rough live preview if one is on.',
      inputSchema: {
        meetingId: z.uuid().describe("A meeting id from meetings_search."),
        from: z
          .string()
          .max(12)
          .optional()
          .describe('Start of the stretch to read, as "m:ss" or "h:mm:ss".'),
        to: z.string().max(12).optional().describe('End of the stretch, as "m:ss" or "h:mm:ss".'),
        versionId: z
          .uuid()
          .optional()
          .describe("An earlier transcript version to read instead of the current one."),
        cursor: z
          .string()
          .max(64)
          .optional()
          .describe("nextCursor from the previous part; from is then not needed."),
        maxChars: z
          .number()
          .int()
          .min(1_000)
          .max(MEETING_READ_MAX_CHARS)
          .default(MEETING_READ_DEFAULT_CHARS),
      },
    },
    async (request) => {
      const cursor = request.cursor ? decodeCursor(request.cursor) : undefined;
      if (cursor === null) {
        return failure(json, "invalid_cursor", "Pass nextCursor exactly as it was returned.");
      }
      const from = request.from ? parseMeetingTimestamp(request.from) : undefined;
      const to = request.to ? parseMeetingTimestamp(request.to) : undefined;
      if (from === null || to === null) {
        return failure(json, "invalid_time", 'Give from and to as "m:ss" or "h:mm:ss".');
      }
      const who = await actor();
      let recording: Recording;
      try {
        recording = await getRecording(deps.db, { ...who, recordingId: request.meetingId });
      } catch (error) {
        if (error instanceof RecordingNotFoundError) {
          return json({
            found: false,
            message: "No meeting with this id is visible to the person you act for.",
          });
        }
        throw error;
      }
      // Details come with the first part only; later parts carry just lines.
      const first = cursor === undefined;
      const transcriptReady =
        request.versionId !== undefined ||
        (recording.transcript?.isCurrent === true && recording.transcript.state === "complete");

      if (!transcriptReady || cursor?.kind === "live") {
        const live =
          recording.state === "capturing" || recording.state === "processing"
            ? await listRecordingLiveSegments(deps.db, {
                ...who,
                recordingId: recording.id,
                after: cursor?.kind === "live" ? cursor.after : 0,
                limit: LIVE_FETCH,
              })
            : null;
        const segments = (live?.segments ?? []).filter(
          (segment) =>
            (from === undefined || segment.endMilliseconds > from) &&
            (to === undefined || segment.startMilliseconds < to),
        );
        const rendered = renderWithin(
          segments.map((segment) => ({
            key: segment.sequence,
            startMilliseconds: segment.startMilliseconds,
            speaker: defaultRecordingSpeakerName(`track-${segment.trackNumber}`, recording.tracks),
            text: segment.text,
          })),
          request.maxChars,
        );
        // A stretch can filter out a whole fetched page, so a full page
        // continues after its last line even when none of it was shown.
        const after = rendered.truncated
          ? rendered.lastKey
          : (live?.segments.length ?? 0) === LIVE_FETCH
            ? live!.segments.at(-1)!.sequence
            : null;
        return json({
          ...(first ? { meeting: await details(recording, who, []) } : {}),
          transcript:
            live && live.segments.length > 0
              ? "live preview: rough text while recording; speakers are not told apart"
              : transcriptNote(recording),
          lines: rendered.text,
          nextCursor: after !== null ? encodeCursor({ kind: "live", after }) : null,
        });
      }

      const toMilliseconds =
        cursor?.kind === "transcript" ? (cursor.toMilliseconds ?? undefined) : to;
      let page;
      try {
        page = await getRecordingTranscriptPage(deps.db, {
          ...who,
          recordingId: recording.id,
          versionId: request.versionId,
          after: cursor?.kind === "transcript" ? cursor.after : undefined,
          fromMilliseconds: cursor ? undefined : from,
          toMilliseconds,
          limit: TRANSCRIPT_FETCH,
        });
      } catch (error) {
        if (error instanceof RecordingNotFoundError) {
          return failure(json, "version_not_found", "This meeting has no such transcript version.");
        }
        throw error;
      }
      const names = new Map(page.speakers.map((speaker) => [speaker.label, speakerName(speaker)]));
      const rendered = renderWithin(
        page.segments.map((segment) => ({
          key: segment.index,
          startMilliseconds: segment.startMilliseconds,
          speaker: segment.speakerLabel
            ? (names.get(segment.speakerLabel) ?? segment.speakerLabel)
            : null,
          text: segment.text,
        })),
        request.maxChars,
      );
      const more = rendered.lastKey !== null && (rendered.truncated || page.nextAfter !== null);
      return json({
        ...(first ? { meeting: await details(recording, who, page.speakers) } : {}),
        transcript: versionSummary(page.version),
        lines: rendered.text,
        nextCursor: more
          ? encodeCursor({
              kind: "transcript",
              after: rendered.lastKey!,
              toMilliseconds: toMilliseconds ?? null,
            })
          : null,
      });
    },
  );

  server.registerTool(
    "meeting_notes_save",
    {
      description:
        "Save a meeting's notes: its written-up summary, decisions and action items in Markdown, shown on the meeting page to everyone who can see the meeting. This replaces the notes as a whole. Read the meeting with meeting_read first and pass the notes' revision as expectedRevision (0 when it has none), so edits someone made meanwhile are not overwritten. The notepad people wrote during the meeting is never changed.",
      inputSchema: {
        meetingId: z.uuid().describe("A meeting id from meetings_search."),
        notes: z
          .string()
          .min(1)
          .max(RECORDING_NOTE_MAX_BYTES)
          .describe("The complete notes, in Markdown."),
        expectedRevision: z
          .number()
          .int()
          .min(0)
          .describe("The notes' revision from meeting_read, or 0 when it showed none."),
      },
    },
    async (request) => {
      if (new TextEncoder().encode(request.notes).length > RECORDING_NOTE_MAX_BYTES) {
        return failure(json, "notes_too_long", "Notes can be at most 256 KiB; shorten them.");
      }
      const who = await actor();
      try {
        const saved = await saveRecordingNote(deps.db, {
          ...who,
          recordingId: request.meetingId,
          kind: "notes",
          body: request.notes,
          expectedRevision: request.expectedRevision,
          sessionId,
        });
        return json({ saved: true, revision: saved.revision });
      } catch (error) {
        if (error instanceof RecordingNotFoundError) {
          return json({
            found: false,
            message: "No meeting with this id is visible to the person you act for.",
          });
        }
        if (error instanceof RecordingConflictError && error.code === "notes_changed") {
          const current = (
            await listRecordingNotes(deps.db, { ...who, recordingId: request.meetingId })
          ).find((note) => note.kind === "notes");
          return failure(
            json,
            "notes_changed",
            `Someone saved these notes since revision ${request.expectedRevision}; they are now at revision ${current?.revision ?? 0}. Read them with meeting_read, merge your changes in and save again.`,
          );
        }
        throw error;
      }
    },
  );

  async function details(
    recording: Recording,
    who: RecordingActor,
    speakers: readonly RecordingSpeaker[],
  ) {
    const [owner] = recording.ownerSubjectId.startsWith("user:")
      ? await getManagedUserProfilesByIds(deps.db, [recording.ownerSubjectId.slice(5)])
      : [];
    const versions = (
      await listRecordingTranscriptVersions(deps.db, { ...who, recordingId: recording.id })
    ).filter((version) => version.state === "complete");
    const notes = await listRecordingNotes(deps.db, { ...who, recordingId: recording.id });
    const notepad = notes.find((note) => note.kind === "notepad");
    const written = notes.find((note) => note.kind === "notes");
    const metadata = Object.keys(recording.metadata).length > 0 ? recording.metadata : null;
    return {
      id: recording.id,
      title: recording.title,
      startedAt: recording.startedAt,
      duration: formatMeetingTimestamp(recording.durationMilliseconds),
      status: meetingStatus(recording),
      visibility: recording.visibility === "private" ? "only_me" : "workspace",
      ...(owner ? { recordedBy: owner.name ?? owner.email } : {}),
      speakers: speakers.map((speaker) => ({
        name: speaker.name,
        ...(speaker.personId ? { personId: speaker.personId } : {}),
        ...(speaker.source === "suggested" ? { suggested: true } : {}),
      })),
      ...(versions.length > 1
        ? {
            versions: versions.map((version) => ({
              id: version.id,
              ...versionSummary(version),
            })),
          }
        : {}),
      ...(recording.externalRef ? { externalRef: recording.externalRef } : {}),
      ...(metadata ? { metadata } : {}),
      ...(notepad && notepad.body.trim() ? { notepad: noteText(notepad) } : {}),
      notes: written
        ? { revision: written.revision, text: noteText(written) }
        : { revision: 0, text: null },
    };
  }
}

/** A note's text, cut at MEETING_READ_NOTE_CHARS with a mark saying so. */
function noteText(note: RecordingNote): string {
  if (note.body.length <= MEETING_READ_NOTE_CHARS) return note.body;
  return `${note.body.slice(0, MEETING_READ_NOTE_CHARS)}\n\n[… ${note.body.length - MEETING_READ_NOTE_CHARS} more characters not shown]`;
}

function transcriptNote(recording: Recording): string {
  if (recording.state === "capturing") return "still recording; no live preview is on";
  if (recording.state === "processing" || recording.transcript?.state === "processing") {
    return "transcribing; read again shortly";
  }
  if (recording.transcript?.state === "failed") return "the transcript failed";
  return "no transcript";
}

/** Lines that fit in `maxChars`, and the last segment they include. */
function renderWithin(
  segments: ReadonlyArray<Line & { key: number }>,
  maxChars: number,
): { text: string; lastKey: number | null; truncated: boolean } {
  let text = "";
  let lastKey: number | null = null;
  // Turns are joined after choosing what fits, so a cut never splits a segment.
  const kept: Array<Line & { key: number }> = [];
  let used = 0;
  for (const segment of segments) {
    const cost = segment.text.length + 24 + (segment.speaker?.length ?? 0);
    if (kept.length > 0 && used + cost > maxChars) {
      text = joinTurns(kept).map(renderLine).join("\n");
      return { text, lastKey: kept.at(-1)!.key, truncated: true };
    }
    kept.push(segment);
    used += cost;
    lastKey = segment.key;
  }
  text = joinTurns(kept).map(renderLine).join("\n");
  return { text, lastKey, truncated: false };
}
