// What a dictation's pieces sounded like to the model while it was still
// being spoken. The worker listening to a dictation cuts it at the speaker's
// pauses as its audio arrives and has each finished piece heard at once, so
// when the speaker stops only the words after the last cut are left. The
// final transcript takes the pieces whose audio is still exactly the same.

import { createHash } from "node:crypto";
import type { CreditDebitAttribution } from "@opengeni/db";
import type { PreparedAudioFormat } from "./recording-audio";
import type { PcmWav } from "./dictation-pieces";

/** A dictation's audio for cutting and hearing: 16 kHz mono 16-bit PCM. */
export const DICTATION_PCM_FORMAT: PreparedAudioFormat = {
  extension: "wav",
  mimeType: "audio/wav",
  muxer: "wav",
  codec: "pcm_s16le",
  encoderArgs: ["-ar", "16000", "-ac", "1"],
};

/** The model and options a dictation is heard with, as the API chose them. */
export type DictationListeningChoice = {
  providerId: string;
  model: string;
  options: { language?: string | undefined; keyterms?: string[] | undefined };
  /** Who a deployment-funded piece is billed to. */
  creditAttribution: CreditDebitAttribution;
};

export type DictationListeningInput = {
  accountId: string;
  workspaceId: string;
  recordingId: string;
  ownerSubjectId: string;
  choice: DictationListeningChoice;
};

/** One piece cut while the dictation was spoken, and what the model heard in it. */
export type HeardDictationPiece = {
  startSample: number;
  endSample: number;
  /** The piece's samples, so the final transcript reuses it only for the same audio. */
  sha256: string;
  /** When it was cut (epoch milliseconds): its hearing is waited for only a little after. */
  cutAt?: number;
  heard?: {
    text: string;
    languages: string[];
    providerId: string;
    creditCostMicros: number | null;
  };
};

export type HeardDictation = {
  version: 1;
  sampleRate: number;
  /** The question each piece was asked (`dictationQuestion`). */
  question: string;
  pieces: HeardDictationPiece[];
};

/** The model and options as one comparable value. */
export function dictationQuestion(input: {
  providerId: string;
  model: string;
  options: { language?: string | undefined; keyterms?: readonly string[] | undefined };
}): string {
  return JSON.stringify([
    1,
    input.providerId,
    input.model,
    input.options.language ?? null,
    input.options.keyterms?.length ? input.options.keyterms : null,
  ]);
}

export function pcmSha256(wav: PcmWav, startSample: number, endSample: number): string {
  return createHash("sha256")
    .update(wav.data.subarray(startSample * 2, endSample * 2))
    .digest("hex");
}

/** A record read back; anything else is treated as none. */
export function readHeardDictation(bytes: Uint8Array | null | undefined): HeardDictation | null {
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<HeardDictation>;
    if (
      value.version !== 1 ||
      typeof value.sampleRate !== "number" ||
      typeof value.question !== "string" ||
      !Array.isArray(value.pieces)
    ) {
      return null;
    }
    return value as HeardDictation;
  } catch {
    return null;
  }
}

export function writeHeardDictation(record: HeardDictation): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

/**
 * The pieces cut while the dictation was spoken that the final transcript
 * can keep: those from its start, one after another, asked the same
 * question, whose audio in the whole recording is exactly what was cut.
 * The first that differs ends them; everything after it is cut afresh.
 */
export function keptHeardPieces(
  record: HeardDictation | null,
  wav: PcmWav,
  question: string,
): HeardDictationPiece[] {
  if (!record || record.sampleRate !== wav.sampleRate || record.question !== question) return [];
  const samples = wav.data.byteLength / 2;
  const kept: HeardDictationPiece[] = [];
  let next = 0;
  for (const piece of record.pieces) {
    if (piece.startSample !== next || piece.endSample <= next || piece.endSample > samples) break;
    if (pcmSha256(wav, piece.startSample, piece.endSample) !== piece.sha256) break;
    kept.push(piece);
    next = piece.endSample;
  }
  return kept;
}

/** The billing unit of a piece heard while the dictation was spoken, whoever hears it. */
export function heardPieceSourceId(recordingId: string, piece: HeardDictationPiece): string {
  return `${recordingId}:heard:${piece.startSample}-${piece.endSample}`;
}
