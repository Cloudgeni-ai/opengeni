import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("recordings-import");
  if (!acquired) throw new Error("Transcript import tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
}, 60_000);

const noop = async () => undefined;
type SummaryStart = Parameters<
  NonNullable<SessionWorkflowClient["startImportedRecordingSummary"]>
>[0];

async function fixture() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Import fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [
      "workspace:read",
      "workspace:admin",
      "members:manage",
      "sessions:read",
      "sessions:create",
    ],
  });
  const summaries: SummaryStart[] = [];
  const transcribes: unknown[] = [];
  const app = createApp({
    db: db.db,
    bus: new MemoryEventBus(),
    settings: testSettings({
      productAccessMode: "configured",
      sandboxBackend: "none",
      publicBaseUrl: "https://opengeni.example",
      environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    }),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
      startRecordingWorkflow: async (input: unknown) => {
        transcribes.push(input);
      },
      startImportedRecordingSummary: async (input: SummaryStart) => {
        summaries.push(input);
      },
    } as unknown as SessionWorkflowClient,
    managedAuth: null,
  } as unknown as AppDependencies);
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const identity = await ensureExternalIdentity(db.db, {
    accountId,
    source,
    externalId: crypto.randomUUID(),
  });
  const added = await app.request(`/v1/workspaces/${workspace.id}/external-members`, {
    method: "POST",
    headers: service,
    body: JSON.stringify({
      identity: { source, externalId: identity.externalId },
      permissions: ["workspace:read", "sessions:read", "sessions:create"],
      operationId: crypto.randomUUID(),
    }),
  });
  expect(added.status).toBe(200);
  const headers = {
    ...service,
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { source, externalId: identity.externalId } }),
    ),
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`/v1/workspaces/${workspace.id}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { workspaceId: workspace.id, subjectId: identity.subjectId, call, summaries, transcribes };
}

const transcript = {
  title: "Planning call",
  startedAt: "2026-03-02T09:00:00.000Z",
  language: "en",
  externalRef: "other-tool:42",
  segments: [
    {
      startMilliseconds: 4_000,
      speaker: "Ana",
      text: "Then we ship the kestrel release on Friday.",
    },
    { startMilliseconds: 0, endMilliseconds: 3_500, speaker: " Ben ", text: "Morning, everyone." },
    { startMilliseconds: 9_000, text: "(inaudible)" },
    { startMilliseconds: 10_000, speaker: "Ben", text: "Sounds good to me" },
  ],
};

describe("importing a meeting transcript", () => {
  test("makes a ready meeting with no audio, its speakers named, once", async () => {
    const scope = await fixture();
    const recordingId = crypto.randomUUID();
    const imported = await scope.call("POST", "/recordings/import-transcript", {
      ...transcript,
      recordingId,
    });
    expect(imported.status).toBe(201);
    const meeting = imported.body;
    expect(meeting).toMatchObject({
      id: recordingId,
      purpose: "meeting",
      state: "ready",
      title: "Planning call",
      titleSource: "person",
      visibility: "private",
      externalRef: "other-tool:42",
      tracks: [],
      audioDeletedAt: null,
      startedAt: "2026-03-02T09:00:00.000Z",
      transcription: { language: "en" },
    });
    // The last segment ends four words' estimate after it starts.
    expect(meeting.durationMilliseconds).toBe(11_600);
    expect(meeting.transcript).toMatchObject({
      versionNumber: 1,
      providerId: "import",
      model: "text",
      state: "complete",
      isCurrent: true,
      languages: ["en"],
      diarized: false,
      diarization: "none",
      audioMilliseconds: 11_600,
      segmentCount: 4,
      costUsd: null,
    });
    expect(scope.summaries).toEqual([
      {
        accountId: expect.any(String),
        workspaceId: scope.workspaceId,
        recordingId,
        versionId: meeting.transcript.id,
        ownerSubjectId: scope.subjectId,
      },
    ]);

    const page = await scope.call("GET", `/recordings/${recordingId}/transcript`);
    expect(page.status).toBe(200);
    expect(
      page.body.segments.map((segment: Record<string, unknown>) => [
        segment.startMilliseconds,
        segment.endMilliseconds,
        segment.trackNumber,
        segment.speakerLabel,
        segment.text,
      ]),
    ).toEqual([
      [0, 3_500, null, "imported:1", "Morning, everyone."],
      [4_000, 9_000, null, "imported:2", "Then we ship the kestrel release on Friday."],
      [9_000, 10_000, null, null, "(inaudible)"],
      [10_000, 11_600, null, "imported:1", "Sounds good to me"],
    ]);
    expect(page.body.speakers).toEqual([
      { label: "imported:1", name: "Ben", personId: null, source: "confirmed", confidence: null },
      { label: "imported:2", name: "Ana", personId: null, source: "confirmed", confidence: null },
    ]);
    const assignments = await shared.admin`
      select speaker_label, display_name, person_id, source, assigned_by_subject_id
        from recording_speaker_assignments where recording_id = ${recordingId}
       order by speaker_label`;
    expect(assignments.map((row) => ({ ...row }))).toEqual([
      {
        speaker_label: "imported:1",
        display_name: "Ben",
        person_id: null,
        source: "confirmed",
        assigned_by_subject_id: scope.subjectId,
      },
      {
        speaker_label: "imported:2",
        display_name: "Ana",
        person_id: null,
        source: "confirmed",
        assigned_by_subject_id: scope.subjectId,
      },
    ]);
    const tracks = await shared.admin`
      select count(*)::int as count from recording_tracks where recording_id = ${recordingId}`;
    expect(tracks[0]!.count).toBe(0);

    const events = await shared.admin`
      select type, data from recording_events where recording_id = ${recordingId}
       order by occurred_at, type desc`;
    expect(events.map((event) => event.type)).toEqual([
      "recording.started",
      "recording.transcript.ready",
    ]);
    expect(events[1]!.data).toMatchObject({
      recordingId,
      state: "ready",
      versionId: meeting.transcript.id,
      providerId: "import",
      model: "text",
      segmentCount: 4,
      previousVersionId: null,
    });

    // The same id again is the same meeting; its notes are asked for again,
    // for the same version, which the workflow id makes a no-op once run.
    const repeat = await scope.call("POST", "/recordings/import-transcript", {
      ...transcript,
      recordingId,
      title: "Something else",
    });
    expect(repeat.status).toBe(200);
    expect(repeat.body.title).toBe("Planning call");
    expect(repeat.body.transcript.id).toBe(meeting.transcript.id);
    expect(scope.summaries.map((start) => start.versionId)).toEqual([
      meeting.transcript.id,
      meeting.transcript.id,
    ]);
    const after = await shared.admin`
      select (select count(*)::int from recording_events where recording_id = ${recordingId}) as events,
             (select count(*)::int from recording_transcript_versions where recording_id = ${recordingId}) as versions,
             (select count(*)::int from recording_transcript_segments where recording_id = ${recordingId}) as segments`;
    expect({ ...after[0] }).toEqual({ events: 2, versions: 1, segments: 4 });
  });

  test("can't be transcribed again, but its speakers and text can be edited and searched", async () => {
    const scope = await fixture();
    const imported = await scope.call("POST", "/recordings/import-transcript", transcript);
    expect(imported.status).toBe(201);
    const recordingId = imported.body.id;

    const rerun = await scope.call("POST", `/recordings/${recordingId}/transcripts`, {});
    expect(rerun.status).toBe(409);
    expect(rerun.body.error.message).toBe(
      "This meeting was imported as text, so it has no audio to transcribe again.",
    );
    expect(rerun.body.error.details).toMatchObject({ code: "no_audio" });
    expect(scope.transcribes).toEqual([]);

    const renamed = await scope.call("PATCH", `/recordings/${recordingId}/speakers`, {
      assignments: [{ label: "imported:2", name: "Ana Lopez" }],
    });
    expect(renamed.status).toBe(200);
    expect(
      renamed.body.speakers.map((speaker: { label: string; name: string }) => [
        speaker.label,
        speaker.name,
      ]),
    ).toEqual([
      ["imported:1", "Ben"],
      ["imported:2", "Ana Lopez"],
    ]);

    const edited = await scope.call("PATCH", `/recordings/${recordingId}/segments`, {
      edits: [{ segmentIndex: 2, text: "Laughter." }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.segments).toEqual([
      expect.objectContaining({ index: 2, text: "Laughter.", edited: true }),
    ]);

    const found = await scope.call("GET", "/recordings?query=kestrel");
    expect(found.status).toBe(200);
    expect(found.body.recordings.map((recording: { id: string }) => recording.id)).toEqual([
      recordingId,
    ]);
    const missed = await scope.call("GET", "/recordings?query=pelican");
    expect(missed.body.recordings).toEqual([]);

    // Nothing to play.
    const audio = await scope.call("GET", `/recordings/${recordingId}/tracks/0/audio`);
    expect(audio.status).toBe(404);

    const deleted = await scope.call("DELETE", `/recordings/${recordingId}`);
    expect([200, 202, 204]).toContain(deleted.status);
    expect((await scope.call("GET", `/recordings/${recordingId}`)).status).toBe(404);
  });

  test("refuses a transcript that is too large or malformed, and a recorded meeting's id", async () => {
    const scope = await fixture();
    const big = "word ".repeat(1_999);
    const tooLarge = await scope.call("POST", "/recordings/import-transcript", {
      segments: Array.from({ length: 220 }, (_, index) => ({
        startMilliseconds: index * 1_000,
        text: big,
      })),
    });
    expect(tooLarge.status).toBe(400);
    expect(JSON.stringify(tooLarge.body)).toContain("larger than 2 MB");

    for (const segments of [
      [],
      [{ startMilliseconds: 5_000, endMilliseconds: 4_000, text: "Backwards" }],
      [{ startMilliseconds: 0, text: "   " }],
      [{ startMilliseconds: -1, text: "Before the start" }],
      [{ startMilliseconds: 0, speaker: "", text: "Nameless" }],
    ]) {
      expect((await scope.call("POST", "/recordings/import-transcript", { segments })).status).toBe(
        400,
      );
    }

    const recorded = await scope.call("POST", "/recordings", {
      recordingId: crypto.randomUUID(),
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
    });
    expect(recorded.status).toBe(201);
    const taken = await scope.call("POST", "/recordings/import-transcript", {
      recordingId: recorded.body.id,
      segments: [{ startMilliseconds: 0, text: "Hello" }],
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.details).toMatchObject({ code: "recording_id_taken" });
    expect(scope.summaries).toEqual([]);
  });
});
