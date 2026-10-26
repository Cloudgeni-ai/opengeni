// Opt-in voice recognition for meeting recordings (migration 0940).
//
// While a workspace recognizes voices, each diarized speaker's voice vector
// is kept with its transcript version. Confirming that a speaker is a person
// who agreed to be remembered teaches that person's voiceprint from it, and
// later transcripts suggest who a speaker is from those voiceprints. Only
// numbers are stored, never audio, and the vectors never leave this layer.

import { resolveWorkspaceRecordingSettings, type RecordingTrackSource } from "@opengeni/contracts";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "./database";
import * as schema from "./schema";
import type { recordingVoiceChannelValues } from "./recordings-schema";

export type RecordingVoiceChannel = (typeof recordingVoiceChannelValues)[number];

/** A diarized speaker's voice in a finished transcript. */
export type RecordingSpeakerVoice = {
  label: string;
  channel: RecordingVoiceChannel;
  /** The speaker model that made the vector; vectors only compare within one. */
  model: string;
  embedding: readonly number[];
  speechMilliseconds: number;
};

/**
 * Cosine similarity a voice needs before its best match is suggested. On
 * meeting audio the same person scores about 0.85 to 0.97 across meetings
 * and different people stay below 0.5, so 0.6 leaves room both ways.
 */
export const VOICE_SUGGESTION_THRESHOLD = 0.6;
/** A turned-down suggestion covers voices this similar in the same recording. */
const REJECTED_VOICE_SIMILARITY = 0.75;
/** Less speech than this gives too rough a vector to suggest or learn from. */
export const MIN_VOICE_SPEECH_MILLISECONDS = 4_000;
/** One long meeting counts like two minutes, so no single meeting dominates. */
const MAX_VOICE_WEIGHT_MILLISECONDS = 120_000;

/** The kind of audio a track carries, for keeping voiceprints apart. */
export function recordingVoiceChannel(source: RecordingTrackSource): RecordingVoiceChannel {
  if (source === "microphone") return "microphone";
  if (source === "system") return "call";
  return "room";
}

function unit(vector: readonly number[]): number[] {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  return norm > 0 ? vector.map((value) => value / norm) : vector.map(() => 0);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export type KnownVoice = {
  personId: string;
  model: string;
  embedding: readonly number[];
};

/**
 * Who each voice probably is. A voice takes its closest person when the
 * similarity reaches the threshold; each person and each label is used at
 * most once, strongest pairs first. People someone turned down for a similar
 * voice in this recording, and labels or people already named, are skipped.
 */
export function suggestSpeakersByVoice(input: {
  voices: readonly RecordingSpeakerVoice[];
  known: readonly KnownVoice[];
  rejected: readonly KnownVoice[];
  namedLabels: ReadonlySet<string>;
  namedPeople: ReadonlySet<string>;
}): Map<string, { personId: string; confidence: number }> {
  const pairs: Array<{ label: string; personId: string; score: number }> = [];
  for (const voice of input.voices) {
    if (input.namedLabels.has(voice.label)) continue;
    if (voice.speechMilliseconds < MIN_VOICE_SPEECH_MILLISECONDS) continue;
    const best = new Map<string, number>();
    for (const known of input.known) {
      if (known.model !== voice.model || input.namedPeople.has(known.personId)) continue;
      const score = cosineSimilarity(voice.embedding, known.embedding);
      if (score > (best.get(known.personId) ?? -1)) best.set(known.personId, score);
    }
    for (const [personId, score] of best) {
      if (score < VOICE_SUGGESTION_THRESHOLD) continue;
      const turnedDown = input.rejected.some(
        (rejected) =>
          rejected.personId === personId &&
          rejected.model === voice.model &&
          cosineSimilarity(rejected.embedding, voice.embedding) >= REJECTED_VOICE_SIMILARITY,
      );
      if (!turnedDown) pairs.push({ label: voice.label, personId, score });
    }
  }
  pairs.sort((left, right) => right.score - left.score);
  const suggestions = new Map<string, { personId: string; confidence: number }>();
  const used = new Set<string>();
  for (const pair of pairs) {
    if (suggestions.has(pair.label) || used.has(pair.personId)) continue;
    suggestions.set(pair.label, {
      personId: pair.personId,
      confidence: Math.min(1, Math.max(0, pair.score)),
    });
    used.add(pair.personId);
  }
  return suggestions;
}

/** Whether the workspace recognizes voices. */
export async function workspaceRecognizesVoices(
  tx: Database,
  workspaceId: string,
): Promise<boolean> {
  const [workspace] = await tx
    .select({ settings: schema.workspaces.settings })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  return resolveWorkspaceRecordingSettings(workspace?.settings).voiceprints === true;
}

/** Voiceprints of the people in the workspace who agreed to be remembered. */
export async function consentedVoiceprints(
  tx: Database,
  workspaceId: string,
): Promise<KnownVoice[]> {
  return await tx
    .select({
      personId: schema.recordingVoiceprints.personId,
      model: schema.recordingVoiceprints.model,
      embedding: schema.recordingVoiceprints.embedding,
    })
    .from(schema.recordingVoiceprints)
    .innerJoin(
      schema.recordingPeople,
      and(
        eq(schema.recordingPeople.workspaceId, schema.recordingVoiceprints.workspaceId),
        eq(schema.recordingPeople.id, schema.recordingVoiceprints.personId),
      ),
    )
    .where(
      and(
        eq(schema.recordingVoiceprints.workspaceId, workspaceId),
        isNotNull(schema.recordingPeople.voiceConsent),
      ),
    );
}

export async function rejectedVoices(
  tx: Database,
  workspaceId: string,
  recordingId: string,
): Promise<KnownVoice[]> {
  return await tx
    .select({
      personId: schema.recordingVoiceRejections.personId,
      model: schema.recordingVoiceRejections.model,
      embedding: schema.recordingVoiceRejections.embedding,
    })
    .from(schema.recordingVoiceRejections)
    .where(
      and(
        eq(schema.recordingVoiceRejections.workspaceId, workspaceId),
        eq(schema.recordingVoiceRejections.recordingId, recordingId),
      ),
    );
}

type VoiceRow = typeof schema.recordingSpeakerVoices.$inferSelect;

const voiceWeight = (voice: { speechMilliseconds: number }) =>
  Math.min(voice.speechMilliseconds, MAX_VOICE_WEIGHT_MILLISECONDS);

/**
 * Add a confirmed speaker's voice to a person's voiceprint, or take it back
 * out (sign -1) when the speaker turns out to be someone else. A voiceprint
 * is the speech-weighted mean of unit vectors, so both are exact.
 */
async function adjustVoiceprint(
  tx: Database,
  voice: VoiceRow,
  personId: string,
  sign: 1 | -1,
): Promise<void> {
  const key = and(
    eq(schema.recordingVoiceprints.workspaceId, voice.workspaceId),
    eq(schema.recordingVoiceprints.personId, personId),
    eq(schema.recordingVoiceprints.channel, voice.channel),
    eq(schema.recordingVoiceprints.model, voice.model),
  );
  const [current] = await tx.select().from(schema.recordingVoiceprints).where(key).for("update");
  const weight = voiceWeight(voice);
  const vector = unit(voice.embedding);
  if (!current) {
    if (sign < 0) return;
    await tx.insert(schema.recordingVoiceprints).values({
      accountId: voice.accountId,
      workspaceId: voice.workspaceId,
      personId,
      channel: voice.channel,
      model: voice.model,
      embedding: vector,
      speechMilliseconds: weight,
      sampleCount: 1,
    });
    return;
  }
  const total = current.speechMilliseconds + sign * weight;
  const samples = current.sampleCount + sign;
  if (samples <= 0 || total <= 0 || current.embedding.length !== vector.length) {
    if (sign < 0) await tx.delete(schema.recordingVoiceprints).where(key);
    return;
  }
  const mean = current.embedding.map(
    (value, index) => (value * current.speechMilliseconds + sign * vector[index]! * weight) / total,
  );
  await tx
    .update(schema.recordingVoiceprints)
    .set({
      embedding: mean,
      speechMilliseconds: total,
      sampleCount: samples,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(key);
}

/**
 * Keep voiceprints in step with who a version's speaker is. Confirming a
 * remembered person teaches their voiceprint; naming the label someone else,
 * or clearing it, takes the voice back out of whoever learned it.
 */
export async function syncSpeakerVoice(
  tx: Database,
  input: { workspaceId: string; versionId: string; label: string; personId: string | null },
): Promise<void> {
  const [voice] = await tx
    .select()
    .from(schema.recordingSpeakerVoices)
    .where(
      and(
        eq(schema.recordingSpeakerVoices.workspaceId, input.workspaceId),
        eq(schema.recordingSpeakerVoices.versionId, input.versionId),
        eq(schema.recordingSpeakerVoices.speakerLabel, input.label),
      ),
    )
    .for("update");
  if (!voice) return;
  let learner: string | null = null;
  if (input.personId && voice.speechMilliseconds >= MIN_VOICE_SPEECH_MILLISECONDS) {
    const [person] = await tx
      .select({ consent: schema.recordingPeople.voiceConsent })
      .from(schema.recordingPeople)
      .where(
        and(
          eq(schema.recordingPeople.workspaceId, input.workspaceId),
          eq(schema.recordingPeople.id, input.personId),
        ),
      );
    if (person?.consent && (await workspaceRecognizesVoices(tx, input.workspaceId))) {
      learner = input.personId;
    }
  }
  if (voice.learnedPersonId === learner) return;
  if (voice.learnedPersonId) await adjustVoiceprint(tx, voice, voice.learnedPersonId, -1);
  if (learner) await adjustVoiceprint(tx, voice, learner, 1);
  await tx
    .update(schema.recordingSpeakerVoices)
    .set({ learnedPersonId: learner })
    .where(
      and(
        eq(schema.recordingSpeakerVoices.versionId, voice.versionId),
        eq(schema.recordingSpeakerVoices.speakerLabel, voice.speakerLabel),
      ),
    );
}

/**
 * Remember that a suggested person is not this voice, for this recording.
 * Returns whether the label had a suggestion to turn down.
 */
export async function rejectVoiceSuggestion(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    recordingId: string;
    versionId: string;
    label: string;
    subjectId: string;
  },
): Promise<boolean> {
  const [removed] = await tx
    .delete(schema.recordingSpeakerAssignments)
    .where(
      and(
        eq(schema.recordingSpeakerAssignments.versionId, input.versionId),
        eq(schema.recordingSpeakerAssignments.speakerLabel, input.label),
        eq(schema.recordingSpeakerAssignments.source, "suggested"),
      ),
    )
    .returning({ personId: schema.recordingSpeakerAssignments.personId });
  if (!removed?.personId) return Boolean(removed);
  const [voice] = await tx
    .select()
    .from(schema.recordingSpeakerVoices)
    .where(
      and(
        eq(schema.recordingSpeakerVoices.versionId, input.versionId),
        eq(schema.recordingSpeakerVoices.speakerLabel, input.label),
      ),
    );
  if (voice) {
    await tx.insert(schema.recordingVoiceRejections).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      recordingId: input.recordingId,
      personId: removed.personId,
      model: voice.model,
      embedding: voice.embedding,
      rejectedBySubjectId: input.subjectId,
    });
  }
  return true;
}

/**
 * Learn a newly remembered person's voice from every speaker already
 * confirmed as them, in the recordings the caller can see.
 */
export async function learnConfirmedVoices(
  tx: Database,
  input: { workspaceId: string; personId: string },
): Promise<void> {
  const confirmed = await tx
    .select({
      versionId: schema.recordingSpeakerAssignments.versionId,
      label: schema.recordingSpeakerAssignments.speakerLabel,
    })
    .from(schema.recordingSpeakerAssignments)
    .innerJoin(
      schema.recordingSpeakerVoices,
      and(
        eq(schema.recordingSpeakerVoices.versionId, schema.recordingSpeakerAssignments.versionId),
        eq(
          schema.recordingSpeakerVoices.speakerLabel,
          schema.recordingSpeakerAssignments.speakerLabel,
        ),
      ),
    )
    .where(
      and(
        eq(schema.recordingSpeakerAssignments.workspaceId, input.workspaceId),
        eq(schema.recordingSpeakerAssignments.personId, input.personId),
        inArray(schema.recordingSpeakerAssignments.source, ["confirmed", "carried_over"]),
        isNull(schema.recordingSpeakerVoices.learnedPersonId),
      ),
    );
  for (const speaker of confirmed) {
    await syncSpeakerVoice(tx, {
      workspaceId: input.workspaceId,
      versionId: speaker.versionId,
      label: speaker.label,
      personId: input.personId,
    });
  }
}

/** Forget one person's voice: their voiceprints and what taught them. */
export async function forgetPersonVoice(
  tx: Database,
  input: { workspaceId: string; personId: string },
): Promise<void> {
  await tx
    .delete(schema.recordingVoiceprints)
    .where(
      and(
        eq(schema.recordingVoiceprints.workspaceId, input.workspaceId),
        eq(schema.recordingVoiceprints.personId, input.personId),
      ),
    );
  await tx
    .delete(schema.recordingSpeakerAssignments)
    .where(
      and(
        eq(schema.recordingSpeakerAssignments.workspaceId, input.workspaceId),
        eq(schema.recordingSpeakerAssignments.personId, input.personId),
        eq(schema.recordingSpeakerAssignments.source, "suggested"),
      ),
    );
  await tx
    .update(schema.recordingSpeakerVoices)
    .set({ learnedPersonId: null })
    .where(
      and(
        eq(schema.recordingSpeakerVoices.workspaceId, input.workspaceId),
        eq(schema.recordingSpeakerVoices.learnedPersonId, input.personId),
      ),
    );
  await tx
    .update(schema.recordingPeople)
    .set({
      voiceConsent: null,
      voiceConsentBySubjectId: null,
      voiceConsentedAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schema.recordingPeople.workspaceId, input.workspaceId),
        eq(schema.recordingPeople.id, input.personId),
      ),
    );
}
