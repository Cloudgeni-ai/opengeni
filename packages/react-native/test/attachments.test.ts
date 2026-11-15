import { describe, expect, test } from "bun:test";
import { createOpenGeniText } from "@opengeni/react/messages";
import type { FileAttachmentClientLike } from "@opengeni/react/session";
import type { NativeCryptoAdapter, NativeFileAdapter, NativePickedFile } from "../src/adapters";
import {
  addNativeFilesForGeneration,
  NATIVE_ATTACHMENT_DIGEST_MAX_BYTES,
  nativeAttachmentKind,
  prepareNativeAttachmentData,
  prepareNativeAttachmentUpload,
  projectNativeAttachmentScopeState,
  runNativeAttachmentPicker,
  sameNativeAttachmentScope,
  type NativeAttachment,
} from "../src/attachments";

const englishText = createOpenGeniText();

const source: NativePickedFile = {
  id: "file-1",
  uri: "file:///image.heic",
  name: "image.heic",
  contentType: "image/heic",
  sizeBytes: 3,
  kind: "image",
};

function fileAdapter(readBytes: NativeFileAdapter["readBytes"]): NativeFileAdapter {
  return {
    pickDocuments: async () => [],
    pickImages: async () => [],
    readBytes,
  };
}

describe("prepareNativeAttachmentUpload", () => {
  test("returns the exact native bytes and digest", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const crypto: NativeCryptoAdapter = {
      randomUUID: () => "uuid",
      sha256Hex: async (value) => {
        expect(value).toBe(bytes);
        return "a".repeat(64);
      },
    };

    const prepared = await prepareNativeAttachmentUpload(englishText, {
      source,
      files: fileAdapter(async () => bytes),
      crypto,
    });

    expect(prepared.bytes).toBe(bytes);
    expect(new Uint8Array(prepared.data)).toEqual(bytes);
    expect(prepared.sha256).toBe("a".repeat(64));
  });

  test("copies only the exact byte view into the React Native-safe upload body", async () => {
    const backing = new Uint8Array([9, 1, 2, 3, 8]);
    const bytes = backing.subarray(1, 4);
    const crypto: NativeCryptoAdapter = {
      randomUUID: () => "uuid",
      sha256Hex: async () => "a".repeat(64),
    };

    const prepared = await prepareNativeAttachmentUpload(englishText, {
      source,
      files: fileAdapter(async () => bytes),
      crypto,
    });

    expect(new Uint8Array(prepared.data)).toEqual(new Uint8Array([1, 2, 3]));
    expect(prepared.data).not.toBe(backing.buffer);
  });

  test("turns an unreadable native file into a bounded retryable failure", async () => {
    const crypto: NativeCryptoAdapter = {
      randomUUID: () => "uuid",
      sha256Hex: async () => "a".repeat(64),
    };

    await expect(
      prepareNativeAttachmentUpload(englishText, {
        source,
        files: fileAdapter(async () => await new Promise<Uint8Array>(() => undefined)),
        crypto,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("File preparation timed out. Retry the upload.");
  });

  test("turns a stalled digest into a bounded retryable failure", async () => {
    const crypto: NativeCryptoAdapter = {
      randomUUID: () => "uuid",
      sha256Hex: async () => await new Promise<string>(() => undefined),
    };

    await expect(
      prepareNativeAttachmentUpload(englishText, {
        source,
        files: fileAdapter(async () => new Uint8Array([1, 2, 3])),
        crypto,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("File verification timed out. Retry the upload.");
  });
});

describe("native attachment scope", () => {
  test("treats a session switch as a new attachment scope", () => {
    const client = attachmentClient();
    const base = { client, workspaceId: "workspace-1", sessionId: "session-1" };

    expect(sameNativeAttachmentScope(base, base)).toBe(true);
    expect(sameNativeAttachmentScope(base, { ...base, sessionId: "session-2" })).toBe(false);
    expect(sameNativeAttachmentScope(base, { ...base, workspaceId: "workspace-2" })).toBe(false);
    expect(sameNativeAttachmentScope(base, { ...base, client: attachmentClient() })).toBe(false);
  });

  test("synchronously hides stale resources and errors while the new session scope resets", () => {
    const staleAttachment: NativeAttachment = {
      id: "file-1",
      name: "stale.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      kind: "document",
      status: "ready",
    };
    const staleError = new Error("stale");

    expect(projectNativeAttachmentScopeState(false, [staleAttachment], staleError)).toEqual({
      attachments: [],
      error: null,
    });
    expect(projectNativeAttachmentScopeState(true, [staleAttachment], staleError)).toEqual({
      attachments: [staleAttachment],
      error: staleError,
    });
  });

  test("drops a deferred picker result after the session scope changes", async () => {
    let generation = 0;
    let resolvePicker: ((files: NativePickedFile[]) => void) | undefined;
    const picker = new Promise<NativePickedFile[]>((resolve) => {
      resolvePicker = resolve;
    });
    const added: NativePickedFile[][] = [];
    const errors: Error[] = [];

    const result = runNativeAttachmentPicker({
      generation,
      currentGeneration: () => generation,
      pick: async () => await picker,
      addFiles: async (files) => {
        added.push(files);
      },
      onError: (error) => errors.push(error),
    });

    generation += 1;
    resolvePicker?.([source]);

    await expect(result).resolves.toBe("stale");
    expect(added).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("adds picker results only while the originating scope remains current", async () => {
    const added: NativePickedFile[][] = [];

    await expect(
      runNativeAttachmentPicker({
        generation: 4,
        currentGeneration: () => 4,
        pick: async () => [source],
        addFiles: async (files, generation) => {
          expect(generation).toBe(4);
          added.push(files);
        },
        onError: () => undefined,
      }),
    ).resolves.toBe("added");
    expect(added).toEqual([[source]]);
  });

  test("stops serial uploads when the scope changes between files", async () => {
    const secondSource: NativePickedFile = {
      ...source,
      id: "file-2",
      uri: "file:///second.heic",
      name: "second.heic",
    };
    let generation = 4;
    const remembered: string[] = [];
    const appended: string[][] = [];
    const uploads: Array<{ id: string; generation: number }> = [];

    await addNativeFilesForGeneration({
      files: [source, secondSource],
      generation,
      currentGeneration: () => generation,
      hasSource: () => false,
      rememberSource: (file) => remembered.push(file.id),
      appendAttachments: (files) => appended.push(files.map((file) => file.id)),
      upload: async (file, originatingGeneration) => {
        uploads.push({ id: file.id, generation: originatingGeneration });
        generation += 1;
      },
    });

    expect(remembered).toEqual(["file-1", "file-2"]);
    expect(appended).toEqual([["file-1", "file-2"]]);
    expect(uploads).toEqual([{ id: "file-1", generation: 4 }]);
  });
});

describe("prepareNativeAttachmentData", () => {
  const hashing: NativeCryptoAdapter = {
    randomUUID: () => "uuid",
    sha256Hex: async () => "c".repeat(64),
  };
  const streamedSource = (sizeBytes: number) => ({
    sizeBytes,
    send: async () => ({ status: 200 }),
  });

  test("a long video streams from disk without being read or hashed", async () => {
    let reads = 0;
    const streamed = streamedSource(NATIVE_ATTACHMENT_DIGEST_MAX_BYTES + 1);
    const prepared = await prepareNativeAttachmentData(englishText, {
      source: { ...source, kind: "video", contentType: "video/quicktime" },
      files: {
        ...fileAdapter(async () => {
          reads += 1;
          return new Uint8Array();
        }),
        uploadSource: () => streamed,
      },
      crypto: hashing,
      onProgress: () => undefined,
    });
    expect(prepared).toEqual({ data: streamed, streamed: true });
    expect(reads).toBe(0);
  });

  test("a photo still streams but keeps its digest", async () => {
    const streamed = streamedSource(NATIVE_ATTACHMENT_DIGEST_MAX_BYTES);
    const prepared = await prepareNativeAttachmentData(englishText, {
      source,
      files: { ...fileAdapter(async () => new Uint8Array([1])), uploadSource: () => streamed },
      crypto: hashing,
      onProgress: () => undefined,
    });
    expect(prepared).toEqual({ data: streamed, sha256: "c".repeat(64), streamed: true });
  });

  test("an adapter without streaming reads the file into memory as before", async () => {
    const prepared = await prepareNativeAttachmentData(englishText, {
      source,
      files: fileAdapter(async () => new Uint8Array([1, 2, 3])),
      crypto: hashing,
      onProgress: () => undefined,
    });
    expect(prepared.streamed).toBe(false);
    expect(prepared.sha256).toBe("c".repeat(64));
    expect(new Uint8Array(prepared.data as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("a file the adapter cannot stream fails the attachment, not the composer", async () => {
    await expect(
      prepareNativeAttachmentData(englishText, {
        source,
        files: {
          ...fileAdapter(async () => new Uint8Array()),
          uploadSource: () => {
            throw new Error("This file is no longer on the device. Attach it again.");
          },
        },
        crypto: hashing,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow("This file is no longer on the device. Attach it again.");
  });
});

describe("nativeAttachmentKind", () => {
  test("photos, videos and everything else", () => {
    expect(nativeAttachmentKind("image/heic")).toBe("image");
    expect(nativeAttachmentKind("video/quicktime")).toBe("video");
    expect(nativeAttachmentKind("VIDEO/MP4")).toBe("video");
    expect(nativeAttachmentKind("application/pdf")).toBe("document");
  });
});

function attachmentClient(): FileAttachmentClientLike {
  return {
    uploadFile: async () => await Promise.reject(new Error("not used by scope tests")),
  };
}
