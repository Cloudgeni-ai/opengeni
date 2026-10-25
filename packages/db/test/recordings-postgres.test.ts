import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  acceptOrganizationInvitation,
  appendRecordingLiveSegments,
  beginRecordingAudioExpiry,
  browserRecordingActionLogObjectKey,
  browserRecordingBundleObjectKey,
  browserRecordingVideoObjectKey,
  claimBrowserRecordingVideo,
  claimRecordingTranscriptVersion,
  completeBrowserRecordingVideo,
  completeRecordingAudioExpiry,
  completeRecordingTranscriptVersion,
  createBrowserRecording,
  createDb,
  createOrganizationInvitation,
  createRecording,
  createRecordingPerson,
  createRecordingTranscriptVersion,
  deleteWorkspace,
  ensureManagedAccessForUser,
  failBrowserRecordingVideo,
  failRecordingTranscriptVersion,
  finalizeRecording,
  findBrowserRecording,
  forgetRecordingPersonVoice,
  forgetWorkspaceRecordingVoices,
  getBrowserRecordingVideo,
  getRecording,
  getRecordingSearchDetails,
  getRecordingTranscriptPage,
  listDeletingRecordingObjectKeys,
  listDueRecordingRetention,
  listRecordingLiveSegments,
  listRecordingNotes,
  listRecordingPeople,
  listRecordings,
  listStalledRecordingWork,
  markRecordingChunksUploaded,
  markRecordingDeleting,
  purgeDeletingRecording,
  RecordingConflictError,
  RecordingForbiddenError,
  RecordingNotFoundError,
  rememberRecordingPersonVoice,
  reserveRecordingChunks,
  saveRecordingNote,
  setCurrentRecordingTranscriptVersion,
  startRecordingLiveTrack,
  updateRecordingSegments,
  updateRecordingSpeakers,
  updateWorkspaceSettings,
  type DbClient,
} from "../src";

// The production posture: a NOSUPERUSER NOBYPASSRLS migration owner and FORCE
// RLS, so the owner-run recovery inventory is bound by row security exactly as
// deployed. A superuser-owned database would hide a missing owner policy.
let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
const workspaceIds: string[] = [];

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("recordings-postgres");
  if (!shared) return;
  client = createDb(shared.appUrl, { searchPath: shared.schema });
}, 180_000);

afterAll(async () => {
  if (client) {
    for (const workspaceId of workspaceIds) {
      await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
    }
  }
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

/** A shared workspace with its owner and one more member. */
async function workspace() {
  const db = client!.db;
  const ownerUserId = `recording-owner-${crypto.randomUUID()}`;
  const memberUserId = `recording-member-${crypto.randomUUID()}`;
  const owner = `user:${ownerUserId}`;
  const member = `user:${memberUserId}`;
  const ownerAccess = await ensureManagedAccessForUser(db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Recording owner",
  });
  await ensureManagedAccessForUser(db, {
    userId: memberUserId,
    email: `${memberUserId}@example.test`,
    name: "Recording member",
  });
  workspaceIds.push(...ownerAccess.workspaceGrants.map((grant) => grant.workspaceId));
  const grant = ownerAccess.workspaceGrants.find(
    (candidate) => candidate.workspaceId === ownerAccess.defaultWorkspaceId,
  )!;
  const { accountId, workspaceId } = grant;
  const invitation = await createOrganizationInvitation(db, {
    organizationId: accountId,
    actorSubjectId: owner,
    operationId: crypto.randomUUID(),
    targetSubjectId: member,
    targetEmail: `${memberUserId}@example.test`,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(db, {
    organizationId: accountId,
    actorSubjectId: member,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${workspaceId}, ${member}, 'member', '["sessions:read"]'::jsonb)
    on conflict do nothing`;
  return { accountId, workspaceId, owner, member };
}

const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const transcription = { providerId: "elevenlabs", model: "scribe_v2", options: {} };

/** A finalized two-track recording whose version 1 is queued. */
async function finalizedRecording(
  scope: Awaited<ReturnType<typeof workspace>>,
  visibility: "private" | "workspace",
) {
  const db = client!.db;
  const recordingId = crypto.randomUUID();
  const actor = { workspaceId: scope.workspaceId, subjectId: scope.owner };
  await createRecording(db, {
    ...actor,
    accountId: scope.accountId,
    recordingId,
    title: "Weekly sync",
    visibility,
    externalRef: `project:${recordingId}`,
    tracks: [
      { trackNumber: 0, source: "microphone", mimeType: "audio/webm" },
      { trackNumber: 1, source: "system", mimeType: "audio/webm" },
    ],
  });
  for (const trackNumber of [0, 1]) {
    await reserveRecordingChunks(db, {
      ...actor,
      recordingId,
      trackNumber,
      chunks: [
        {
          chunkNumber: 0,
          byteLength: 100,
          sha256: sha(`${trackNumber}a`),
          startMilliseconds: 0,
          durationMilliseconds: 5_000,
        },
        {
          chunkNumber: 1,
          byteLength: 100,
          sha256: sha(`${trackNumber}b`),
          startMilliseconds: 5_000,
          durationMilliseconds: 5_000,
        },
      ],
    });
    await markRecordingChunksUploaded(db, {
      ...actor,
      recordingId,
      trackNumber,
      chunkNumbers: [0, 1],
    });
  }
  const versionId = crypto.randomUUID();
  const finalized = await finalizeRecording(db, {
    ...actor,
    recordingId,
    tracks: [
      { trackNumber: 0, chunkCount: 2 },
      { trackNumber: 1, chunkCount: 2 },
    ],
    transcription,
    versionId,
  });
  return { recordingId, versionId, actor, finalized };
}

describe("recordings", () => {
  test("private recordings are Only me; shared ones are visible to the workspace", async () => {
    if (!client) return;
    const db = client.db;
    const scope = await workspace();
    const mine = await finalizedRecording(scope, "private");
    const ours = await finalizedRecording(scope, "workspace");
    const memberActor = { workspaceId: scope.workspaceId, subjectId: scope.member };

    const ownerList = await listRecordings(db, mine.actor);
    expect(ownerList.recordings.map((recording) => recording.id).sort()).toEqual(
      [mine.recordingId, ours.recordingId].sort(),
    );
    const memberList = await listRecordings(db, memberActor);
    expect(memberList.recordings.map((recording) => recording.id)).toEqual([ours.recordingId]);
    await expect(
      getRecording(db, { ...memberActor, recordingId: mine.recordingId }),
    ).rejects.toBeInstanceOf(RecordingNotFoundError);
    const visible = await getRecording(db, { ...memberActor, recordingId: ours.recordingId });
    expect(visible.visibility).toBe("workspace");
    expect(visible.state).toBe("processing");
    expect(
      visible.tracks.map((track) => [track.source, track.chunkCount, track.durationMilliseconds]),
    ).toEqual([
      ["microphone", 2, 10_000],
      ["system", 2, 10_000],
    ]);
  });

  test("creating, reserving and finalizing again are idempotent; a reused id is refused", async () => {
    if (!client) return;
    const db = client.db;
    const scope = await workspace();
    const recording = await finalizedRecording(scope, "private");
    const again = await createRecording(db, {
      ...recording.actor,
      accountId: scope.accountId,
      recordingId: recording.recordingId,
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
    });
    expect(again.created).toBe(false);
    const refinalized = await finalizeRecording(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
      tracks: [
        { trackNumber: 0, chunkCount: 2 },
        { trackNumber: 1, chunkCount: 2 },
      ],
      transcription,
      versionId: crypto.randomUUID(),
    });
    expect(refinalized.finalized).toBe(false);
    expect(refinalized.version.id).toBe(recording.versionId);
    await expect(
      createRecording(db, {
        workspaceId: scope.workspaceId,
        subjectId: scope.member,
        accountId: scope.accountId,
        recordingId: recording.recordingId,
        tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
      }),
    ).rejects.toBeInstanceOf(RecordingConflictError);
  });

  test("transcript versions, speaker naming and carried-over track speakers", async () => {
    if (!client) return;
    const db = client.db;
    const scope = await workspace();
    const recording = await finalizedRecording(scope, "workspace");
    const owner = crypto.randomUUID();
    const job = await claimRecordingTranscriptVersion(db, {
      ...recording.actor,
      versionId: recording.versionId,
      processingOwner: owner,
      leaseSeconds: 600,
    });
    expect(job?.chunks).toHaveLength(4);
    expect(
      await claimRecordingTranscriptVersion(db, {
        ...recording.actor,
        versionId: recording.versionId,
        processingOwner: crypto.randomUUID(),
        leaseSeconds: 600,
      }),
    ).toBeNull();
    // The same workflow takes its own lease back after a crash.
    expect(
      (
        await claimRecordingTranscriptVersion(db, {
          ...recording.actor,
          versionId: recording.versionId,
          processingOwner: owner,
          leaseSeconds: 600,
        })
      )?.version.id,
    ).toBe(recording.versionId);
    const completed = await completeRecordingTranscriptVersion(db, {
      ...recording.actor,
      versionId: recording.versionId,
      processingOwner: owner,
      languages: ["en"],
      diarized: true,
      diarization: "provider",
      audioMilliseconds: 10_000,
      segments: [
        {
          startMilliseconds: 0,
          endMilliseconds: 2_000,
          trackNumber: 0,
          speakerLabel: "track-0",
          text: "Hi all.",
        },
        {
          startMilliseconds: 2_100,
          endMilliseconds: 4_000,
          trackNumber: 1,
          speakerLabel: "speaker_0",
          text: "Hello.",
        },
        {
          startMilliseconds: 4_100,
          endMilliseconds: 6_000,
          trackNumber: 1,
          speakerLabel: "speaker_1",
          text: "Budget is fine.",
        },
      ],
      trackSpeakers: [{ label: "track-0", displayName: "Recording owner" }],
    });
    expect(completed?.state).toBe("complete");
    expect(completed?.isCurrent).toBe(true);

    const page = await getRecordingTranscriptPage(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
    });
    expect(page.segments.map((segment) => segment.text)).toEqual([
      "Hi all.",
      "Hello.",
      "Budget is fine.",
    ]);
    expect(page.speakers.find((speaker) => speaker.label === "track-0")?.name).toBe(
      "Recording owner",
    );

    const { person } = await createRecordingPerson(db, {
      ...recording.actor,
      accountId: scope.accountId,
      personId: crypto.randomUUID(),
      displayName: "Kari",
    });
    const speakers = await updateRecordingSpeakers(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
      assignments: [
        { label: "speaker_0", personId: person.id },
        { label: "speaker_1", name: "Ola" },
      ],
      segmentOverrides: [{ segmentIndex: 2, label: "speaker_0" }],
    });
    expect(speakers.find((speaker) => speaker.label === "speaker_0")?.name).toBe("Kari");
    const renamed = await getRecordingTranscriptPage(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
    });
    expect(renamed.segments[2]?.speakerLabel).toBe("speaker_0");

    // Text corrections are a layer: the original comes back when cleared.
    const corrected = await updateRecordingSegments(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
      edits: [{ segmentIndex: 1, text: "Hello there." }],
    });
    expect(corrected[0]).toMatchObject({
      text: "Hello there.",
      edited: true,
      speakerLabel: "speaker_0",
    });
    await updateRecordingSegments(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
      edits: [{ segmentIndex: 1, text: "Hello." }],
    });
    const reverted = await getRecordingTranscriptPage(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
    });
    expect(reverted.segments[1]).toMatchObject({ text: "Hello.", edited: false });
    expect(reverted.segments[2]?.speakerLabel).toBe("speaker_0");

    // A member of a shared recording may name speakers too, but only the owner deletes.
    await updateRecordingSpeakers(db, {
      workspaceId: scope.workspaceId,
      subjectId: scope.member,
      recordingId: recording.recordingId,
      assignments: [{ label: "speaker_1", name: "Ola Nordmann" }],
    });
    await expect(
      markRecordingDeleting(db, {
        workspaceId: scope.workspaceId,
        subjectId: scope.member,
        recordingId: recording.recordingId,
      }),
    ).rejects.toBeInstanceOf(RecordingForbiddenError);

    // Version 2 on another model: the microphone owner's name carries over by
    // label, and Kari carries over to the new label that overlaps her speech.
    const version2 = await createRecordingTranscriptVersion(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
      versionId: crypto.randomUUID(),
      transcription: { providerId: "elevenlabs", model: "scribe_v3", options: {} },
    });
    expect(version2.versionNumber).toBe(2);
    const owner2 = crypto.randomUUID();
    await claimRecordingTranscriptVersion(db, {
      ...recording.actor,
      versionId: version2.id,
      processingOwner: owner2,
      leaseSeconds: 600,
    });
    await completeRecordingTranscriptVersion(db, {
      ...recording.actor,
      versionId: version2.id,
      processingOwner: owner2,
      languages: ["en"],
      diarized: true,
      diarization: "provider",
      audioMilliseconds: 10_000,
      segments: [
        {
          startMilliseconds: 0,
          endMilliseconds: 2_000,
          trackNumber: 0,
          speakerLabel: "track-0",
          text: "Hi, all.",
        },
        {
          startMilliseconds: 2_000,
          endMilliseconds: 4_000,
          trackNumber: 1,
          speakerLabel: "speaker_9",
          text: "Hello.",
        },
        {
          startMilliseconds: 4_000,
          endMilliseconds: 6_100,
          trackNumber: 1,
          speakerLabel: "speaker_9",
          text: "Budget's fine.",
        },
        {
          startMilliseconds: 8_000,
          endMilliseconds: 9_000,
          trackNumber: 1,
          speakerLabel: "speaker_4",
          text: "New voice.",
        },
      ],
    });
    const current = await getRecordingTranscriptPage(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
    });
    expect(current.version.versionNumber).toBe(2);
    expect(current.speakers.find((speaker) => speaker.label === "track-0")?.name).toBe(
      "Recording owner",
    );
    expect(current.speakers.find((speaker) => speaker.label === "speaker_9")).toMatchObject({
      name: "Kari",
      personId: person.id,
      source: "carried_over",
    });
    // A label nobody named gets the default name every client also shows.
    expect(current.speakers.find((speaker) => speaker.label === "speaker_4")).toMatchObject({
      name: "Speaker 5",
      personId: null,
      source: null,
    });
    const first = await getRecordingTranscriptPage(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
      versionId: recording.versionId,
    });
    expect(first.version.isCurrent).toBe(false);
    expect(first.segments).toHaveLength(3);

    // Switching back makes version 1 current again.
    const switched = await setCurrentRecordingTranscriptVersion(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
      versionId: recording.versionId,
    });
    expect(switched.isCurrent).toBe(true);
    const after = await getRecordingTranscriptPage(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
    });
    expect(after.version.versionNumber).toBe(1);
  });

  test("search finds title words, transcript word prefixes and corrected words", async () => {
    if (!client) return;
    const db = client.db;
    const scope = await workspace();
    const recording = await finalizedRecording(scope, "private");
    const owner = crypto.randomUUID();
    await claimRecordingTranscriptVersion(db, {
      ...recording.actor,
      versionId: recording.versionId,
      processingOwner: owner,
      leaseSeconds: 600,
    });
    await completeRecordingTranscriptVersion(db, {
      ...recording.actor,
      versionId: recording.versionId,
      processingOwner: owner,
      languages: ["en"],
      diarized: true,
      diarization: "provider",
      audioMilliseconds: 10_000,
      segments: [
        {
          startMilliseconds: 0,
          endMilliseconds: 2_000,
          trackNumber: 0,
          speakerLabel: "track-0",
          text: "The onboarding numbers are up.",
        },
        {
          startMilliseconds: 2_100,
          endMilliseconds: 4_000,
          trackNumber: 1,
          speakerLabel: "speaker_0",
          text: "Pricing page next.",
        },
      ],
      trackSpeakers: [{ label: "track-0", displayName: "Recording owner" }],
    });
    const found = async (query: string) =>
      (await listRecordings(db, { ...recording.actor, query })).recordings.map((entry) => entry.id);
    expect(await found("weekly sy")).toEqual([recording.recordingId]);
    // While someone is still typing a word, and with words out of order.
    expect(await found("onboard")).toEqual([recording.recordingId]);
    expect(await found("numbers ONBOARD")).toEqual([recording.recordingId]);
    expect(await found("onboarding budget")).toEqual([]);
    // Punctuation alone searches titles only, and quotes can't break the query.
    expect(await found("!!")).toEqual([]);
    expect(await found("o'nboard & pricing")).toEqual([]);
    expect(await found("'pricing'")).toEqual([recording.recordingId]);
    // A corrected segment is found by its new words and no longer by the old ones.
    await updateRecordingSegments(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
      edits: [{ segmentIndex: 1, text: "Packaging page next." }],
    });
    expect(await found("packag")).toEqual([recording.recordingId]);
    expect(await found("pricing")).toEqual([]);
  });

  test("a failed first version fails the recording and records the event", async () => {
    if (!client || !shared) return;
    const db = client.db;
    const scope = await workspace();
    const recording = await finalizedRecording(scope, "private");
    const owner = crypto.randomUUID();
    await claimRecordingTranscriptVersion(db, {
      ...recording.actor,
      versionId: recording.versionId,
      processingOwner: owner,
      leaseSeconds: 600,
    });
    const failed = await failRecordingTranscriptVersion(db, {
      ...recording.actor,
      versionId: recording.versionId,
      processingOwner: owner,
      errorCode: "provider_rejected",
    });
    expect(failed?.state).toBe("failed");
    const view = await getRecording(db, { ...recording.actor, recordingId: recording.recordingId });
    expect(view.state).toBe("failed");
    const events = await shared.admin<{ type: string }[]>`
      select type from recording_events where recording_id = ${recording.recordingId} order by occurred_at`;
    expect(events.map((event) => event.type)).toEqual([
      "recording.started",
      "recording.finished",
      "recording.transcript.failed",
    ]);
  });

  test("recording events reach workspace and organization webhooks without titles", async () => {
    if (!client || !shared) return;
    const db = client.db;
    const scope = await workspace();
    const [workspaceHook] = await shared.admin<{ id: string }[]>`
      insert into workspace_webhooks (account_id, workspace_id, url, secret_encrypted, event_types, enabled)
      values (${scope.accountId}, ${scope.workspaceId}, 'https://hooks.example.test/ws', 'x',
        array['recording.finished','recording.deleted'], true)
      returning id`;
    const [organizationHook] = await shared.admin<{ id: string }[]>`
      insert into organization_webhooks (account_id, url, secret_encrypted, event_types, enabled)
      values (${scope.accountId}, 'https://hooks.example.test/org', 'x',
        array['recording.finished'], true)
      returning id`;
    const recording = await finalizedRecording(scope, "workspace");
    const workspaceDeliveries = await shared.admin<
      { event_type: string; payload: Record<string, unknown> }[]
    >`
      select event_type, payload from workspace_webhook_deliveries where webhook_id = ${workspaceHook!.id}`;
    expect(workspaceDeliveries.map((delivery) => delivery.event_type)).toEqual([
      "recording.finished",
    ]);
    const payload = workspaceDeliveries[0]!.payload as {
      type: string;
      lane: string;
      workspaceId: string;
      data: Record<string, unknown>;
    };
    expect(payload.lane).toBe("workspace");
    expect(payload.workspaceId).toBe(scope.workspaceId);
    expect(payload.data).toMatchObject({
      recordingId: recording.recordingId,
      visibility: "workspace",
      versionId: recording.versionId,
      externalRef: `project:${recording.recordingId}`,
    });
    expect(JSON.stringify(payload)).not.toContain("Weekly sync");
    const organizationDeliveries = await shared.admin<{ payload: { lane: string } }[]>`
      select payload from organization_webhook_deliveries where webhook_id = ${organizationHook!.id}`;
    expect(organizationDeliveries.map((delivery) => delivery.payload.lane)).toEqual([
      "organization",
    ]);

    await markRecordingDeleting(db, { ...recording.actor, recordingId: recording.recordingId });
    const afterDelete = await shared.admin<{ event_type: string }[]>`
      select event_type from workspace_webhook_deliveries where webhook_id = ${workspaceHook!.id}
      order by created_at`;
    expect(afterDelete.map((delivery) => delivery.event_type)).toEqual([
      "recording.finished",
      "recording.deleted",
    ]);
  });

  test("deleting hides the recording at once, lists its media, then purges its rows", async () => {
    if (!client || !shared) return;
    const db = client.db;
    const scope = await workspace();
    const recording = await finalizedRecording(scope, "workspace");
    expect(
      await listDeletingRecordingObjectKeys(db, {
        ...recording.actor,
        recordingId: recording.recordingId,
      }),
    ).toBeNull();
    expect(
      await purgeDeletingRecording(db, { ...recording.actor, recordingId: recording.recordingId }),
    ).toBe(false);

    await markRecordingDeleting(db, { ...recording.actor, recordingId: recording.recordingId });
    await markRecordingDeleting(db, { ...recording.actor, recordingId: recording.recordingId });
    await expect(
      getRecording(db, { ...recording.actor, recordingId: recording.recordingId }),
    ).rejects.toBeInstanceOf(RecordingNotFoundError);
    expect((await listRecordings(db, recording.actor)).recordings).toHaveLength(0);
    await expect(
      claimRecordingTranscriptVersion(db, {
        ...recording.actor,
        versionId: recording.versionId,
        processingOwner: crypto.randomUUID(),
        leaseSeconds: 600,
      }),
    ).resolves.toBeNull();

    const keys = await listDeletingRecordingObjectKeys(db, {
      ...recording.actor,
      recordingId: recording.recordingId,
    });
    expect(keys).toHaveLength(4);
    expect(
      keys!.every((key) =>
        key.startsWith(`workspaces/${scope.workspaceId}/recordings/${recording.recordingId}/`),
      ),
    ).toBe(true);
    expect(
      await purgeDeletingRecording(db, { ...recording.actor, recordingId: recording.recordingId }),
    ).toBe(true);
    const [rows] = await shared.admin<{ recordings: number; chunks: number; events: number }[]>`
      select
        (select count(*)::int from recordings where id = ${recording.recordingId}) as recordings,
        (select count(*)::int from recording_chunks where recording_id = ${recording.recordingId}) as chunks,
        (select count(*)::int from recording_events where recording_id = ${recording.recordingId}) as events`;
    expect(rows).toEqual({ recordings: 0, chunks: 0, events: 3 });
  });

  test("the recovery sweep finds stalled transcripts and deletions", async () => {
    if (!client || !shared) return;
    const db = client.db;
    const scope = await workspace();
    const recording = await finalizedRecording(scope, "private");
    const mine = async () =>
      (await listStalledRecordingWork(db, 200)).filter(
        (work) => work.recordingId === recording.recordingId,
      );
    expect(await mine()).toEqual([]);
    await shared.admin`
      update recording_transcript_versions set created_at = now() - interval '5 minutes'
      where id = ${recording.versionId}`;
    expect(await mine()).toEqual([
      {
        kind: "transcript",
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        recordingId: recording.recordingId,
        versionId: recording.versionId,
        ownerSubjectId: scope.owner,
      },
    ]);
    await markRecordingDeleting(db, { ...recording.actor, recordingId: recording.recordingId });
    await shared.admin`
      update recordings set updated_at = now() - interval '5 minutes'
      where id = ${recording.recordingId}`;
    expect(await mine()).toEqual([
      {
        kind: "deletion",
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        recordingId: recording.recordingId,
        versionId: null,
        ownerSubjectId: scope.owner,
      },
    ]);
  });

  test("retention deletes old audio and keeps the transcript, then deletes old meetings", async () => {
    if (!client || !shared) return;
    const db = client.db;
    const scope = await workspace();
    const recording = await finalizedRecording(scope, "private");
    const id = recording.recordingId;
    const mine = async () =>
      (await listDueRecordingRetention(db, 200)).filter((due) => due.recordingId === id);
    const due = (kind: "audio" | "recording") => ({
      kind,
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      recordingId: id,
      ownerSubjectId: scope.owner,
    });
    // Ten days old, transcribed, with prepared audio for playback.
    await shared.admin`
      update recordings set state = 'ready',
        capture_ended_at = now() - interval '10 days', started_at = now() - interval '10 days'
      where id = ${id}`;
    await shared.admin`
      update recording_transcript_versions set state = 'complete', completed_at = now(), is_current = true
      where id = ${recording.versionId}`;
    await shared.admin`
      update recording_tracks set prepared_bytes = 100,
        prepared_object_key = ${`workspaces/${scope.workspaceId}/recordings/${id}/prepared/0.ogg`}
      where recording_id = ${id} and track_number = 0`;
    // Nothing is due until the workspace sets a period that has passed.
    expect(await mine()).toEqual([]);
    await updateWorkspaceSettings(db, scope.workspaceId, {
      recordings: { retention: { audioDays: 30, transcriptDays: 365 } },
    });
    expect(await mine()).toEqual([]);
    await updateWorkspaceSettings(db, scope.workspaceId, {
      recordings: { retention: { audioDays: 7, transcriptDays: 365 } },
    });
    expect(await mine()).toEqual([due("audio")]);

    // Only the owner acts on it; the audio objects come back for deletion.
    const keys = await beginRecordingAudioExpiry(db, { ...recording.actor, recordingId: id });
    expect(keys?.sort()).toEqual(
      [
        ...(
          await shared.admin<{ object_key: string }[]>`
          select object_key from recording_chunks where recording_id = ${id}`
        ).map((row) => row.object_key),
        `workspaces/${scope.workspaceId}/recordings/${id}/prepared/0.ogg`,
      ].sort(),
    );
    // Stamped but interrupted before the objects were gone: offered again,
    // and beginning again returns the same objects.
    expect(await mine()).toEqual([due("audio")]);
    expect(
      (await beginRecordingAudioExpiry(db, { ...recording.actor, recordingId: id }))?.sort(),
    ).toEqual(keys?.sort());
    await completeRecordingAudioExpiry(db, { ...recording.actor, recordingId: id });
    const after = await getRecording(db, { ...recording.actor, recordingId: id });
    expect(after.audioDeletedAt).not.toBeNull();
    expect(
      await shared.admin`select 1 from recording_chunks where recording_id = ${id}`,
    ).toHaveLength(0);
    expect(after.tracks.some((track) => track.playable)).toBe(false);
    expect(after.transcript?.state).toBe("complete");
    expect(await mine()).toEqual([]);
    // Without the audio, it can't be transcribed again.
    await expect(
      createRecordingTranscriptVersion(db, {
        ...recording.actor,
        recordingId: id,
        versionId: crypto.randomUUID(),
        transcription,
      }),
    ).rejects.toMatchObject({ code: "audio_deleted" });

    // Past the transcript period, the whole meeting is due for deletion.
    await updateWorkspaceSettings(db, scope.workspaceId, {
      recordings: { retention: { audioDays: 1, transcriptDays: 5 } },
    });
    expect(await mine()).toEqual([due("recording")]);
    await markRecordingDeleting(db, { ...recording.actor, recordingId: id });
    expect(await mine()).toEqual([]);
  });

  test("remembered voices: consent, learning from confirmed speakers, suggestions and forgetting", async () => {
    if (!client || !shared) return;
    const db = client.db;
    const scope = await workspace();
    await updateWorkspaceSettings(db, scope.workspaceId, { recordings: { voiceprints: true } });
    const ownerActor = { workspaceId: scope.workspaceId, subjectId: scope.owner };
    const memberActor = { workspaceId: scope.workspaceId, subjectId: scope.member };
    const ingrid = (
      await createRecordingPerson(db, {
        ...ownerActor,
        accountId: scope.accountId,
        personId: crypto.randomUUID(),
        displayName: "Ingrid",
      })
    ).person;
    const me = (
      await createRecordingPerson(db, {
        ...ownerActor,
        accountId: scope.accountId,
        personId: crypto.randomUUID(),
        displayName: "Recording owner",
        memberSubjectId: scope.owner,
      })
    ).person;
    expect(ingrid.voice).toBeNull();

    // Members agree only for themselves; someone attests for an outsider.
    await expect(
      rememberRecordingPersonVoice(db, { ...memberActor, personId: me.id, consent: "self" }),
    ).rejects.toBeInstanceOf(RecordingForbiddenError);
    await expect(
      rememberRecordingPersonVoice(db, { ...ownerActor, personId: me.id, consent: "attested" }),
    ).rejects.toBeInstanceOf(RecordingForbiddenError);
    await expect(
      rememberRecordingPersonVoice(db, { ...ownerActor, personId: ingrid.id, consent: "self" }),
    ).rejects.toBeInstanceOf(RecordingForbiddenError);
    expect(
      (await rememberRecordingPersonVoice(db, { ...ownerActor, personId: me.id, consent: "self" }))
        .voice,
    ).toMatchObject({ consent: "self", learned: false });

    const model = "test-model";
    const ingridVoice = [0.9, 0.1, 0.05, 0];
    const otherVoice = [0, 0.2, 1, 0.1];
    async function transcribe(
      recording: { recordingId: string; actor: typeof ownerActor },
      versionId: string,
      voices: Array<[string, number[]]>,
    ) {
      const lease = crypto.randomUUID();
      await claimRecordingTranscriptVersion(db, {
        ...recording.actor,
        versionId,
        processingOwner: lease,
        leaseSeconds: 600,
      });
      await completeRecordingTranscriptVersion(db, {
        ...recording.actor,
        versionId,
        processingOwner: lease,
        languages: ["en"],
        diarized: true,
        diarization: "ours",
        audioMilliseconds: 60_000,
        segments: voices.map(([label], index) => ({
          startMilliseconds: index * 10_000,
          endMilliseconds: index * 10_000 + 9_000,
          trackNumber: 1,
          speakerLabel: label,
          text: `Line ${index}.`,
        })),
        voices: voices.map(([label, embedding]) => ({
          label,
          channel: "call",
          model,
          embedding,
          speechMilliseconds: 30_000,
        })),
      });
      return (
        await getRecordingTranscriptPage(db, {
          ...recording.actor,
          recordingId: recording.recordingId,
          versionId,
        })
      ).speakers;
    }

    // Nobody is remembered yet, so nothing is suggested.
    const first = await finalizedRecording(scope, "workspace");
    const firstSpeakers = await transcribe(first, first.versionId, [
      ["speaker_0", ingridVoice],
      ["speaker_1", otherVoice],
    ]);
    expect(firstSpeakers.filter((speaker) => speaker.source === "suggested")).toEqual([]);

    // Confirming Ingrid before she is remembered teaches nothing; agreeing
    // afterwards learns from the speakers already confirmed as her.
    await updateRecordingSpeakers(db, {
      ...ownerActor,
      recordingId: first.recordingId,
      assignments: [{ label: "speaker_0", personId: ingrid.id }],
    });
    const remembered = await rememberRecordingPersonVoice(db, {
      ...ownerActor,
      personId: ingrid.id,
      consent: "attested",
    });
    expect(remembered.voice).toMatchObject({ consent: "attested", learned: true });

    // A later meeting suggests her for the voice that sounds like her.
    const second = await finalizedRecording(scope, "workspace");
    const secondSpeakers = await transcribe(second, second.versionId, [
      ["speaker_0", otherVoice],
      ["speaker_1", [0.88, 0.12, 0.02, 0.01]],
    ]);
    const suggested = secondSpeakers.find((speaker) => speaker.label === "speaker_1");
    expect(suggested).toMatchObject({ personId: ingrid.id, name: "Ingrid", source: "suggested" });
    expect(suggested?.confidence).toBeGreaterThan(0.9);
    expect(secondSpeakers.find((speaker) => speaker.label === "speaker_0")?.source).toBeNull();

    // "Not them" is remembered for that voice, across versions.
    const turnedDown = await updateRecordingSpeakers(db, {
      ...ownerActor,
      recordingId: second.recordingId,
      rejectSuggestions: [{ label: "speaker_1" }],
    });
    expect(turnedDown.find((speaker) => speaker.label === "speaker_1")?.source).toBeNull();
    const again = await createRecordingTranscriptVersion(db, {
      ...ownerActor,
      recordingId: second.recordingId,
      versionId: crypto.randomUUID(),
      transcription,
    });
    const againSpeakers = await transcribe(second, again.id, [
      ["speaker_0", [0.87, 0.13, 0.03, 0]],
      ["speaker_1", otherVoice],
    ]);
    expect(againSpeakers.filter((speaker) => speaker.source === "suggested")).toEqual([]);

    // Renaming the confirmed speaker takes the voice back out of her print.
    await updateRecordingSpeakers(db, {
      ...ownerActor,
      recordingId: first.recordingId,
      assignments: [{ label: "speaker_0", name: "Someone else" }],
    });
    const peopleAfterRename = await listRecordingPeople(db, ownerActor);
    expect(peopleAfterRename.find((person) => person.id === ingrid.id)?.voice).toMatchObject({
      learned: false,
    });
    await updateRecordingSpeakers(db, {
      ...ownerActor,
      recordingId: first.recordingId,
      assignments: [{ label: "speaker_0", personId: ingrid.id }],
    });
    expect(
      (await listRecordingPeople(db, ownerActor)).find((person) => person.id === ingrid.id)?.voice,
    ).toMatchObject({ learned: true });

    // Members forget only their own voice; anyone may forget an outsider's.
    await expect(
      forgetRecordingPersonVoice(db, { ...memberActor, personId: me.id }),
    ).rejects.toBeInstanceOf(RecordingForbiddenError);
    expect(
      (await forgetRecordingPersonVoice(db, { ...memberActor, personId: ingrid.id })).voice,
    ).toBeNull();
    const [afterForget] = await shared.admin<{ prints: number }[]>`
      select count(*)::int as prints from recording_voiceprints where person_id = ${ingrid.id}`;
    expect(afterForget).toEqual({ prints: 0 });

    // Turning recognition off forgets every voice in the workspace.
    await rememberRecordingPersonVoice(db, {
      ...ownerActor,
      personId: ingrid.id,
      consent: "attested",
    });
    await forgetWorkspaceRecordingVoices(db, ownerActor);
    const [afterOff] = await shared.admin<
      { prints: number; voices: number; rejections: number; consents: number }[]
    >`
      select
        (select count(*)::int from recording_voiceprints where workspace_id = ${scope.workspaceId}) as prints,
        (select count(*)::int from recording_speaker_voices where workspace_id = ${scope.workspaceId}) as voices,
        (select count(*)::int from recording_voice_rejections where workspace_id = ${scope.workspaceId}) as rejections,
        (select count(*)::int from recording_people where workspace_id = ${scope.workspaceId} and voice_consent is not null) as consents`;
    expect(afterOff).toEqual({ prints: 0, voices: 0, rejections: 0, consents: 0 });
  });

  test("notes: the notepad and the notes, revisions, conflicts and who can see them", async () => {
    if (!client) return;
    const db = client.db;
    const scope = await workspace();
    const ours = await finalizedRecording(scope, "workspace");
    const mine = await finalizedRecording(scope, "private");
    const memberActor = { workspaceId: scope.workspaceId, subjectId: scope.member };
    const at = { ...ours.actor, recordingId: ours.recordingId };

    expect(await listRecordingNotes(db, at)).toEqual([]);
    const jotted = await saveRecordingNote(db, {
      ...at,
      kind: "notepad",
      body: "- ask about the budget",
      expectedRevision: 0,
    });
    expect(jotted).toMatchObject({
      kind: "notepad",
      revision: 1,
      updatedBy: { subjectId: scope.owner, sessionId: null },
    });
    const sessionId = crypto.randomUUID();
    const written = await saveRecordingNote(db, {
      ...at,
      kind: "notes",
      body: "## Summary\n\nBudget approved.",
      sessionId,
    });
    expect(written).toMatchObject({ kind: "notes", revision: 1, updatedBy: { sessionId } });

    // A stale revision is refused; the same text again changes nothing.
    const stale = saveRecordingNote(db, {
      ...at,
      kind: "notepad",
      body: "- something else",
      expectedRevision: 0,
    });
    await expect(stale).rejects.toBeInstanceOf(RecordingConflictError);
    await expect(stale).rejects.toMatchObject({ code: "notes_changed" });
    const same = await saveRecordingNote(db, {
      ...at,
      kind: "notepad",
      body: "- ask about the budget",
      expectedRevision: 1,
    });
    expect(same.revision).toBe(1);
    const edited = await saveRecordingNote(db, {
      ...at,
      kind: "notepad",
      body: "- ask about the budget\n- book the room",
      expectedRevision: 1,
    });
    expect(edited.revision).toBe(2);

    // Anyone who can see the meeting reads and writes its notes; a private one stays hidden.
    const memberView = await listRecordingNotes(db, { ...memberActor, recordingId: ours.recordingId });
    expect(memberView.map((note) => [note.kind, note.revision])).toEqual([
      ["notepad", 2],
      ["notes", 1],
    ]);
    await expect(
      listRecordingNotes(db, { ...memberActor, recordingId: mine.recordingId }),
    ).rejects.toBeInstanceOf(RecordingNotFoundError);
    await expect(
      saveRecordingNote(db, { ...memberActor, recordingId: mine.recordingId, kind: "notes", body: "x" }),
    ).rejects.toBeInstanceOf(RecordingNotFoundError);

    // Only the notes are an event, once per change.
    const events = await shared!.admin<{ type: string; data: Record<string, unknown> }[]>`
      select type, data from recording_events
      where recording_id = ${ours.recordingId} and type = 'recording.notes.updated'`;
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ noteKind: "notes", noteRevision: 1, sessionId });
    expect(JSON.stringify(events[0]!.data)).not.toContain("Budget");

    // Deleting the meeting deletes its notes.
    await markRecordingDeleting(db, at);
    expect(await purgeDeletingRecording(db, at)).toBe(true);
    const [left] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from recording_notes where recording_id = ${ours.recordingId}`;
    expect(left!.count).toBe(0);
  });

  test("deleting the workspace removes its recordings", async () => {
    if (!client || !shared) return;
    const scope = await workspace();
    const recording = await finalizedRecording(scope, "workspace");
    await deleteWorkspace(client.db, scope.workspaceId);
    const [rows] = await shared.admin<{ recordings: number; events: number }[]>`
      select
        (select count(*)::int from recordings where id = ${recording.recordingId}) as recordings,
        (select count(*)::int from recording_events where recording_id = ${recording.recordingId}) as events`;
    expect(rows).toEqual({ recordings: 0, events: 0 });
  });

  test("a browser recording: one video track from its bundle, kept out of meetings", async () => {
    if (!client) return;
    const db = client.db;
    const scope = await workspace();
    const actor = { workspaceId: scope.workspaceId, subjectId: scope.owner };
    const recordingId = crypto.randomUUID();
    const input = {
      ...actor,
      accountId: scope.accountId,
      recordingId,
      visibility: "workspace" as const,
      startedAt: new Date("2026-10-24T08:00:00.000Z"),
      durationMilliseconds: 12_345.6,
      bundle: { byteLength: 4_096, sha256: sha("e") },
    };
    expect(await findBrowserRecording(db, { ...actor, recordingId })).toBeNull();
    const created = await createBrowserRecording(db, input);
    expect(created.created).toBe(true);
    expect(created.recording).toMatchObject({
      purpose: "browser",
      state: "processing",
      visibility: "workspace",
      durationMilliseconds: 12_346,
      errorCode: null,
      captureEndedAt: "2026-10-24T08:00:12.346Z",
    });
    expect(created.recording.tracks).toEqual([
      expect.objectContaining({
        trackNumber: 0,
        kind: "video",
        source: "browser_tab",
        chunkCount: 1,
        totalBytes: 4_096,
        video: null,
      }),
    ]);
    // Creating it again changes nothing; another bundle under the same id is refused.
    expect((await createBrowserRecording(db, input)).created).toBe(false);
    await expect(
      createBrowserRecording(db, { ...input, bundle: { byteLength: 4_096, sha256: sha("f") } }),
    ).rejects.toMatchObject({ code: "recording_id_taken" });
    // Meeting lists and transcripts are for meetings only.
    expect((await listRecordings(db, actor)).recordings).toHaveLength(0);
    expect(
      (await listRecordings(db, { ...actor, purpose: "browser" })).recordings.map(
        (recording) => recording.id,
      ),
    ).toEqual([recordingId]);
    await expect(
      createRecordingTranscriptVersion(db, {
        ...actor,
        recordingId,
        versionId: crypto.randomUUID(),
        transcription,
      }),
    ).rejects.toMatchObject({ code: "not_a_meeting" });

    const job = await claimBrowserRecordingVideo(db, { ...actor, recordingId });
    expect(job?.bundle).toEqual({
      objectKey: browserRecordingBundleObjectKey({ ...actor, recordingId, sha256: sha("e") }),
      sha256: sha("e"),
    });
    expect(await getBrowserRecordingVideo(db, { ...actor, recordingId })).toBeNull();
    const videoKey = browserRecordingVideoObjectKey({ ...actor, recordingId });
    const video = {
      objectKey: videoKey,
      bytes: 2_000,
      sha256: sha("a"),
      durationMilliseconds: 12_000,
      width: 1280,
      height: 720,
      frameCount: 60,
    };
    expect(await completeBrowserRecordingVideo(db, { ...actor, recordingId, video })).toBe(true);
    expect(await completeBrowserRecordingVideo(db, { ...actor, recordingId, video })).toBe(false);
    expect(await claimBrowserRecordingVideo(db, { ...actor, recordingId })).toBeNull();
    expect(await getBrowserRecordingVideo(db, { ...actor, recordingId })).toEqual({
      objectKey: videoKey,
      actionLogObjectKey: browserRecordingActionLogObjectKey({ ...actor, recordingId }),
      bytes: 2_000,
      sha256: sha("a"),
      durationMilliseconds: 12_000,
      width: 1280,
      height: 720,
      frameCount: 60,
    });
    const ready = await findBrowserRecording(db, {
      workspaceId: scope.workspaceId,
      subjectId: scope.member,
      recordingId,
    });
    expect(ready?.recording.state).toBe("ready");
    expect(ready?.recording.tracks[0]).toMatchObject({
      kind: "video",
      playable: true,
      video: { width: 1280, height: 720, frameCount: 60 },
    });

    await markRecordingDeleting(db, { ...actor, recordingId });
    expect((await listDeletingRecordingObjectKeys(db, { ...actor, recordingId }))?.sort()).toEqual(
      [
        browserRecordingBundleObjectKey({ ...actor, recordingId, sha256: sha("e") }),
        videoKey,
        browserRecordingActionLogObjectKey({ ...actor, recordingId }),
      ].sort(),
    );
  });

  test("a browser recording whose video failed says why", async () => {
    if (!client) return;
    const db = client.db;
    const scope = await workspace();
    const actor = { workspaceId: scope.workspaceId, subjectId: scope.owner };
    const recordingId = crypto.randomUUID();
    await createBrowserRecording(db, {
      ...actor,
      accountId: scope.accountId,
      recordingId,
      visibility: "private",
      startedAt: new Date(),
      durationMilliseconds: 1_000,
      bundle: { byteLength: 10, sha256: sha("c") },
    });
    const message = "the recording captured no frames; the page may not have been visible";
    expect(
      await failBrowserRecordingVideo(db, {
        ...actor,
        recordingId,
        errorCode: "no_frames",
        errorMessage: message,
      }),
    ).toBe(true);
    expect(
      await failBrowserRecordingVideo(db, {
        ...actor,
        recordingId,
        errorCode: "encode_failed",
        errorMessage: "late",
      }),
    ).toBe(false);
    const failed = await findBrowserRecording(db, { ...actor, recordingId });
    expect(failed?.recording).toMatchObject({ state: "failed", errorCode: "no_frames" });
    expect(failed?.errorMessage).toBe(message);
    // Only me: the member cannot see it.
    expect(
      await findBrowserRecording(db, {
        workspaceId: scope.workspaceId,
        subjectId: scope.member,
        recordingId,
      }),
    ).toBeNull();
  });

  test("deleting the workspace removes its browser recordings too", async () => {
    if (!client || !shared) return;
    const scope = await workspace();
    const recordingId = crypto.randomUUID();
    await createBrowserRecording(client.db, {
      workspaceId: scope.workspaceId,
      subjectId: scope.owner,
      accountId: scope.accountId,
      recordingId,
      visibility: "workspace",
      startedAt: new Date(),
      durationMilliseconds: 1_000,
      bundle: { byteLength: 10, sha256: sha("d") },
    });
    await deleteWorkspace(client.db, scope.workspaceId);
    const [rows] = await shared.admin<{ recordings: number }[]>`
      select (select count(*)::int from recordings where id = ${recordingId}) as recordings`;
    expect(rows).toEqual({ recordings: 0 });
  });

  test("the live preview: only the recorder streams, everyone who can see it reads, a transcript ends it", async () => {
    if (!client || !shared) return;
    const db = client.db;
    const scope = await workspace();
    const recordingId = crypto.randomUUID();
    const actor = { workspaceId: scope.workspaceId, subjectId: scope.owner };
    const memberActor = { workspaceId: scope.workspaceId, subjectId: scope.member };
    await createRecording(db, {
      ...actor,
      accountId: scope.accountId,
      recordingId,
      visibility: "workspace",
      transcription: { language: "nb" },
      tracks: [
        { trackNumber: 0, source: "microphone", mimeType: "audio/webm" },
        { trackNumber: 1, source: "system", mimeType: "audio/webm" },
      ],
    });
    const live = { providerId: "elevenlabs", model: "scribe_v2_realtime" };
    await expect(
      startRecordingLiveTrack(db, { ...memberActor, recordingId, trackNumber: 0, ...live }),
    ).rejects.toBeInstanceOf(RecordingForbiddenError);
    await expect(
      appendRecordingLiveSegments(db, {
        ...actor,
        recordingId,
        trackNumber: 0,
        streamedMilliseconds: 1_000,
        costUsdMicros: 100,
        segments: [],
      }),
    ).rejects.toMatchObject({ code: "no_live_session" });
    expect(
      await startRecordingLiveTrack(db, { ...actor, recordingId, trackNumber: 0, ...live }),
    ).toEqual({ language: "nb" });
    await startRecordingLiveTrack(db, { ...actor, recordingId, trackNumber: 1, ...live });
    const segment = (segmentNumber: number, start: number, text: string) => ({
      segmentNumber,
      startMilliseconds: start,
      endMilliseconds: start + 900,
      text,
    });
    expect(
      await appendRecordingLiveSegments(db, {
        ...actor,
        recordingId,
        trackNumber: 0,
        streamedMilliseconds: 4_000,
        costUsdMicros: 400,
        segments: [segment(0, 100, "Hei alle."), segment(1, 2_000, "Kan dere høre meg?")],
      }),
    ).toEqual({ saved: 2, ended: false });
    // A retry keeps the first copy, and an older total never lowers the stored one.
    expect(
      await appendRecordingLiveSegments(db, {
        ...actor,
        recordingId,
        trackNumber: 0,
        streamedMilliseconds: 3_000,
        costUsdMicros: 300,
        segments: [segment(1, 2_000, "changed")],
      }),
    ).toEqual({ saved: 0, ended: false });
    await appendRecordingLiveSegments(db, {
      ...actor,
      recordingId,
      trackNumber: 1,
      streamedMilliseconds: 4_000,
      costUsdMicros: 400,
      segments: [segment(0, 1_000, "Ja, fint.")],
    });
    await expect(
      appendRecordingLiveSegments(db, {
        ...memberActor,
        recordingId,
        trackNumber: 1,
        streamedMilliseconds: 5_000,
        costUsdMicros: 500,
        segments: [segment(1, 3_000, "not mine")],
      }),
    ).rejects.toBeInstanceOf(RecordingForbiddenError);

    const all = await listRecordingLiveSegments(db, { ...memberActor, recordingId });
    expect(all.ended).toBe(false);
    expect(all.segments.map((row) => [row.trackNumber, row.segmentNumber, row.text])).toEqual([
      [0, 0, "Hei alle."],
      [0, 1, "Kan dere høre meg?"],
      [1, 0, "Ja, fint."],
    ]);
    const newer = await listRecordingLiveSegments(db, {
      ...actor,
      recordingId,
      after: all.segments[1]!.sequence,
    });
    expect(newer.segments.map((row) => row.text)).toEqual(["Ja, fint."]);
    expect(newer.after).toBe(all.after);
    const viewed = await getRecording(db, { ...actor, recordingId });
    expect(viewed.tracks.map((track) => track.live)).toEqual([
      { ...live, streamedMilliseconds: 4_000, costUsd: 0.0004 },
      { ...live, streamedMilliseconds: 4_000, costUsd: 0.0004 },
    ]);

    // A recording stopped mid-stream still takes its last live text, then a
    // ready transcript ends the preview and removes it.
    for (const trackNumber of [0, 1]) {
      await reserveRecordingChunks(db, {
        ...actor,
        recordingId,
        trackNumber,
        chunks: [
          {
            chunkNumber: 0,
            byteLength: 100,
            sha256: sha(`${trackNumber}c`),
            startMilliseconds: 0,
            durationMilliseconds: 5_000,
          },
        ],
      });
      await markRecordingChunksUploaded(db, {
        ...actor,
        recordingId,
        trackNumber,
        chunkNumbers: [0],
      });
    }
    const versionId = crypto.randomUUID();
    await finalizeRecording(db, {
      ...actor,
      recordingId,
      tracks: [
        { trackNumber: 0, chunkCount: 1 },
        { trackNumber: 1, chunkCount: 1 },
      ],
      transcription,
      versionId,
    });
    await expect(
      startRecordingLiveTrack(db, { ...actor, recordingId, trackNumber: 0, ...live }),
    ).rejects.toMatchObject({ code: "not_capturing" });
    expect(
      (
        await appendRecordingLiveSegments(db, {
          ...actor,
          recordingId,
          trackNumber: 0,
          streamedMilliseconds: 5_000,
          costUsdMicros: 500,
          segments: [segment(2, 4_000, "Ha det.")],
        })
      ).saved,
    ).toBe(1);
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
      languages: ["nb"],
      diarized: false,
      diarization: "tracks",
      audioMilliseconds: 5_000,
      segments: [
        {
          startMilliseconds: 0,
          endMilliseconds: 900,
          trackNumber: 0,
          speakerLabel: "track-0",
          text: "Hei alle.",
        },
      ],
    });
    const ended = await listRecordingLiveSegments(db, { ...memberActor, recordingId });
    expect(ended).toMatchObject({ segments: [], ended: true });
    expect(
      await appendRecordingLiveSegments(db, {
        ...actor,
        recordingId,
        trackNumber: 0,
        streamedMilliseconds: 6_000,
        costUsdMicros: 600,
        segments: [segment(3, 5_000, "late")],
      }),
    ).toEqual({ saved: 0, ended: true });
    const [rows] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from recording_live_segments where recording_id = ${recordingId}`;
    expect(rows!.count).toBe(0);
  });

  test("finding meetings by words, speaker and date, with the lines that match", async () => {
    if (!client) return;
    const db = client.db;
    const scope = await workspace();
    const memberActor = { workspaceId: scope.workspaceId, subjectId: scope.member };
    async function transcribed(
      visibility: "private" | "workspace",
      segments: Array<{ at: number; label: string; text: string }>,
    ) {
      const recording = await finalizedRecording(scope, visibility);
      const processingOwner = crypto.randomUUID();
      await claimRecordingTranscriptVersion(db, {
        ...recording.actor,
        versionId: recording.versionId,
        processingOwner,
        leaseSeconds: 600,
      });
      await completeRecordingTranscriptVersion(db, {
        ...recording.actor,
        versionId: recording.versionId,
        processingOwner,
        languages: ["en"],
        diarized: true,
        diarization: "provider",
        audioMilliseconds: 600_000,
        segments: segments.map((segment) => ({
          startMilliseconds: segment.at,
          endMilliseconds: segment.at + 4_000,
          trackNumber: 1,
          speakerLabel: segment.label,
          text: segment.text,
        })),
      });
      return recording;
    }
    const budget = await transcribed("workspace", [
      { at: 0, label: "speaker_0", text: "Welcome everyone." },
      { at: 5_000, label: "speaker_1", text: "The budget for the roof is tight." },
      { at: 60_000, label: "speaker_0", text: "Then we cut the budget elsewhere." },
      { at: 120_000, label: "speaker_1", text: "Agreed." },
    ]);
    const other = await transcribed("workspace", [
      { at: 0, label: "speaker_0", text: "Nothing about money here." },
    ]);
    const mine = await transcribed("private", [
      { at: 0, label: "speaker_0", text: "My private budget notes." },
    ]);
    const { person } = await createRecordingPerson(db, {
      ...budget.actor,
      accountId: scope.accountId,
      personId: crypto.randomUUID(),
      displayName: "Ingrid Solberg",
    });
    await updateRecordingSpeakers(db, {
      ...budget.actor,
      recordingId: budget.recordingId,
      assignments: [
        { label: "speaker_0", personId: person.id },
        { label: "speaker_1", name: "Tomas" },
      ],
    });
    // A corrected line is found by its corrected words.
    await updateRecordingSegments(db, {
      ...budget.actor,
      recordingId: budget.recordingId,
      edits: [{ segmentIndex: 3, text: "Agreed, the scaffolding can wait." }],
    });

    const ids = async (input: Parameters<typeof listRecordings>[1]) =>
      (await listRecordings(db, input)).recordings.map((recording) => recording.id).sort();
    expect(await ids({ ...memberActor, query: "budget" })).toEqual([budget.recordingId]);
    expect(await ids({ ...budget.actor, query: "budget" })).toEqual(
      [budget.recordingId, mine.recordingId].sort(),
    );
    expect(await ids({ ...memberActor, person: "ingrid" })).toEqual([budget.recordingId]);
    expect(await ids({ ...memberActor, person: person.id })).toEqual([budget.recordingId]);
    expect(await ids({ ...memberActor, person: "Tom" })).toEqual([budget.recordingId]);
    expect(await ids({ ...memberActor, person: "nobody" })).toEqual([]);
    const now = Date.now();
    expect(
      await ids({
        ...memberActor,
        startedFrom: new Date(now - 3_600_000),
        startedTo: new Date(now + 60_000),
      }),
    ).toEqual([budget.recordingId, other.recordingId].sort());
    expect(await ids({ ...memberActor, startedFrom: new Date(now + 60_000) })).toEqual([]);

    const details = await getRecordingSearchDetails(db, {
      ...memberActor,
      recordingIds: [budget.recordingId, other.recordingId, mine.recordingId],
      query: "budget",
      matchesPerRecording: 1,
    });
    // Someone else's Only me recording stays invisible, even by id.
    expect(details.has(mine.recordingId)).toBe(false);
    expect(details.get(other.recordingId)).toMatchObject({ matches: [] });
    expect(details.get(budget.recordingId)?.speakers.map((speaker) => speaker.name)).toEqual([
      "Ingrid Solberg",
      "Tomas",
    ]);
    expect(details.get(budget.recordingId)?.matches).toEqual([
      { startMilliseconds: 5_000, speaker: "Tomas", text: "The budget for the roof is tight." },
    ]);
    const corrected = await getRecordingSearchDetails(db, {
      ...memberActor,
      recordingIds: [budget.recordingId],
      query: "scaffolding",
    });
    expect(corrected.get(budget.recordingId)?.matches).toEqual([
      { startMilliseconds: 120_000, speaker: "Tomas", text: "Agreed, the scaffolding can wait." },
    ]);

    const stretch = await getRecordingTranscriptPage(db, {
      ...memberActor,
      recordingId: budget.recordingId,
      fromMilliseconds: 6_000,
      toMilliseconds: 120_000,
    });
    expect(stretch.segments.map((segment) => segment.startMilliseconds)).toEqual([5_000, 60_000]);
  });
});
