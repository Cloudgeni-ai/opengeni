/**
 * Recordings a person leaves on this device when they sign out (CASA 6.6.1).
 *
 * Meeting and dictation audio waits in the browser's `opengeni-recordings`
 * IndexedDB store until the server has it. Signing out first asks whether to
 * wait for that upload or discard it; once a sign-out goes ahead, nothing of
 * that person's stays here. Where nobody can be asked (another tab or the
 * server signed them out), it is discarded.
 *
 * Light on purpose: the recordings code loads only when this browser holds
 * recordings at all.
 */
import type { RecordingChunkStore } from "@opengeni/sdk/recordings";

const RECORDING_DATABASE = "opengeni-recordings";

/** What the person chose: keep signed in while the upload finishes, or discard and sign out. */
export type SignOutRecordingsChoice = "wait" | "discard";

/** Asks the person; `recordings` is how many this device still holds for them. */
export type SignOutRecordingsPrompt = (request: {
  recordings: number;
}) => Promise<SignOutRecordingsChoice>;

/** A capture going on in this tab, which discarding stops first. */
export type LiveRecordingCapture = {
  /** Who records; null when the host gave no owner. */
  ownerId: string | null;
  /** Stop capturing and throw the recording away. */
  discard: () => Promise<void>;
};

let prompt: SignOutRecordingsPrompt | null = null;
const captures = new Set<LiveRecordingCapture>();

/** Show the sign-out question with this prompt; returns the unregister function. */
export function setSignOutRecordingsPrompt(next: SignOutRecordingsPrompt): () => void {
  prompt = next;
  return () => {
    if (prompt === next) prompt = null;
  };
}

/** Tell sign-out about a capture in progress; returns the unregister function. */
export function registerLiveRecordingCapture(capture: LiveRecordingCapture): () => void {
  captures.add(capture);
  return () => {
    captures.delete(capture);
  };
}

/** The person's own key for their recordings: their sign-in email, compared without case. */
export function recordingOwnerKey(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

async function mayHoldRecordings(): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  if (typeof indexedDB.databases !== "function") return true;
  try {
    const databases = await indexedDB.databases();
    return databases.some((database) => database.name === RECORDING_DATABASE);
  } catch {
    return true;
  }
}

/**
 * Call before signing a person out. `ownerId` is theirs (see
 * {@link recordingOwnerKey}), or null when everyone on this device is signing
 * out. With nothing of theirs left to upload it resolves true at once. Else
 * the person chooses: false means they want to wait, so keep them signed in;
 * true means their recordings are gone from this device. `ask: false` (or no
 * prompt shown in this page) discards without asking. `store` and `prompt`
 * replace the browser's IndexedDB store and the page's prompt, as on phones.
 * Never rejects: a store that can't be read holds nothing to keep.
 */
export async function prepareRecordingsForSignOut(
  ownerId: string | null,
  options: { ask?: boolean; store?: RecordingChunkStore; prompt?: SignOutRecordingsPrompt } = {},
): Promise<boolean> {
  try {
    if (!options.store && !(await mayHoldRecordings())) return true;
    const recordings = await import("@opengeni/sdk/recordings");
    const store = options.store ?? recordings.createIndexedDbRecordingChunkStore();
    const held = await recordings.localRecordingsOf(store, ownerId);
    if (held.length === 0) return true;
    const ask = options.ask === false ? null : (options.prompt ?? prompt);
    if (ask && (await ask({ recordings: held.length })) === "wait") return false;
    // A capture still going would keep writing audio after its record is gone.
    for (const capture of [...captures]) {
      if (ownerId !== null && capture.ownerId !== null && capture.ownerId !== ownerId) continue;
      await capture.discard().catch(() => undefined);
    }
    await recordings.discardLocalRecordingsOf(store, ownerId);
    return true;
  } catch {
    return true;
  }
}
