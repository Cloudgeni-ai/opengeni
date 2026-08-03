import { describe, expect, spyOn, test } from "bun:test";
import { MODEL_ATTACHMENT_REFS_FIELD, type FileAsset } from "@opengeni/contracts";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { prepareRunInput, type AgentSegmentInput, type OpenGeniRuntime } from "@opengeni/runtime";
import { createHash } from "node:crypto";
import {
  MAX_INLINE_MODEL_ATTACHMENT_BYTES,
  createModelHistoryAttachmentProjector,
  modelAttachmentContentForFiles,
  turnInput,
} from "../src/activities/run-input";

const user = (content: string) => ({ type: "message", role: "user", content });
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
        throw new Error(`storage unavailable for ${failed.objectKey}`);
      });

      expect(content).toEqual([]);
      expect(error).toHaveBeenCalledTimes(2);
      expect(error.mock.calls[1]?.[1]).toEqual({
        fileId: failed.id,
        errorType: "Error",
      });
      expect(JSON.stringify(error.mock.calls)).not.toContain(failed.objectKey);
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

describe("durable attachment history projection", () => {
  test("rehydrates image/PDF refs once per turn while keeping other files sandbox-only", async () => {
    const imageBytes = new TextEncoder().encode("image");
    const pdfBytes = new TextEncoder().encode("pdf");
    const textBytes = new TextEncoder().encode("notes");
    const image = {
      ...file("00000000-0000-4000-8000-000000000061", "image/png", imageBytes.length, "a.png"),
      sha256: sha256(imageBytes),
    };
    const pdf = {
      ...file("00000000-0000-4000-8000-000000000062", "application/pdf", pdfBytes.length, "b.pdf"),
      sha256: sha256(pdfBytes),
    };
    const notes = {
      ...file("00000000-0000-4000-8000-000000000063", "text/plain", textBytes.length, "c.txt"),
      sha256: sha256(textBytes),
    };
    const history = [
      {
        ...user("inspect these"),
        [MODEL_ATTACHMENT_REFS_FIELD]: [
          { kind: "file", fileId: image.id },
          { kind: "file", fileId: pdf.id },
          { kind: "file", fileId: notes.id },
        ],
      },
    ];
    const getFiles = spyOn(opengeniDb, "getFiles").mockResolvedValue([image, pdf, notes]);
    const reads: string[] = [];
    const projector = createModelHistoryAttachmentProjector(
      {} as Database,
      image.workspaceId,
      { supportsImageInput: true, inputFileMediaTypes: ["application/pdf"] },
      async (asset) => {
        reads.push(asset.id);
        return asset.id === image.id ? imageBytes : asset.id === pdf.id ? pdfBytes : textBytes;
      },
    );

    try {
      const first = await projector(history);
      const second = await projector(history);
      const json = JSON.stringify(first);

      expect(json).toContain("data:image/png;base64");
      expect(json).toContain("data:application/pdf;base64");
      expect(json).not.toContain("data:text/plain;base64");
      expect(json).toContain("c.txt (text/plain)");
      expect(json).not.toContain(MODEL_ATTACHMENT_REFS_FIELD);
      expect(second).toEqual(first);
      expect(new Set(reads)).toEqual(new Set([image.id, pdf.id]));
      expect(reads).toHaveLength(2);
      expect(getFiles).toHaveBeenCalledTimes(1);
      expect(history[0]?.[MODEL_ATTACHMENT_REFS_FIELD]).toHaveLength(3);
    } finally {
      getFiles.mockRestore();
    }
  });

  test("text-only projection reads metadata once and never reads object bytes", async () => {
    const imageBytes = new TextEncoder().encode("image");
    const image = {
      ...file("00000000-0000-4000-8000-000000000064", "image/png", imageBytes.length, "a.png"),
      sha256: sha256(imageBytes),
    };
    const history = [
      {
        ...user("remember this"),
        [MODEL_ATTACHMENT_REFS_FIELD]: [{ kind: "file", fileId: image.id }],
      },
    ];
    const getFiles = spyOn(opengeniDb, "getFiles").mockResolvedValue([image]);
    let reads = 0;
    const projector = createModelHistoryAttachmentProjector(
      {} as Database,
      image.workspaceId,
      { supportsImageInput: false, inputFileMediaTypes: [] },
      async () => {
        reads += 1;
        return imageBytes;
      },
    );

    try {
      const projected = await projector(history);
      await projector(history);
      expect(JSON.stringify(projected)).not.toContain("data:image");
      expect(JSON.stringify(projected)).toContain("a.png (image/png)");
      expect(reads).toBe(0);
      expect(getFiles).toHaveBeenCalledTimes(1);

      const restored = await createModelHistoryAttachmentProjector(
        {} as Database,
        image.workspaceId,
        { supportsImageInput: true, inputFileMediaTypes: [] },
        async () => {
          reads += 1;
          return imageBytes;
        },
      )(history);
      expect(JSON.stringify(restored)).toContain("data:image/png;base64,aW1hZ2U=");
      expect(history[0]?.[MODEL_ATTACHMENT_REFS_FIELD]).toHaveLength(1);
      expect(reads).toBe(1);
      expect(getFiles).toHaveBeenCalledTimes(2);
    } finally {
      getFiles.mockRestore();
    }
  });

  test("no-ref giant-history fast path returns the original array without I/O", async () => {
    const history = Array.from({ length: 100_000 }, (_, index) => user(`message ${index}`));
    const getFiles = spyOn(opengeniDb, "getFiles").mockResolvedValue([]);
    const projector = createModelHistoryAttachmentProjector(
      {} as Database,
      "00000000-0000-4000-8000-000000000001",
      { supportsImageInput: false, inputFileMediaTypes: [] },
    );
    try {
      expect(await projector(history)).toBe(history);
      expect(getFiles).not.toHaveBeenCalled();
    } finally {
      getFiles.mockRestore();
    }
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
    const getFiles = spyOn(opengeniDb, "getFiles").mockResolvedValue([image]);
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
          projectModelHistory: createModelHistoryAttachmentProjector(
            {} as Database,
            image.workspaceId,
            { supportsImageInput: true, inputFileMediaTypes: [] },
            async () => imageBytes,
          ),
        },
      );

      expect(preparedInput).toMatchObject({
        kind: "message",
        internalContext:
          "Attached files are available in the sandbox:\n" +
          `- diagram.png (image/png, 5 bytes): /workspace/.opengeni/files/${image.id}/diagram.png`,
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
      expect(getFiles).toHaveBeenCalledTimes(1);
    } finally {
      requireFile.mockRestore();
      getFiles.mockRestore();
      listUpdates.mockRestore();
      getHistory.mockRestore();
      getEnvelope.mockRestore();
    }
  });

  test("uses only canonical history and recovery context after realtime", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000060";
    const sessionId = "00000000-0000-4000-8000-000000000061";
    const projectedTurnId = "00000000-0000-4000-8000-000000000062";
    const laterTurnId = "00000000-0000-4000-8000-000000000063";
    const storedUser = user("continue after voice");
    const modelInputs: unknown[] = [];
    const listUpdates = spyOn(opengeniDb, "listSessionSystemUpdatesForTurn").mockImplementation(
      async () => [],
    );
    const getHistory = spyOn(opengeniDb, "getActiveSessionHistoryItems").mockResolvedValue([
      { position: 0, item: storedUser, producerCodexCredentialId: null },
    ]);
    const getEnvelope = spyOn(opengeniDb, "getSandboxSessionEnvelope").mockResolvedValue(null);
    const runtime = {
      prepareInput: async (agent: unknown, input: AgentSegmentInput) => {
        const prepared = await prepareRunInput(agent as never, input);
        modelInputs.push(prepared.input);
        return prepared;
      },
    } as unknown as OpenGeniRuntime;
    const trigger = {
      id: "00000000-0000-4000-8000-000000000065",
      workspaceId,
      sessionId,
      sequence: 1,
      type: "user.message" as const,
      payload: { text: "continue after voice", resources: [] },
      occurredAt: "2026-07-29T00:00:00.000Z",
    };

    try {
      await turnInput(
        {} as Database,
        runtime,
        {},
        trigger,
        { currentCodexCredentialId: null },
        { turnId: projectedTurnId, recovering: true },
      );
      await turnInput(
        {} as Database,
        runtime,
        {},
        trigger,
        { currentCodexCredentialId: null },
        { turnId: laterTurnId },
      );

      const recoveryInput = modelInputs[0] as Array<Record<string, unknown>>;
      expect(recoveryInput[0]).toEqual(storedUser);
      expect(recoveryInput[1]).toMatchObject({ type: "message", role: "system" });
      const recoverySystemContent = (recoveryInput[1] as { content: string }).content;
      expect(recoverySystemContent).toContain("[OpenGeni inference recovery]");
      expect(modelInputs[1]).toEqual([storedUser]);
    } finally {
      listUpdates.mockRestore();
      getHistory.mockRestore();
      getEnvelope.mockRestore();
    }
  });
});
