import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  grantDeferredRuntimeAccess,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  acceptOrganizationInvitation,
  claimRecordingTranscriptVersion,
  completeRecordingTranscriptVersion,
  createDb,
  createOrganizationInvitation,
  createRecording,
  createRecordingPerson,
  createRecordingTranscriptVersion,
  deleteWorkspace,
  ensureManagedAccessForUser,
  failRecordingTranscriptVersion,
  finalizeRecording,
  forgetRecordingPersonVoice,
  forgetWorkspaceRecordingVoices,
  getRecording,
  getRecordingTranscriptPage,
  listDeletingRecordingObjectKeys,
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
  setCurrentRecordingTranscriptVersion,
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
  await grantDeferredRuntimeAccess(shared.admin);
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
});
