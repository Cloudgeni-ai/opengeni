import type {
  RecordingChunk,
  RecordingChunkStore,
  StoredRecording,
  StoredRecordingChunk,
} from "@opengeni/sdk/recordings";
import { wholeAdtsFrames } from "./adts";

/**
 * The few file operations the recording store needs. `@opengeni/react-native/recordings`
 * implements it on expo-file-system; paths are `${directory}/${name}`.
 */
export interface RecordingFileSystem {
  /** Entry names in a directory; empty when it does not exist. */
  list(directory: string): Promise<string[]>;
  readBytes(path: string): Promise<Uint8Array | null>;
  readText(path: string): Promise<string | null>;
  /** Replace the file in one step, so a crash leaves the old or the new content. */
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Remove a file or a whole directory; nothing when it is gone already. */
  remove(path: string): Promise<void>;
  /** Create a directory and its parents; nothing when it exists. */
  makeDirectory(path: string): Promise<void>;
}

/**
 * Chunk files are named after what the uploader needs to know about them, so
 * listing a recording reads no file:
 * `t<track>-c<chunk>-s<start ms>-d<duration ms>-b<bytes>-<sha256>.chunk`.
 * A chunk the native recorder is still writing is `t<track>-c<chunk>-s<start ms>.part`.
 */
const CHUNK = /^t(\d+)-c(\d+)-s(\d+)-d(\d+)-b(\d+)-([0-9a-f]{64})\.chunk$/u;
const PART = /^t(\d+)-c(\d+)-s(\d+)\.part$/u;
const RECORDING_FILE = "recording.json";

export function recordingChunkFileName(chunk: Omit<StoredRecordingChunk, "recordingId">): string {
  return (
    `t${chunk.trackNumber}-c${String(chunk.chunkNumber).padStart(6, "0")}` +
    `-s${Math.max(0, Math.round(chunk.startMilliseconds))}` +
    `-d${Math.max(0, Math.round(chunk.durationMilliseconds))}` +
    `-b${chunk.byteLength}-${chunk.sha256}.chunk`
  );
}

export function parseRecordingChunkFileName(
  recordingId: string,
  name: string,
): StoredRecordingChunk | null {
  const match = CHUNK.exec(name);
  if (!match) return null;
  return {
    recordingId,
    trackNumber: Number(match[1]),
    chunkNumber: Number(match[2]),
    startMilliseconds: Number(match[3]),
    durationMilliseconds: Number(match[4]),
    byteLength: Number(match[5]),
    sha256: match[6]!,
  };
}

export type FileRecordingChunkStore = RecordingChunkStore & {
  /** The directory one recording's files live in; the native recorder writes its chunks there. */
  directory(recordingId: string): string;
  /**
   * Save what a capture cut short left behind: chunks still being written
   * are kept up to their last whole AAC frame, and every recording's chunk
   * counts cover the chunk files it has. Recordings `skip` names are left alone.
   */
  recover(options?: { skip?: (recordingId: string) => boolean }): Promise<void>;
};

/** A durable chunk store in a directory of the app's files. */
export function createFileRecordingChunkStore(input: {
  fs: RecordingFileSystem;
  root: string;
  sha256: (bytes: Uint8Array) => Promise<string>;
}): FileRecordingChunkStore {
  const { fs, root } = input;
  const directory = (recordingId: string) => `${root}/${recordingId}`;
  const key = (trackNumber: number, chunkNumber: number) => `${trackNumber}:${chunkNumber}`;
  // File names by track and chunk, per recording, from the latest listing.
  const names = new Map<string, Map<string, string>>();

  const listChunkFiles = async (recordingId: string) => {
    const chunks: Array<StoredRecordingChunk & { name: string }> = [];
    for (const name of await fs.list(directory(recordingId))) {
      const chunk = parseRecordingChunkFileName(recordingId, name);
      if (chunk) chunks.push({ ...chunk, name });
    }
    chunks.sort((a, b) => a.trackNumber - b.trackNumber || a.chunkNumber - b.chunkNumber);
    names.set(
      recordingId,
      new Map(chunks.map((chunk) => [key(chunk.trackNumber, chunk.chunkNumber), chunk.name])),
    );
    return chunks;
  };

  const fileName = async (recordingId: string, trackNumber: number, chunkNumber: number) => {
    const cached = names.get(recordingId)?.get(key(trackNumber, chunkNumber));
    if (cached) return cached;
    await listChunkFiles(recordingId);
    return names.get(recordingId)?.get(key(trackNumber, chunkNumber)) ?? null;
  };

  const getRecording = async (recordingId: string): Promise<StoredRecording | null> => {
    const text = await fs.readText(`${directory(recordingId)}/${RECORDING_FILE}`);
    if (!text) return null;
    try {
      return JSON.parse(text) as StoredRecording;
    } catch {
      return null;
    }
  };

  const putRecording = async (recording: StoredRecording) => {
    await fs.makeDirectory(directory(recording.recordingId));
    await fs.writeText(
      `${directory(recording.recordingId)}/${RECORDING_FILE}`,
      JSON.stringify(recording),
    );
  };

  return {
    directory,
    putRecording,
    getRecording,
    async listRecordings() {
      const recordings: StoredRecording[] = [];
      for (const name of await fs.list(root)) {
        const recording = await getRecording(name);
        if (recording) recordings.push(recording);
      }
      return recordings;
    },
    async deleteRecording(recordingId) {
      names.delete(recordingId);
      await fs.remove(directory(recordingId));
    },
    async putChunk(chunk: RecordingChunk) {
      const { bytes, ...details } = chunk;
      const name = recordingChunkFileName({ ...details, byteLength: bytes.byteLength });
      const existing = await fileName(chunk.recordingId, chunk.trackNumber, chunk.chunkNumber);
      // The native recorder already wrote this exact file into the recording's directory.
      if (existing === name) return;
      await fs.makeDirectory(directory(chunk.recordingId));
      await fs.writeBytes(`${directory(chunk.recordingId)}/${name}`, bytes);
      if (existing) await fs.remove(`${directory(chunk.recordingId)}/${existing}`);
      names.get(chunk.recordingId)?.set(key(chunk.trackNumber, chunk.chunkNumber), name);
    },
    async listChunks(recordingId) {
      return (await listChunkFiles(recordingId)).map(({ name: _name, ...chunk }) => chunk);
    },
    async readChunk(recordingId, trackNumber, chunkNumber) {
      const name = await fileName(recordingId, trackNumber, chunkNumber);
      if (!name) return null;
      return await fs.readBytes(`${directory(recordingId)}/${name}`);
    },
    async deleteChunks(recordingId, trackNumber, chunkNumbers) {
      for (const chunkNumber of chunkNumbers) {
        const name = await fileName(recordingId, trackNumber, chunkNumber);
        if (!name) continue;
        await fs.remove(`${directory(recordingId)}/${name}`);
        names.get(recordingId)?.delete(key(trackNumber, chunkNumber));
      }
    },
    async recover(options = {}) {
      for (const recordingId of await fs.list(root)) {
        if (options.skip?.(recordingId)) continue;
        const recording = await getRecording(recordingId);
        if (!recording) continue;
        const folder = directory(recordingId);
        for (const name of await fs.list(folder)) {
          const part = PART.exec(name);
          if (!part) continue;
          const bytes = (await fs.readBytes(`${folder}/${name}`)) ?? new Uint8Array();
          const whole = wholeAdtsFrames(bytes);
          if (whole.frames > 0) {
            const kept = bytes.slice(0, whole.byteLength);
            const chunkName = recordingChunkFileName({
              trackNumber: Number(part[1]),
              chunkNumber: Number(part[2]),
              startMilliseconds: Number(part[3]),
              durationMilliseconds: whole.durationMilliseconds,
              byteLength: kept.byteLength,
              sha256: await input.sha256(kept),
            });
            await fs.writeBytes(`${folder}/${chunkName}`, kept);
          }
          await fs.remove(`${folder}/${name}`);
        }
        const counts = { ...recording.chunkCounts };
        let changed = false;
        for (const chunk of await listChunkFiles(recordingId)) {
          if ((counts[chunk.trackNumber] ?? 0) <= chunk.chunkNumber) {
            counts[chunk.trackNumber] = chunk.chunkNumber + 1;
            changed = true;
          }
        }
        if (changed) {
          // updatedAt stays: resuming takes it as the time capture ended.
          await putRecording({ ...recording, chunkCounts: counts });
        }
      }
    },
  };
}
