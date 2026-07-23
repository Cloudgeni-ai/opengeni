import { describe, expect, spyOn, test } from "bun:test";
import { ModelItem } from "@openai/agents-core/types";
import type { FileAsset } from "@opengeni/contracts";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import type { AgentSegmentInput, OpenGeniRuntime } from "@opengeni/runtime";
import { createHash } from "node:crypto";
import {
  MAX_INLINE_MODEL_ATTACHMENT_BYTES,
  modelAttachmentContentForFiles,
  turnInput,
  withCurrentUserAttachmentContent,
} from "../src/activities/run-input";

const user = (content: string) => ({ type: "message", role: "user", content });
const assistant = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const file = (
  id: string,
  contentType: string,
  sizeBytes: number,
  safeFilename = `${id}.bin`,
): FileAsset => ({
  id,
  workspaceId: "00000000-0000-4000-8000-000000000001",
  status: "ready",
  filename: safeFilename,
  safeFilename,
  contentType,
  sizeBytes,
  sha256: null,
  bucket: "files",
  objectKey: `workspace/${id}`,
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
});

describe("modelAttachmentContentForFiles", () => {
  test("reads supported images and documents in finalized attachment order", async () => {
    const imageBytes = new TextEncoder().encode("image");
    const pdfBytes = new TextEncoder().encode("pdf");
    const image = {
      ...file("00000000-0000-4000-8000-000000000010", "image/png", 5, "diagram.png"),
      sha256: sha256(imageBytes),
    };
    const pdf = {
      ...file("00000000-0000-4000-8000-000000000011", "application/pdf", 3, "requirements.pdf"),
      sha256: sha256(pdfBytes),
    };
    const bytesById = new Map([
      [image.id, imageBytes],
      [pdf.id, pdfBytes],
    ]);

    const content = await modelAttachmentContentForFiles(
      [image, pdf],
      async (entry) => bytesById.get(entry.id)!,
    );

    expect(content).toEqual([
      {
        kind: "image",
        fileId: image.id,
        filename: "diagram.png",
        contentType: "image/png",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      },
      {
        kind: "file",
        fileId: pdf.id,
        filename: "requirements.pdf",
        contentType: "application/pdf",
        dataUrl: "data:application/pdf;base64,cGRm",
      },
    ]);
  });

  test("normalizes MIME parameters before constructing a data URL", async () => {
    const imageBytes = new TextEncoder().encode("image");
    const image = {
      ...file(
        "00000000-0000-4000-8000-000000000012",
        "IMAGE/PNG; charset=binary",
        5,
        "diagram.png",
      ),
      sha256: sha256(imageBytes),
    };

    expect(await modelAttachmentContentForFiles([image], async () => imageBytes)).toEqual([
      expect.objectContaining({
        contentType: "image/png",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      }),
    ]);
  });

  test("fails closed for active or unsupported MIME types without reading their bytes", async () => {
    const unsupported = [
      file("00000000-0000-4000-8000-000000000020", "image/svg+xml", 1, "active.svg"),
      file("00000000-0000-4000-8000-000000000021", "text/html", 1, "active.html"),
      file("00000000-0000-4000-8000-000000000022", "application/javascript", 1, "active.js"),
      file("00000000-0000-4000-8000-000000000023", "application/octet-stream", 1, "unknown.bin"),
      file("00000000-0000-4000-8000-000000000024", "application/xml", 1, "generic.xml"),
      file("00000000-0000-4000-8000-000000000025", "text/xml", 1, "generic-text.xml"),
    ];
    let reads = 0;

    expect(
      await modelAttachmentContentForFiles(unsupported, async () => {
        reads += 1;
        return new Uint8Array([1]);
      }),
    ).toEqual([]);
    expect(reads).toBe(0);
  });

  test("enforces the aggregate byte bound before object-storage reads", async () => {
    const firstBytes = new Uint8Array(MAX_INLINE_MODEL_ATTACHMENT_BYTES);
    const first = {
      ...file(
        "00000000-0000-4000-8000-000000000030",
        "text/plain",
        MAX_INLINE_MODEL_ATTACHMENT_BYTES,
        "full.txt",
      ),
      sha256: sha256(firstBytes),
    };
    const overflowBytes = new Uint8Array([1]);
    const overflow = {
      ...file("00000000-0000-4000-8000-000000000031", "image/png", 1, "overflow.png"),
      sha256: sha256(overflowBytes),
    };
    const reads: string[] = [];

    const content = await modelAttachmentContentForFiles([first, overflow], async (entry) => {
      reads.push(entry.id);
      return firstBytes;
    });

    expect(content).toHaveLength(1);
    expect(content[0]?.fileId).toBe(first.id);
    expect(reads).toEqual([first.id]);
  });

  test("omits a byte-length mismatch and a failed storage read without rejecting the prompt", async () => {
    const mismatch = {
      ...file("00000000-0000-4000-8000-000000000040", "image/png", 2, "mismatch.png"),
      sha256: "0".repeat(64),
    };
    const failed = {
      ...file("00000000-0000-4000-8000-000000000041", "application/pdf", 2, "failed.pdf"),
      sha256: "0".repeat(64),
    };
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const content = await modelAttachmentContentForFiles([mismatch, failed], async (entry) => {
        if (entry.id === mismatch.id) return new Uint8Array([1]);
        throw new Error("storage unavailable");
      });

      expect(content).toEqual([]);
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });

  test("only projects ready assets whose bytes match finalized checksum metadata", async () => {
    const bytes = new TextEncoder().encode("exact content");
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    const ready = {
      ...file("00000000-0000-4000-8000-000000000042", "text/plain", bytes.byteLength, "ready.txt"),
      sha256: expectedHash,
    };
    const wrongHash = {
      ...file(
        "00000000-0000-4000-8000-000000000043",
        "text/plain",
        bytes.byteLength,
        "wrong-hash.txt",
      ),
      sha256: "0".repeat(64),
    };
    const missingHash = file(
      "00000000-0000-4000-8000-000000000045",
      "text/plain",
      bytes.byteLength,
      "missing-hash.txt",
    );
    const malformedHash = {
      ...file(
        "00000000-0000-4000-8000-000000000046",
        "text/plain",
        bytes.byteLength,
        "malformed-hash.txt",
      ),
      sha256: "not-a-sha256",
    };
    const pending = {
      ...file(
        "00000000-0000-4000-8000-000000000044",
        "text/plain",
        bytes.byteLength,
        "pending.txt",
      ),
      status: "pending_upload" as const,
      sha256: expectedHash,
    };
    const reads: string[] = [];
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const content = await modelAttachmentContentForFiles(
        [ready, wrongHash, missingHash, malformedHash, pending],
        async (entry) => {
          reads.push(entry.id);
          return bytes;
        },
      );

      expect(content.map((entry) => entry.fileId)).toEqual([ready.id]);
      expect(reads).toEqual([ready.id, wrongHash.id]);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });
});

describe("withCurrentUserAttachmentContent", () => {
  test("projects finalized image and file content onto the current user item in order", () => {
    const history = [
      user("earlier request"),
      assistant("earlier response"),
      user("inspect both attachments"),
    ];

    const projected = withCurrentUserAttachmentContent(history, [
      {
        kind: "image",
        fileId: "image-file-id",
        filename: "diagram.png",
        contentType: "image/png",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      },
      {
        kind: "file",
        fileId: "document-file-id",
        filename: "requirements.pdf",
        contentType: "application/pdf",
        dataUrl: "data:application/pdf;base64,cGRm",
      },
    ]);

    expect(projected).toHaveLength(history.length);
    expect(projected.slice(0, 2)).toEqual(history.slice(0, 2));
    expect(projected[2]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "inspect both attachments" },
        { type: "input_image", image: "data:image/png;base64,aW1hZ2U=" },
        {
          type: "input_file",
          file: "data:application/pdf;base64,cGRm",
          filename: "requirements.pdf",
        },
      ],
    });
    expect(history[2]).toEqual(user("inspect both attachments"));
    expect(ModelItem.parse(projected[2])).toEqual(projected[2]);
  });

  test("re-enriches the most recent user boundary during recovery without duplicating a row", () => {
    const current = user("continue inspecting the image");
    const partial = assistant("partial result before worker restart");
    const history = [user("older"), current, partial];

    const projected = withCurrentUserAttachmentContent(history, [
      {
        kind: "image",
        fileId: "image-file-id",
        filename: "recovery.png",
        contentType: "image/png",
        dataUrl: "data:image/png;base64,cmVjb3Zlcnk=",
      },
    ]);

    expect(projected).toHaveLength(history.length);
    expect(projected[2]).toBe(partial);
    expect(projected[1]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "continue inspecting the image" },
        { type: "input_image", image: "data:image/png;base64,cmVjb3Zlcnk=" },
      ],
    });
    expect(history[1]).toBe(current);
  });

  test("preserves existing structured user content and appends attachment content", () => {
    const existingContent = [
      { type: "input_text", text: "inspect" },
      { type: "input_text", text: "preserve this segment" },
    ];
    const current = { type: "message", role: "user", content: existingContent };
    const history = [current];

    const projected = withCurrentUserAttachmentContent(history, [
      {
        kind: "file",
        fileId: "document-file-id",
        filename: "notes.txt",
        contentType: "text/plain",
        dataUrl: "data:text/plain;base64,bm90ZXM=",
      },
    ]);

    expect(projected[0]).toEqual({
      type: "message",
      role: "user",
      content: [
        ...existingContent,
        {
          type: "input_file",
          file: "data:text/plain;base64,bm90ZXM=",
          filename: "notes.txt",
        },
      ],
    });
    expect(history[0]).toBe(current);
    expect(current.content).toBe(existingContent);
  });

  test("is a no-op without typed attachment content or a user boundary", () => {
    const history = [assistant("no user row")];
    expect(withCurrentUserAttachmentContent(history, [])).toBe(history);
    expect(
      withCurrentUserAttachmentContent(history, [
        {
          kind: "image",
          fileId: "orphan",
          filename: "orphan.png",
          contentType: "image/png",
          dataUrl: "data:image/png;base64,b3JwaGFu",
        },
      ]),
    ).toBe(history);
  });
});

describe("turnInput attachment projection", () => {
  test("keeps sandbox path context and adds object bytes to the model-only user row", async () => {
    const imageBytes = new TextEncoder().encode("image");
    const image = {
      ...file("00000000-0000-4000-8000-000000000050", "image/png", 5, "diagram.png"),
      sha256: sha256(imageBytes),
    };
    const storedUser = user("inspect the diagram");
    let preparedInput: AgentSegmentInput | undefined;
    const requireFile = spyOn(opengeniDb, "requireFile").mockResolvedValue(image);
    const listUpdates = spyOn(opengeniDb, "listSessionSystemUpdatesForTurn").mockResolvedValue([]);
    const getHistory = spyOn(opengeniDb, "getActiveSessionHistoryItems").mockResolvedValue([
      {
        item: storedUser,
        producerCodexCredentialId: null,
      },
    ]);
    const getEnvelope = spyOn(opengeniDb, "getSandboxSessionEnvelope").mockResolvedValue(null);
    const runtime = {
      prepareInput: async (_agent: unknown, input: AgentSegmentInput) => {
        preparedInput = input;
        return { input: [] };
      },
    } as unknown as OpenGeniRuntime;

    try {
      await turnInput(
        {} as Database,
        runtime,
        {},
        {
          id: "00000000-0000-4000-8000-000000000051",
          workspaceId: image.workspaceId,
          sessionId: "00000000-0000-4000-8000-000000000052",
          sequence: 1,
          type: "user.message",
          payload: {
            text: "inspect the diagram",
            resources: [{ kind: "file", fileId: image.id }],
          },
          occurredAt: "2026-07-19T00:00:00.000Z",
        },
        { currentCodexCredentialId: null },
        {
          turnId: "00000000-0000-4000-8000-000000000053",
          readFileBytesForModel: async () => imageBytes,
        },
      );

      expect(preparedInput).toMatchObject({
        kind: "message",
        internalContext:
          "Attached files are available in the sandbox:\n" +
          `- diagram.png (image/png, 5 bytes): /workspace/files/${image.id}/diagram.png`,
        historyItems: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "inspect the diagram" },
              { type: "input_image", image: "data:image/png;base64,aW1hZ2U=" },
            ],
          },
        ],
      });
      expect(storedUser).toEqual(user("inspect the diagram"));
      expect(requireFile).toHaveBeenCalledTimes(1);
    } finally {
      requireFile.mockRestore();
      listUpdates.mockRestore();
      getHistory.mockRestore();
      getEnvelope.mockRestore();
    }
  });
});
