import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  appendRecordingLiveSegments,
  claimRecordingTranscriptVersion,
  completeRecordingTranscriptVersion,
  createDb,
  createRecording,
  ensureManagedAccessForUser,
  finalizeRecording,
  markRecordingChunksUploaded,
  reserveRecordingChunks,
  startRecordingLiveTrack,
  updateRecordingSpeakers,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  formatMeetingTimestamp,
  parseMeetingTimestamp,
  registerMeetingTools,
} from "../src/mcp/meeting-tools";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("meeting-tools");
  if (shared) client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

type Handler = (input: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}>;

/** The two tools as an agent acting for `subjectId` calls them. */
function toolsFor(grant: AccessGrant) {
  const handlers = new Map<string, { handler: Handler; schema: Record<string, unknown> }>();
  const server = {
    registerTool(name: string, config: { inputSchema: Record<string, unknown> }, handler: Handler) {
      handlers.set(name, { handler, schema: config.inputSchema });
    },
  };
  registerMeetingTools({
    server: server as never,
    deps: { db: client!.db } as unknown as ApiRouteDeps,
    grant,
    authorize: async () => undefined,
    json: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
  });
  return async (name: string, input: Record<string, unknown>) => {
    const tool = handlers.get(name)!;
    // Apply the declared defaults the way the MCP server does.
    const { z } = await import("zod/v4");
    const parsed = z.object(tool.schema as never).parse(input) as Record<string, unknown>;
    const result = await tool.handler(parsed);
    return { ...JSON.parse(result.content[0]!.text), isError: result.isError === true };
  };
}

async function fixture() {
  const db = client!.db;
  const ownerUserId = `meeting-owner-${crypto.randomUUID()}`;
  await shared!.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${ownerUserId}, 'Ingrid Solberg', ${`${ownerUserId}@example.test`}, true)`;
  const access = await ensureManagedAccessForUser(db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Ingrid Solberg",
  });
  const { accountId, workspaceId } = access.workspaceGrants.find(
    (grant) => grant.workspaceId === access.defaultWorkspaceId,
  )!;
  const owner = `user:${ownerUserId}`;
  const grantFor = (subjectId: string): AccessGrant => ({
    accountId,
    workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: ["workspace:read", "sessions:read"],
  });
  const actor = { workspaceId, subjectId: owner };

  async function meeting(input: {
    title: string;
    visibility: "private" | "workspace";
    segments?: Array<{ at: number; label: string; text: string }>;
  }) {
    const recordingId = crypto.randomUUID();
    await createRecording(db, {
      ...actor,
      accountId,
      recordingId,
      title: input.title,
      visibility: input.visibility,
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
    });
    if (!input.segments) return recordingId;
    await reserveRecordingChunks(db, {
      ...actor,
      recordingId,
      trackNumber: 0,
      chunks: [
        {
          chunkNumber: 0,
          byteLength: 100,
          sha256: "a".repeat(64),
          startMilliseconds: 0,
          durationMilliseconds: 300_000,
        },
      ],
    });
    await markRecordingChunksUploaded(db, {
      ...actor,
      recordingId,
      trackNumber: 0,
      chunkNumbers: [0],
    });
    const versionId = crypto.randomUUID();
    await finalizeRecording(db, {
      ...actor,
      recordingId,
      tracks: [{ trackNumber: 0, chunkCount: 1 }],
      transcription: { providerId: "elevenlabs", model: "scribe_v2", options: {} },
      versionId,
    });
    const processingOwner = crypto.randomUUID();
    await claimRecordingTranscriptVersion(db, {
      ...actor,
      versionId,
      processingOwner,
      leaseSeconds: 600,
    });
    await completeRecordingTranscriptVersion(db, {
      ...actor,
      versionId,
      processingOwner,
      languages: ["en"],
      diarized: true,
      diarization: "provider",
      audioMilliseconds: 300_000,
      segments: input.segments.map((segment) => ({
        startMilliseconds: segment.at,
        endMilliseconds: segment.at + 4_000,
        trackNumber: 0,
        speakerLabel: segment.label,
        text: segment.text,
      })),
    });
    return recordingId;
  }
  return { accountId, workspaceId, owner, actor, grantFor, meeting };
}

describe("meeting tools", () => {
  test("timestamps read and write as m:ss and h:mm:ss", () => {
    expect(parseMeetingTimestamp("12:31")).toBe(751_000);
    expect(parseMeetingTimestamp("1:05:00")).toBe(3_900_000);
    expect(parseMeetingTimestamp("0:60")).toBeNull();
    expect(parseMeetingTimestamp("soon")).toBeNull();
    expect(formatMeetingTimestamp(751_400)).toBe("12:31");
    expect(formatMeetingTimestamp(3_900_000)).toBe("1:05:00");
  });

  test("search finds meetings by words and speaker, with the matching lines, page by page", async () => {
    if (!client) return;
    const scope = await fixture();
    const call = toolsFor(scope.grantFor(scope.owner));
    const roof = await scope.meeting({
      title: "Site walk",
      visibility: "workspace",
      segments: [
        { at: 0, label: "speaker_0", text: "Welcome." },
        { at: 65_000, label: "speaker_1", text: "The roof budget is tight." },
      ],
    });
    await updateRecordingSpeakers(client.db, {
      ...scope.actor,
      recordingId: roof,
      assignments: [{ label: "speaker_1", name: "Tomas" }],
    });
    const standup = await scope.meeting({
      title: "Standup",
      visibility: "private",
      segments: [{ at: 0, label: "speaker_0", text: "Roof crew starts Monday." }],
    });

    const found = await call("meetings_search", { query: "roof" });
    expect(found.meetings.map((meeting: { id: string }) => meeting.id).sort()).toEqual(
      [roof, standup].sort(),
    );
    const walk = found.meetings.find((meeting: { id: string }) => meeting.id === roof);
    expect(walk).toMatchObject({
      title: "Site walk",
      status: "ready",
      visibility: "workspace",
      duration: "5:00",
      speakers: ["Speaker 1", "Tomas"],
      matches: ["[1:05] Tomas: The roof budget is tight."],
    });
    expect(found.meetings.find((meeting: { id: string }) => meeting.id === standup)).toMatchObject({
      visibility: "only_me",
    });

    expect((await call("meetings_search", { person: "tomas" })).meetings).toHaveLength(1);
    const first = await call("meetings_search", { limit: 1 });
    expect(first.meetings).toHaveLength(1);
    const second = await call("meetings_search", { limit: 1, cursor: first.nextCursor });
    expect(second.meetings).toHaveLength(1);
    expect(second.meetings[0].id).not.toBe(first.meetings[0].id);
    expect(second.nextCursor).toBeNull();
    expect(await call("meetings_search", { cursor: "nonsense" })).toMatchObject({
      isError: true,
      error: { code: "invalid_cursor" },
    });
  });

  test("read gives details once, speaker-named lines in parts, and stretches by time", async () => {
    if (!client) return;
    const scope = await fixture();
    const call = toolsFor(scope.grantFor(scope.owner));
    const segments = Array.from({ length: 60 }, (_, index) => ({
      at: index * 5_000,
      label: index % 10 < 5 ? "speaker_0" : "speaker_1",
      text: `Point number ${index} about the schedule, which runs long enough to fill a line.`,
    }));
    const recordingId = await scope.meeting({
      title: "Planning",
      visibility: "workspace",
      segments,
    });
    await updateRecordingSpeakers(client.db, {
      ...scope.actor,
      recordingId,
      assignments: [{ label: "speaker_0", name: "Ingrid" }],
    });

    const part = await call("meeting_read", { meetingId: recordingId, maxChars: 1_500 });
    expect(part.meeting).toMatchObject({
      title: "Planning",
      status: "ready",
      recordedBy: "Ingrid Solberg",
      speakers: [{ name: "Ingrid" }, { name: "Speaker 2" }],
    });
    expect(part.transcript).toMatchObject({ version: 1, model: "scribe_v2", current: true });
    const lines = part.lines.split("\n");
    // One speaker's consecutive segments read as one line.
    expect(lines[0]).toStartWith("[0:00] Ingrid: Point number 0 about");
    expect(lines[0]).toContain("Point number 1 about");
    expect(part.nextCursor).toStartWith("t:");

    const next = await call("meeting_read", { meetingId: recordingId, cursor: part.nextCursor });
    expect(next.meeting).toBeUndefined();
    expect(next.lines.length).toBeGreaterThan(0);
    expect(next.lines).not.toContain("Point number 0 about");
    expect(next.nextCursor).toBeNull();

    // Only segments overlapping the stretch: 12 (1:00) and 13 (1:05), both Ingrid's.
    const stretch = await call("meeting_read", {
      meetingId: recordingId,
      from: "1:00",
      to: "1:10",
    });
    expect(stretch.lines).toBe(
      [
        "[1:00] Ingrid: Point number 12 about the schedule, which runs long enough to fill a line. Point number 13 about the schedule, which runs long enough to fill a line.",
      ].join("\n"),
    );
    expect(await call("meeting_read", { meetingId: recordingId, from: "noon" })).toMatchObject({
      isError: true,
      error: { code: "invalid_time" },
    });
  });

  test("someone else's Only me meeting is not visible, and a live one reads its preview", async () => {
    if (!client) return;
    const scope = await fixture();
    const hidden = await scope.meeting({
      title: "Private",
      visibility: "private",
      segments: [{ at: 0, label: "speaker_0", text: "Secret." }],
    });
    const outsider = toolsFor(scope.grantFor(`user:someone-${crypto.randomUUID()}`));
    expect(await outsider("meeting_read", { meetingId: hidden })).toMatchObject({ found: false });
    expect((await outsider("meetings_search", {})).meetings).toEqual([]);

    const live = await scope.meeting({ title: "Live now", visibility: "workspace" });
    await startRecordingLiveTrack(client!.db, {
      ...scope.actor,
      recordingId: live,
      trackNumber: 0,
      providerId: "elevenlabs",
      model: "scribe_v2_realtime",
    });
    await appendRecordingLiveSegments(client!.db, {
      ...scope.actor,
      recordingId: live,
      trackNumber: 0,
      streamedMilliseconds: 5_000,
      costUsdMicros: null,
      segments: [
        { segmentNumber: 0, startMilliseconds: 1_000, endMilliseconds: 3_000, text: "Hello all." },
        {
          segmentNumber: 1,
          startMilliseconds: 3_500,
          endMilliseconds: 5_000,
          text: "Let's start.",
        },
      ],
    });
    const read = await toolsFor(scope.grantFor(scope.owner))("meeting_read", { meetingId: live });
    expect(read.meeting).toMatchObject({ title: "Live now", status: "recording" });
    expect(read.transcript).toStartWith("live preview");
    expect(read.lines).toBe("[0:01] Microphone: Hello all. Let's start.");

    // A stretch past a whole page of live lines still continues to it.
    const later = Array.from({ length: 1_100 }, (_, index) => ({
      segmentNumber: 2 + index,
      startMilliseconds: 6_000 + index * 1_000,
      endMilliseconds: 6_900 + index * 1_000,
      text: `Line ${index}.`,
    }));
    await appendRecordingLiveSegments(client!.db, {
      ...scope.actor,
      recordingId: live,
      trackNumber: 0,
      streamedMilliseconds: 1_200_000,
      costUsdMicros: null,
      segments: later,
    });
    const tools = toolsFor(scope.grantFor(scope.owner));
    const stretch = await tools("meeting_read", { meetingId: live, from: "18:20", to: "18:23" });
    expect(stretch.lines).toBe("");
    expect(stretch.nextCursor).toStartWith("live:");
    const rest = await tools("meeting_read", {
      meetingId: live,
      from: "18:20",
      to: "18:23",
      cursor: stretch.nextCursor,
    });
    expect(rest.lines).toBe("[18:20] Microphone: Line 1094. Line 1095. Line 1096.");
    expect(rest.nextCursor).toBeNull();
  });
});
