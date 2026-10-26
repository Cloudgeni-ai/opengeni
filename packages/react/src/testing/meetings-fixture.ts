/**
 * An in-memory recordings API for the Meetings preview: a few meetings in
 * every state, one full transcript with named and unnamed speakers, people
 * and models. Edits apply to the fixture so naming and moving work.
 */
import type {
  ListRecordingModelsResponse,
  Recording,
  RecordingLiveSegment,
  RecordingNote,
  RecordingNoteKind,
  RecordingPerson,
  RecordingSpeaker,
  RecordingTranscriptSegment,
  RecordingTranscriptVersion,
} from "@opengeni/contracts";
import type { RecordingsClientLike } from "../recordings";

const WORKSPACE = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const ME = "user:ingrid";
const NOW = Date.now();
const minutes = (count: number) => count * 60_000;
const iso = (offset: number) => new Date(NOW - offset).toISOString();

/** What the live preview has heard so far in the meeting being recorded. */
export const LIVE_LINES: readonly [track: number, seconds: number, text: string][] = [
  [0, 4, "Morning, everyone. Let's keep this one short."],
  [1, 9, "Morning. I can start with the release."],
  [1, 13, "The build went out last night and the error rate is flat."],
  [0, 21, "Good. Anything blocking the migration?"],
  [1, 25, "Only the review on the schema change. I'll ping Tomas after this."],
  [0, 33, "Great, then let's look at the onboarding numbers."],
];

export const LIVE_RECORDING_ID = "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f60";
/** A meeting whose transcript failed before its audio was prepared. */
export const FAILED_RECORDING_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

function version(
  recordingId: string,
  number: number,
  state: RecordingTranscriptVersion["state"],
  extra: Partial<RecordingTranscriptVersion> = {},
): RecordingTranscriptVersion {
  return {
    id: `${recordingId}-v${number}`,
    recordingId,
    versionNumber: number,
    providerId: "elevenlabs",
    model: "scribe_v2",
    options: {},
    state,
    isCurrent: state === "complete",
    languages: state === "complete" ? ["en"] : [],
    diarized: true,
    diarization: "provider",
    audioMilliseconds: 0,
    segmentCount: 0,
    costUsd: null,
    requestedBySubjectId: ME,
    errorCode: null,
    createdAt: iso(minutes(40)),
    completedAt: state === "complete" ? iso(minutes(38)) : null,
    ...extra,
  };
}

function recording(
  id: string,
  title: string,
  startedOffset: number,
  durationMilliseconds: number,
  extra: Partial<Recording> = {},
): Recording {
  return {
    id,
    workspaceId: WORKSPACE,
    ownerSubjectId: ME,
    visibility: "private",
    title,
    purpose: "meeting",
    state: "ready",
    startedAt: iso(startedOffset),
    captureEndedAt: iso(startedOffset - durationMilliseconds),
    durationMilliseconds,
    errorCode: null,
    externalRef: null,
    audioDeletedAt: null,
    metadata: {},
    transcription: {},
    tracks: [
      {
        trackNumber: 0,
        kind: "audio",
        source: "microphone",
        mimeType: "audio/webm",
        chunkCount: 12,
        totalBytes: 2_400_000,
        durationMilliseconds,
        playable: true,
        video: null,
        live: null,
      },
      {
        trackNumber: 1,
        kind: "audio",
        source: "system",
        mimeType: "audio/webm",
        chunkCount: 12,
        totalBytes: 2_400_000,
        durationMilliseconds,
        playable: true,
        video: null,
        live: null,
      },
    ],
    transcript: version(id, 1, "complete"),
    createdAt: iso(startedOffset),
    updatedAt: iso(startedOffset - durationMilliseconds),
    ...extra,
  };
}

/** Its audio is uploaded, but the worker hasn't made a playable copy yet. */
function unprepared(meeting: Recording): Recording {
  return { ...meeting, tracks: meeting.tracks.map((track) => ({ ...track, playable: false })) };
}

const LINES: Array<[label: string, seconds: number, text: string]> = [
  [
    "track-0",
    2,
    "Morning, everyone. Let's start with the onboarding numbers, then the pricing page.",
  ],
  ["speaker_0", 9, "Sure. Sign-ups are up eleven percent week over week, mostly from the docs."],
  [
    "speaker_0",
    16,
    "Activation is flat, though. People connect a repository and then stall at the first run.",
  ],
  [
    "speaker_1",
    27,
    "That matches the session replays. The empty state after connecting doesn't say what to do next.",
  ],
  [
    "track-0",
    38,
    "Can we put a suggested first task right there? Something that finishes in under a minute.",
  ],
  ["speaker_1", 47, "Yes. I can have a draft by Thursday, with two or three starter tasks."],
  [
    "speaker_0",
    58,
    "I'd keep it to one. Three choices is how we got the stall in the first place.",
  ],
  ["track-0", 71, "Fair. One suggested task, and a link to the full list for people who want it."],
  ["speaker_2", 80, "Works for me."],
  ["track-0", 96, "Pricing page next. Tomas, where did we land on the annual discount?"],
  [
    "speaker_0",
    104,
    "Two months free on annual. Finance is fine with it as long as we show the monthly price first.",
  ],
  [
    "speaker_2",
    118,
    "Then the comparison table needs a toggle. I'll mock both versions so we can pick.",
  ],
  ["track-0", 131, "Great. Let's review both on Monday and ship the one that reads clearer."],
  ["speaker_0", 140, "I'll send the numbers before then."],
];

export type MeetingsFixture = {
  client: RecordingsClientLike;
  workspaceId: string;
  viewerSubjectId: string;
  readyId: string;
};

/** A WAV of silence, so the player has real audio to load and seek. */
function silentWav(seconds: number): string {
  const rate = 3000;
  const samples = Math.ceil(seconds * rate);
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  write(36, "data");
  view.setUint32(40, samples, true);
  new Uint8Array(buffer, 44).fill(128);
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

export function createMeetingsFixture(
  options: {
    state?: "ready" | "empty";
    pinned?: boolean;
    /** The workspace meeting language the server reports. */
    language?: string | null;
  } = {},
): MeetingsFixture {
  const readyId = "5f2d1c4b-0a9e-4d8c-b7f6-e5d4c3b2a190";
  const people: RecordingPerson[] = [
    person("8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d", "Ingrid Solberg", {
      memberSubjectId: ME,
      voice: rememberedVoice("self"),
    }),
    person("1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", "Tomas Eriksen"),
    person("9c8b7a6f-5e4d-4c3b-a291-807f6e5d4c3b", "Lea Haugen", {
      voice: rememberedVoice("attested"),
    }),
  ];
  let speakers: RecordingSpeaker[] = [
    {
      label: "track-0",
      name: "Ingrid Solberg",
      personId: people[0]!.id,
      source: "confirmed",
      confidence: null,
    },
    {
      label: "speaker_0",
      name: "Tomas Eriksen",
      personId: people[1]!.id,
      source: "confirmed",
      confidence: null,
    },
    { label: "speaker_1", name: "speaker_1", personId: null, source: null, confidence: null },
    {
      label: "speaker_2",
      name: "Lea Haugen",
      personId: people[2]!.id,
      source: "suggested",
      confidence: 0.86,
    },
  ];
  let segments: RecordingTranscriptSegment[] = LINES.map(([label, seconds, text], index) => {
    const next = LINES[index + 1]?.[1] ?? seconds + 8;
    return {
      index,
      startMilliseconds: seconds * 1000,
      endMilliseconds: Math.max(seconds + 2, next - 1) * 1000,
      trackNumber: label === "track-0" ? 0 : 1,
      speakerLabel: label,
      text,
      edited: false,
    };
  });
  const readyDuration = 152_000;
  const ready = recording(readyId, "Weekly product sync", minutes(55), readyDuration, {
    visibility: "workspace",
    transcript: version(readyId, 1, "complete", {
      audioMilliseconds: readyDuration,
      segmentCount: segments.length,
    }),
  });
  const reruns = new Map<string, RecordingTranscriptVersion[]>();
  let recordings: Recording[] =
    options.state === "empty"
      ? []
      : [
          recording(LIVE_RECORDING_ID, "Platform standup", minutes(1), 0, {
            state: "capturing",
            captureEndedAt: null,
            transcript: null,
            tracks: [0, 1].map((trackNumber) => ({
              trackNumber,
              kind: "audio" as const,
              source: trackNumber === 0 ? ("microphone" as const) : ("system" as const),
              mimeType: "audio/webm",
              chunkCount: 4,
              totalBytes: 800_000,
              durationMilliseconds: 0,
              playable: false,
              video: null,
              live: {
                providerId: "elevenlabs",
                model: "scribe_v2_realtime",
                streamedMilliseconds: 38_000,
                costUsd: 0.004,
              },
            })),
          }),
          unprepared(
            recording(
              "0c1d2e3f-4a5b-4c6d-8e7f-a0b1c2d3e4f5",
              // Started through the API without a title: the server's stand-in.
              `Recording ${iso(minutes(8)).slice(0, 16).replace("T", " ")} UTC`,
              minutes(8),
              minutes(31),
              {
                state: "processing",
                transcript: version("0c1d2e3f-4a5b-4c6d-8e7f-a0b1c2d3e4f5", 1, "processing"),
              },
            ),
          ),
          ready,
          recording(
            "6e5d4c3b-2a19-4087-b6a5-f4e3d2c1b0a9",
            "Design review: billing settings",
            minutes(60 * 26),
            minutes(47),
          ),
          // It failed before the worker made a playable copy; the audio is kept.
          unprepared(
            recording(
              FAILED_RECORDING_ID,
              "Interview: platform engineer",
              minutes(60 * 50),
              minutes(58),
              {
                state: "failed",
                transcript: version(FAILED_RECORDING_ID, 1, "failed", {
                  errorCode: "provider_quota_exceeded",
                }),
              },
            ),
          ),
          recording(
            "7f8a9b0c-1d2e-4f3a-8b4c-5d6e7f8a9b0c",
            "1:1 with Lea",
            minutes(60 * 24 * 6),
            minutes(24),
            {
              audioDeletedAt: iso(minutes(60 * 24 * 5)),
              tracks: [],
              transcript: version("7f8a9b0c-1d2e-4f3a-8b4c-5d6e7f8a9b0c", 1, "complete"),
            },
          ),
        ];
  let audioUrl: string | null = null;
  const pinnedModels: ListRecordingModelsResponse = {
    models: [
      {
        providerId: "azure-speech",
        providerName: "Azure Speech",
        model: "MAI-Transcribe-2",
        name: "MAI-Transcribe-2",
        available: true,
        funding: "deployment",
        usdPerHour: 0.1,
        capabilities: {
          batch: true,
          live: false,
          diarization: false,
          liveDiarization: false,
          multichannel: false,
          maxSpeakers: null,
          wordTimestamps: true,
          languages: [],
          languageDetection: true,
          keyterms: true,
          speakerLibrary: false,
          maxDurationSeconds: 7_200,
          maxFileBytes: 262_144_000,
        },
      },
    ],
    default: { providerId: "azure-speech", model: "MAI-Transcribe-2" },
    dictationDefault: { providerId: "azure-speech", model: "MAI-Transcribe-2" },
    pinned: true,
  };
  const unpinnedModels: ListRecordingModelsResponse = {
    models: [
      {
        providerId: "elevenlabs",
        providerName: "ElevenLabs",
        model: "scribe_v2",
        name: "Scribe v2",
        available: true,
        funding: "workspace_key",
        usdPerHour: 0.4,
        capabilities: {
          batch: true,
          live: false,
          diarization: true,
          liveDiarization: false,
          multichannel: false,
          maxSpeakers: 32,
          wordTimestamps: true,
          languages: [],
          languageDetection: true,
          keyterms: true,
          speakerLibrary: false,
          maxDurationSeconds: 36_000,
          maxFileBytes: 3_000_000_000,
        },
      },
      {
        providerId: "elevenlabs",
        providerName: "ElevenLabs",
        model: "scribe_v2_realtime",
        name: "Scribe v2 Realtime",
        available: true,
        funding: "workspace_key",
        usdPerHour: 0.39,
        capabilities: {
          batch: false,
          live: true,
          diarization: false,
          liveDiarization: false,
          multichannel: false,
          maxSpeakers: null,
          wordTimestamps: true,
          languages: [],
          languageDetection: true,
          keyterms: false,
          speakerLibrary: false,
          maxDurationSeconds: null,
          maxFileBytes: null,
        },
      },
    ],
    default: { providerId: "elevenlabs", model: "scribe_v2" },
    dictationDefault: null,
    pinned: false,
  };
  const models: ListRecordingModelsResponse = {
    ...(options.pinned ? pinnedModels : unpinnedModels),
    ...(options.language !== undefined ? { language: options.language } : {}),
  };
  const liveSegments: RecordingLiveSegment[] = LIVE_LINES.map(
    ([trackNumber, seconds, text], index) => ({
      trackNumber,
      segmentNumber: index,
      startMilliseconds: seconds * 1000,
      endMilliseconds: seconds * 1000 + 3500,
      text,
      sequence: index + 1,
    }),
  );
  // Like the API: part of the title, or every word starting a word of the transcript.
  const matchesSearch = (entry: Recording, query: string) => {
    if (entry.title.toLowerCase().includes(query.toLowerCase())) return true;
    const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
    if (!words || entry.id !== readyId) return false;
    const spoken = new Set(
      segments.flatMap((segment) => segment.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
    );
    return words.every((word) => [...spoken].some((candidate) => candidate.startsWith(word)));
  };
  const find = (id: string) => {
    const found = recordings.find((entry) => entry.id === id);
    if (!found) throw new Error("Recording not found");
    return found;
  };
  const delay = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 120));
  // The ready meeting has notes an agent wrote and a few lines jotted during it.
  const notes = new Map<string, RecordingNote[]>([
    [
      readyId,
      [
        {
          kind: "notepad",
          body: "- error rate flat after release\n- Tomas: schema review",
          revision: 3,
          updatedAt: iso(minutes(41)),
          updatedBy: { subjectId: ME, sessionId: null },
        },
        {
          kind: "notes",
          body: "## Summary\n\nThe release went out cleanly and the error rate is flat. Onboarding completion is up, but the second step still loses people.\n\n## Decisions\n\n- Ship the migration once the schema change is reviewed.\n\n## Action items\n\n- [ ] Tomas reviews the schema change today\n- [ ] Ingrid shares the onboarding numbers by Friday",
          revision: 1,
          updatedAt: iso(minutes(36)),
          updatedBy: { subjectId: ME, sessionId: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" },
        },
      ],
    ],
  ]);
  const client = {
    listRecordings: async (
      _workspaceId: string,
      request: { query?: string; externalRef?: string } = {},
    ) =>
      await delay({
        recordings: recordings.filter(
          (entry) =>
            (request.query ? matchesSearch(entry, request.query) : true) &&
            (request.externalRef ? entry.externalRef === request.externalRef : true),
        ),
        nextBefore: null,
      }),
    getRecording: async (_workspaceId: string, id: string) => await delay(find(id)),
    updateRecording: async (_workspaceId: string, id: string, request: Partial<Recording>) => {
      recordings = recordings.map((entry) => (entry.id === id ? { ...entry, ...request } : entry));
      return await delay(find(id));
    },
    deleteRecording: async (_workspaceId: string, id: string) => {
      recordings = recordings.filter((entry) => entry.id !== id);
      await delay(undefined);
    },
    listRecordingTranscriptVersions: async (_workspaceId: string, id: string) =>
      await delay([
        ...(reruns.get(id) ?? []),
        ...(find(id).transcript ? [find(id).transcript!] : []),
      ]),
    createRecordingTranscript: async (_workspaceId: string, id: string) => {
      const previous = reruns.get(id) ?? [];
      const next = version(
        id,
        (find(id).transcript?.versionNumber ?? 0) + previous.length + 1,
        "queued",
      );
      reruns.set(id, [next, ...previous]);
      return await delay(next);
    },
    setCurrentRecordingTranscript: async (_workspaceId: string, id: string) =>
      await delay(find(id).transcript!),
    getRecordingTranscript: async (_workspaceId: string, id: string) =>
      await delay({
        version: find(id).transcript!,
        speakers,
        segments: id === readyId ? segments : segments.slice(0, 6),
        nextAfter: null,
      }),
    updateRecordingSpeakers: async (
      _workspaceId: string,
      _id: string,
      request: {
        assignments?: Array<{ label: string; personId?: string | null; name?: string | null }>;
        segmentOverrides?: Array<{ segmentIndex: number; label: string }>;
        rejectSuggestions?: Array<{ label: string }>;
      },
    ) => {
      const rejected = new Set((request.rejectSuggestions ?? []).map((entry) => entry.label));
      speakers = speakers.map((speaker) =>
        rejected.has(speaker.label) && speaker.source === "suggested"
          ? { ...speaker, personId: null, name: speaker.label, source: null, confidence: null }
          : speaker,
      );
      for (const assignment of request.assignments ?? []) {
        const named = people.find((entry) => entry.id === assignment.personId);
        speakers = speakers.map((speaker) =>
          speaker.label === assignment.label
            ? {
                ...speaker,
                personId: assignment.personId ?? null,
                name: named?.displayName ?? assignment.name ?? speaker.label,
                source: assignment.personId || assignment.name ? "confirmed" : null,
                confidence: null,
              }
            : speaker,
        );
      }
      for (const override of request.segmentOverrides ?? []) {
        segments = segments.map((segment) =>
          segment.index === override.segmentIndex
            ? { ...segment, speakerLabel: override.label }
            : segment,
        );
      }
      return await delay({ speakers });
    },
    updateRecordingSegments: async (
      _workspaceId: string,
      _id: string,
      request: { edits: Array<{ segmentIndex: number; text: string | null }> },
    ) => {
      for (const edit of request.edits) {
        segments = segments.map((segment) =>
          segment.index === edit.segmentIndex && edit.text !== null
            ? { ...segment, text: edit.text, edited: true }
            : segment,
        );
      }
      return await delay({ segments });
    },
    getRecordingTrackAudio: async () => {
      audioUrl ??= silentWav(readyDuration / 1000);
      return await delay({
        url: audioUrl,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        mimeType: "audio/wav",
        bytes: 0,
      });
    },
    listRecordingPeople: async () => await delay(people),
    createRecordingPerson: async (
      _workspaceId: string,
      request: { displayName: string; memberSubjectId?: string },
    ) => {
      const created = person(crypto.randomUUID(), request.displayName, {
        memberSubjectId: request.memberSubjectId ?? null,
      });
      people.push(created);
      return await delay(created);
    },
    rememberRecordingPersonVoice: async (
      _workspaceId: string,
      personId: string,
      request: { consent: "self" | "attested" },
    ) => {
      const index = people.findIndex((entry) => entry.id === personId);
      people[index] = {
        ...people[index]!,
        voice: { ...rememberedVoice(request.consent), learned: false, updatedAt: null },
      };
      return await delay(people[index]!);
    },
    forgetRecordingPersonVoice: async (_workspaceId: string, personId: string) => {
      const index = people.findIndex((entry) => entry.id === personId);
      people[index] = { ...people[index]!, voice: null };
      speakers = speakers.map((speaker) =>
        speaker.personId === personId && speaker.source === "suggested"
          ? { ...speaker, personId: null, name: speaker.label, source: null, confidence: null }
          : speaker,
      );
      return await delay(people[index]!);
    },
    listRecordingModels: async () => await delay(models),
    listRecordingNotes: async (_workspaceId: string, id: string) =>
      await delay({ notes: notes.get(id) ?? [] }),
    saveRecordingNote: async (
      _workspaceId: string,
      id: string,
      kind: RecordingNoteKind,
      request: { body: string },
    ) => {
      const current = notes.get(id) ?? [];
      const previous = current.find((note) => note.kind === kind);
      const saved: RecordingNote = {
        kind,
        body: request.body,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: { subjectId: ME, sessionId: null },
      };
      notes.set(id, [...current.filter((note) => note.kind !== kind), saved]);
      return await delay(saved);
    },
    listRecordingLiveSegments: async (
      _workspaceId: string,
      id: string,
      request: { after?: number } = {},
    ) => {
      const capturing = find(id).state === "capturing";
      const fresh = capturing
        ? liveSegments.filter((segment) => segment.sequence > (request.after ?? 0))
        : [];
      return await delay({
        segments: fresh,
        after: fresh.at(-1)?.sequence ?? request.after ?? 0,
        ended: find(id).state === "ready",
      });
    },
  };
  return {
    client: client as unknown as RecordingsClientLike,
    workspaceId: WORKSPACE,
    viewerSubjectId: ME,
    readyId,
  };
}

function rememberedVoice(consent: "self" | "attested"): NonNullable<RecordingPerson["voice"]> {
  return {
    consent,
    consentedAt: new Date(NOW - minutes(60 * 24 * 12)).toISOString(),
    learned: true,
    updatedAt: new Date(NOW - minutes(60 * 24 * 2)).toISOString(),
  };
}

function person(
  id: string,
  displayName: string,
  extra: Partial<Pick<RecordingPerson, "memberSubjectId" | "voice">> = {},
): RecordingPerson {
  return {
    id,
    displayName,
    memberSubjectId: null,
    email: null,
    externalRef: null,
    createdAt: new Date(NOW - minutes(60 * 24 * 30)).toISOString(),
    voice: null,
    ...extra,
  };
}
