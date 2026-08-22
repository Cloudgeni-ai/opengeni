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
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000000";
const SUBJECT_ID = "user:attachment-authority";

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
  test("reads supported images in finalized attachment order and skips documents", async () => {
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
        "image/png",
        MAX_INLINE_MODEL_ATTACHMENT_BYTES,
        "full.png",
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
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  test("only projects ready assets whose bytes match finalized checksum metadata", async () => {
    const bytes = new TextEncoder().encode("exact content");
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    const ready = {
      ...file("00000000-0000-4000-8000-000000000042", "image/png", bytes.byteLength, "ready.png"),
      sha256: expectedHash,
    };
    const wrongHash = {
      ...file(
        "00000000-0000-4000-8000-000000000043",
        "image/png",
        bytes.byteLength,
        "wrong-hash.png",
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
  test("keeps historical refs as receipts and inlines only explicitly current files", async () => {
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
    const reads: string[] = [];
    const projector = createModelHistoryAttachmentProjector(
      { supportsImageInput: true, inputFileMediaTypes: ["application/pdf"] },
      async (asset) => {
        reads.push(asset.id);
        return asset.id === image.id ? imageBytes : asset.id === pdf.id ? pdfBytes : textBytes;
      },
    );

    const historical = await projector(history);
    expect(JSON.stringify(historical)).not.toContain(";base64,");
    expect(JSON.stringify(historical)).toContain(`fileId=${image.id}`);
    expect(reads).toEqual([]);

    const inlineFiles = [image, pdf];
    const first = await projector(history, { inlineFiles });
    const second = await projector(history, { inlineFiles });
    const historicalAgain = await projector(history);
    const json = JSON.stringify(first);

    expect(json).toContain("data:image/png;base64");
    expect(json).not.toContain("data:application/pdf;base64");
    expect(json).not.toContain("data:text/plain;base64");
    expect(json).toContain(`fileId=${pdf.id}`);
    expect(json).toContain(`fileId=${notes.id}`);
    expect(json).not.toContain(MODEL_ATTACHMENT_REFS_FIELD);
    expect(second).toEqual(first);
    expect(JSON.stringify(historicalAgain)).not.toContain(";base64,");
    expect(reads).toEqual([image.id]);
    expect(history[0]?.[MODEL_ATTACHMENT_REFS_FIELD]).toHaveLength(3);
  });

  test("historical projection reads neither metadata nor object bytes", async () => {
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
    let reads = 0;
    const projector = createModelHistoryAttachmentProjector(
      { supportsImageInput: false, inputFileMediaTypes: [] },
      async () => {
        reads += 1;
        return imageBytes;
      },
    );

    const projected = await projector(history);
    await projector(history);
    expect(JSON.stringify(projected)).not.toContain("data:image");
    expect(JSON.stringify(projected)).toContain(`fileId=${image.id}`);
    expect(reads).toBe(0);

    const restored = await createModelHistoryAttachmentProjector(
      { supportsImageInput: true, inputFileMediaTypes: [] },
      async () => {
        reads += 1;
        return imageBytes;
      },
    )(history, { inlineFiles: [image] });
    expect(JSON.stringify(restored)).toContain("data:image/png;base64,aW1hZ2U=");
    expect(history[0]?.[MODEL_ATTACHMENT_REFS_FIELD]).toHaveLength(1);
    expect(reads).toBe(1);
  });

  test("no-ref giant-history fast path returns the original array without I/O", async () => {
    const history = Array.from({ length: 100_000 }, (_, index) => user(`message ${index}`));
    const projector = createModelHistoryAttachmentProjector({
      supportsImageInput: false,
      inputFileMediaTypes: [],
    });
    expect(await projector(history)).toBe(history);
  });
});

describe("turnInput attachment projection", () => {
  test("reports bounded history subphases without letting diagnostics change input", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000030";
    const sessionId = "00000000-0000-4000-8000-000000000031";
    const phases: string[] = [];
    const listUpdates = spyOn(opengeniDb, "listSessionSystemUpdatesForTurn").mockResolvedValue([]);
    const getEnvelope = spyOn(opengeniDb, "getSandboxSessionEnvelope").mockResolvedValue(null);
    const runtime = {
      prepareInput: async () => ({ input: [], persistedHistoryCount: 1 }),
    } as unknown as OpenGeniRuntime;

    try {
      const prepared = await turnInput(
        {} as Database,
        runtime,
        {},
        {
          id: "00000000-0000-4000-8000-000000000032",
          workspaceId,
          sessionId,
          sequence: 1,
          type: "user.message",
          payload: { text: "measure history", resources: [] },
          occurredAt: "2026-08-13T00:00:00.000Z",
        },
        {
          turnId: "00000000-0000-4000-8000-000000000033",
          fileAuthority: { accountId: ACCOUNT_ID, subjectId: SUBJECT_ID },
          providerApi: "responses",
          loadActiveHistory: async () => [
            {
              id: "00000000-0000-4000-8000-000000000034",
              position: 0,
              item: user("measure history"),
              providerArtifactInvalidatedAt: null,
            },
          ],
          onPreparationPhase: (measurement) => {
            phases.push(measurement.phase);
            expect(measurement.outcome).toBe("completed");
            expect(measurement.durationSeconds).toBeGreaterThanOrEqual(0);
            if (measurement.phase === "provider_projection") {
              throw new Error("diagnostic sink unavailable");
            }
          },
        },
      );

      expect(prepared.persistedHistoryCount).toBe(1);
      expect(new Set(phases)).toEqual(
        new Set([
          "system_update_load",
          "current_attachment_resolution",
          "durable_history_load",
          "sandbox_envelope_load",
          "canonical_projection",
          "provider_projection",
          "attachment_ref_projection",
          "screenshot_materialization",
          "model_attachment_projection",
          "runtime_input_assembly",
          "artifact_candidate_scan",
        ]),
      );
    } finally {
      listUpdates.mockRestore();
      getEnvelope.mockRestore();
    }
  });

  test("accepts annotation-only user-message triggers backed by canonical history", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000040";
    const sessionId = "00000000-0000-4000-8000-000000000041";
    const storedUser = user("[OpenGeni timeline annotations]\nAnnotation 1");
    let preparedInput: AgentSegmentInput | undefined;
    const listUpdates = spyOn(opengeniDb, "listSessionSystemUpdatesForTurn").mockResolvedValue([]);
    const getEnvelope = spyOn(opengeniDb, "getSandboxSessionEnvelope").mockResolvedValue(null);
    const runtime = {
      prepareInput: async (_agent: unknown, input: AgentSegmentInput) => {
        preparedInput = input;
        return { input: [], persistedHistoryCount: 1 };
      },
    } as unknown as OpenGeniRuntime;

    try {
      await turnInput(
        {} as Database,
        runtime,
        {},
        {
          id: "00000000-0000-4000-8000-000000000042",
          workspaceId,
          sessionId,
          sequence: 1,
          type: "user.message",
          payload: { text: "", annotations: [{ ordinal: 1 }], resources: [] },
          occurredAt: "2026-08-09T00:00:00.000Z",
        },
        {
          turnId: "00000000-0000-4000-8000-000000000043",
          fileAuthority: { accountId: ACCOUNT_ID, subjectId: SUBJECT_ID },
          providerApi: "responses",
          loadActiveHistory: async () => [
            {
              id: "00000000-0000-4000-8000-000000000044",
              position: 0,
              item: storedUser,
              providerArtifactInvalidatedAt: null,
            },
          ],
        },
      );
      expect(preparedInput?.historyItems).toEqual([storedUser]);
    } finally {
      listUpdates.mockRestore();
      getEnvelope.mockRestore();
    }
  });

  test("keeps sandbox path context and adds object bytes to the model-only user row", async () => {
    const imageBytes = new TextEncoder().encode("image");
    const image = {
      ...file("00000000-0000-4000-8000-000000000050", "image/png", 5, "diagram.png"),
      sha256: sha256(imageBytes),
    };
    const storedUser = user("inspect the diagram");
    let preparedInput: AgentSegmentInput | undefined;
    const getFilesForSubject = spyOn(opengeniDb, "getFilesForSubject").mockResolvedValue([image]);
    const listUpdates = spyOn(opengeniDb, "listSessionSystemUpdatesForTurn").mockResolvedValue([]);
    const getHistory = spyOn(opengeniDb, "getActiveSessionHistoryItemsPaged").mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000054",
        position: 0,
        item: storedUser,
        providerArtifactInvalidatedAt: null,
      },
    ]);
    const getEnvelope = spyOn(opengeniDb, "getSandboxSessionEnvelope").mockResolvedValue(null);
    const runtime = {
      prepareInput: async (_agent: unknown, input: AgentSegmentInput) => {
        preparedInput = input;
        return { input: [], persistedHistoryCount: 1 };
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
        {
          turnId: "00000000-0000-4000-8000-000000000053",
          fileAuthority: { accountId: ACCOUNT_ID, subjectId: SUBJECT_ID },
          providerApi: "responses",
          projectModelHistory: createModelHistoryAttachmentProjector(
            { supportsImageInput: true, inputFileMediaTypes: [] },
            async () => imageBytes,
          ),
        },
      );

      expect(preparedInput).toMatchObject({
        kind: "message",
        internalContext:
          "Attached files are available in the sandbox:\n" +
          `- diagram.png (image/png, 5 bytes): .opengeni/files/${image.id}/diagram.png`,
        historyItems: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "inspect the diagram" },
              {
                type: "input_text",
                text:
                  `[Attachment: diagram.png; fileId=${image.id}; type=image/png; bytes=5; ` +
                  `path=.opengeni/files/${image.id}/diagram.png. If the local path is absent, ` +
                  "call files__files_get_download_url with this fileId and download it with the shell.]",
              },
              { type: "input_image", image: "data:image/png;base64,aW1hZ2U=" },
            ],
          },
        ],
      });
      expect(storedUser).toEqual(user("inspect the diagram"));
      expect(getFilesForSubject).toHaveBeenCalledTimes(1);
    } finally {
      getFilesForSubject.mockRestore();
      listUpdates.mockRestore();
      getHistory.mockRestore();
      getEnvelope.mockRestore();
    }
  });

  test("system-update turns retain historical receipts without reloading bytes", async () => {
    const imageBytes = new TextEncoder().encode("image");
    const image = {
      ...file("00000000-0000-4000-8000-000000000054", "image/png", 5, "update.png"),
      sha256: sha256(imageBytes),
    };
    const storedUser = {
      ...user("inspect the update"),
      [MODEL_ATTACHMENT_REFS_FIELD]: [{ kind: "file", fileId: image.id }],
    };
    let preparedInput: AgentSegmentInput | undefined;
    const listUpdates = spyOn(opengeniDb, "listSessionSystemUpdatesForTurn").mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000055",
        deliveredHistoryItemId: "00000000-0000-4000-8000-000000000056",
      } as never,
    ]);
    const getHistory = spyOn(opengeniDb, "getActiveSessionHistoryItemsPaged").mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000056",
        position: 0,
        item: storedUser,
        providerArtifactInvalidatedAt: null,
      },
    ]);
    const getFilesForSubject = spyOn(opengeniDb, "getFilesForSubject").mockResolvedValue([image]);
    const getEnvelope = spyOn(opengeniDb, "getSandboxSessionEnvelope").mockResolvedValue(null);
    const runtime = {
      prepareInput: async (_agent: unknown, input: AgentSegmentInput) => {
        preparedInput = input;
        return { input: input.historyItems ?? [], persistedHistoryCount: 1 };
      },
    } as unknown as OpenGeniRuntime;

    try {
      await turnInput(
        {} as Database,
        runtime,
        {},
        {
          id: "00000000-0000-4000-8000-000000000057",
          workspaceId: image.workspaceId,
          sessionId: "00000000-0000-4000-8000-000000000058",
          sequence: 2,
          type: "system.update.delivered",
          payload: {},
          occurredAt: "2026-08-04T00:00:00.000Z",
        },
        {
          turnId: "00000000-0000-4000-8000-000000000059",
          fileAuthority: { accountId: ACCOUNT_ID, subjectId: SUBJECT_ID },
          providerApi: "responses",
          projectModelHistory: createModelHistoryAttachmentProjector(
            { supportsImageInput: true, inputFileMediaTypes: [] },
            async () => imageBytes,
          ),
        },
      );

      expect(preparedInput?.historyItems).toEqual([
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "inspect the update" },
            {
              type: "input_text",
              text:
                `[Earlier attachment: fileId=${image.id}; ` +
                `mountDirectory=.opengeni/files/${image.id}. Use the existing file there, or ` +
                "call files__files_get_download_url with this fileId and download it with the shell.]",
            },
          ],
        },
      ]);
      expect(getFilesForSubject).not.toHaveBeenCalled();
      expect(storedUser[MODEL_ATTACHMENT_REFS_FIELD]).toEqual([{ kind: "file", fileId: image.id }]);
    } finally {
      listUpdates.mockRestore();
      getHistory.mockRestore();
      getFilesForSubject.mockRestore();
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
    const getHistory = spyOn(opengeniDb, "getActiveSessionHistoryItemsPaged").mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000064",
        position: 0,
        item: storedUser,
        providerArtifactInvalidatedAt: null,
      },
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
      await turnInput({} as Database, runtime, {}, trigger, {
        turnId: projectedTurnId,
        fileAuthority: { accountId: ACCOUNT_ID, subjectId: SUBJECT_ID },
        recovering: true,
        providerApi: "responses",
      });
      await turnInput({} as Database, runtime, {}, trigger, {
        turnId: laterTurnId,
        fileAuthority: { accountId: ACCOUNT_ID, subjectId: SUBJECT_ID },
        providerApi: "responses",
      });

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
