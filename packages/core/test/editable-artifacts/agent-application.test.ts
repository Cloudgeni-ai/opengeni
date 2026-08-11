import { describe, expect, test } from "bun:test";
import {
  encodeSpreadsheetMetadataKernelProjection,
  spreadsheetSheetId,
} from "@opengeni/contracts/editable-artifacts";

import {
  EditableArtifactAgentApplication,
  type EditableArtifactAgentApplicationDependencies,
} from "../../src/domain/editable-artifacts/agent-application";
import type {
  EditableArtifactDurableExportService,
  EditableArtifactMaterializationJob,
  EditableArtifactPinnedVersion,
} from "../../src/domain/editable-artifacts/durable-export";
import {
  editableArtifactClientTransactionId,
  editableArtifactContentHash,
  editableArtifactReplicaId,
  type EditableArtifactActor,
} from "../../src/domain/editable-artifacts/types";
import {
  artifactFixture,
  artifactId,
  initialStateHash,
  scope,
  snapshotRequest,
  stableHex,
  transactionRequest,
} from "./fixtures";

const sessionId = "64f8c722-463d-418e-b586-60f981269bb5";
const agentActor: EditableArtifactActor = Object.freeze({
  kind: "agent",
  subjectId: "worker:first-party-mcp",
  replicaId: editableArtifactReplicaId("aaaabbbbccccdddd"),
  sessionId,
  turnId: "aa9345e2-b40b-4c49-9d68-9a8dd560ae30",
  attemptId: "ee36aa8f-6421-4daf-9442-5157f8616ba0",
  generation: 1,
});

describe("editable artifact agent application", () => {
  test("routes direct commands through the authoritative domain and recovers a lost response", async () => {
    const fixture = await artifactFixture();
    const touched: string[] = [];
    const application = applicationFor(fixture.service, {
      listArtifactIds: async () => [artifactId],
      touch: async ({ artifactId: touchedId }) => {
        touched.push(touchedId);
      },
    });
    const batch = {
      modality: "spreadsheet" as const,
      commands: [
        {
          kind: "sheet.create" as const,
          sheetId: spreadsheetSheetId(stableHex(0x77, 1)),
          name: "Forecast",
          after: null,
        },
      ],
    };
    const clientTransactionId = editableArtifactClientTransactionId("artifact-operation-1");

    const first = await application.apply({
      scope,
      actor: agentActor,
      sessionId,
      artifactId,
      clientTransactionId,
      expectedHeadSequence: 0,
      expectedStateHash: initialStateHash,
      batch,
    });
    const replay = await application.apply({
      scope,
      actor: agentActor,
      sessionId,
      artifactId,
      clientTransactionId,
      expectedHeadSequence: 0,
      expectedStateHash: initialStateHash,
      batch,
    });

    expect(first.transaction).toMatchObject({ replayed: false, sequenceStart: 1, sequenceEnd: 1 });
    expect(replay.transaction).toEqual({ ...first.transaction, replayed: true });
    expect(fixture.kernel.calls).toHaveLength(1);
    expect(touched).toEqual([artifactId, artifactId]);

    await expect(
      application.apply({
        scope,
        actor: agentActor,
        sessionId,
        artifactId,
        clientTransactionId,
        expectedHeadSequence: 0,
        expectedStateHash: initialStateHash,
        batch: {
          ...batch,
          commands: [{ ...batch.commands[0]!, name: "Different" }],
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(fixture.kernel.calls).toHaveLength(1);

    await expect(
      application.apply({
        scope,
        actor: agentActor,
        sessionId,
        artifactId,
        clientTransactionId,
        expectedHeadSequence: 0,
        expectedStateHash: `sha256:${"f".repeat(64)}`,
        batch,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(fixture.kernel.calls).toHaveLength(1);

    const competingActor: EditableArtifactActor = {
      kind: "human",
      subjectId: "human:competing",
      replicaId: editableArtifactReplicaId("1111222233334444"),
    };
    const beforeCompetingEdit = await fixture.service.getArtifact({
      scope,
      actor: competingActor,
      artifactId,
    });
    const competingRequest = await transactionRequest(fixture.service, {
      actor: competingActor,
      observedHeadSequence: beforeCompetingEdit.headSequence,
      causalBase: beforeCompetingEdit.causalFrontier,
      clientTransactionId: editableArtifactClientTransactionId("competing-after-replay"),
    });
    await fixture.service.applyTransaction({
      scope,
      actor: competingActor,
      artifactId,
      request: {
        intentBytes: competingRequest.intentBytes,
        requestHash: competingRequest.requestHash,
        expectedHead: {
          sequence: beforeCompetingEdit.headSequence,
          stateHash: beforeCompetingEdit.stateHash,
        },
      },
    });
    const current = await fixture.service.getArtifact({
      scope,
      actor: agentActor,
      artifactId,
    });
    await expect(
      application.apply({
        scope,
        actor: agentActor,
        sessionId,
        artifactId,
        clientTransactionId,
        expectedHeadSequence: current.headSequence,
        expectedStateHash: current.stateHash,
        batch,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(fixture.kernel.calls).toHaveLength(2);
  });

  test("rejects an edit when the inspected head changed", async () => {
    const fixture = await artifactFixture();
    const competingActor: EditableArtifactActor = {
      kind: "human",
      subjectId: "human:competing",
      replicaId: editableArtifactReplicaId("1111222233334444"),
    };
    const application = applicationFor(fixture.service, {
      listArtifactIds: async () => [],
      touch: async () => undefined,
    });
    const competing = await fixture.service.applyTransaction({
      scope,
      actor: competingActor,
      artifactId,
      request: await transactionRequest(fixture.service, {
        actor: competingActor,
        clientTransactionId: editableArtifactClientTransactionId("competing-edit"),
      }),
    });
    expect(competing.receipt.sequenceEnd).toBe(1);

    await expect(
      application.apply({
        scope,
        actor: agentActor,
        sessionId,
        artifactId,
        clientTransactionId: editableArtifactClientTransactionId("stale-agent-edit"),
        expectedHeadSequence: 0,
        expectedStateHash: initialStateHash,
        batch: {
          modality: "spreadsheet",
          commands: [
            {
              kind: "sheet.create",
              sheetId: spreadsheetSheetId(stableHex(0x77, 2)),
              name: "Stale",
              after: null,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "stale_base" });
  });

  test("lists only session-linked artifacts and rejects an unbound agent context", async () => {
    const fixture = await artifactFixture();
    const application = applicationFor(fixture.service, {
      listArtifactIds: async ({ sessionId: listedSessionId }) => {
        expect(listedSessionId).toBe(sessionId);
        return [artifactId];
      },
      touch: async () => undefined,
    });

    await expect(application.list({ scope, actor: agentActor, sessionId })).resolves.toMatchObject([
      { id: artifactId, title: "Budget", modality: "spreadsheet" },
    ]);
    await expect(
      application.list({
        scope,
        actor: { ...agentActor, sessionId: crypto.randomUUID() },
        sessionId,
      }),
    ).rejects.toThrow("not bound to its attempt session");
  });

  test("creates, imports, gets, and inspects through one shared application boundary", async () => {
    const fixture = await artifactFixture({ seed: false });
    const touched: string[] = [];
    const generatedSnapshot = snapshotRequest({
      coveredHeadSequence: 0,
      coveredCausalFrontier: [],
      stateHash: initialStateHash,
    });
    const {
      snapshotId: _snapshotId,
      verifiedAt: _verifiedAt,
      ...importSnapshot
    } = generatedSnapshot;
    const application = new EditableArtifactAgentApplication({
      domain: fixture.service,
      associations: {
        listArtifactIds: async () => [],
        touch: async ({ artifactId: touchedId }) => {
          touched.push(touchedId);
        },
      },
      exports: {} as EditableArtifactDurableExportService,
      officeImports: {
        prepare: async ({ fileId, modality }) => {
          expect(fileId).toBe("60000000-0000-4000-8000-000000000006");
          expect(modality).toBe("spreadsheet");
          return {
            originalImport: {
              fileId,
              blobReference: "blob:original",
              byteSize: 100,
              contentHash: editableArtifactContentHash(`sha256:${"a".repeat(64)}`),
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
            snapshot: importSnapshot,
          };
        },
      },
      inspector: {
        query: async () =>
          encodeSpreadsheetMetadataKernelProjection({
            revision: 0n,
            modeledFeatures: { dimensions: false, hidden: false, merges: false },
            sheets: [],
          }),
      },
      workspaceFiles: {
        ensureMaterializationFile: async () => Promise.reject(new Error("unused")),
      },
    });

    const created = await application.create({
      scope,
      actor: agentActor,
      sessionId,
      idempotencyKey: editableArtifactClientTransactionId("create-through-agent"),
      modality: "document",
      title: "Plan",
    });
    const imported = await application.import({
      scope,
      actor: agentActor,
      sessionId,
      idempotencyKey: editableArtifactClientTransactionId("import-through-agent"),
      fileId: "60000000-0000-4000-8000-000000000006",
      modality: "spreadsheet",
      title: "Forecast",
    });
    await expect(
      application.get({
        scope,
        actor: agentActor,
        sessionId,
        artifactId: imported.id as never,
      }),
    ).resolves.toEqual(imported);
    await expect(
      application.inspect({
        scope,
        actor: agentActor,
        sessionId,
        artifactId: imported.id as never,
        request: {
          modality: "spreadsheet",
          query: { kind: "workbook-metadata", query: { maxSheets: 10, maxBytes: 4096 } },
        },
      }),
    ).resolves.toMatchObject({
      artifact: imported,
      projection: { kind: "workbook-metadata", projection: { sheets: [] } },
    });

    expect(created).toMatchObject({ modality: "document", title: "Plan" });
    expect(imported).toMatchObject({ modality: "spreadsheet", title: "Forecast" });
    expect(touched).toEqual([created.id, imported.id, imported.id, imported.id]);
  });

  test("pins one immutable head, materializes it, and promotes the result as a workspace file", async () => {
    const fixture = await artifactFixture();
    const versionId = stableHex(0x88, 1);
    const jobId = stableHex(0x88, 2);
    const resultId = stableHex(0x88, 3);
    const now = "2026-08-10T12:00:00.000Z";
    const version: EditableArtifactPinnedVersion = Object.freeze({
      scope,
      artifactId,
      id: versionId,
      modality: "spreadsheet",
      snapshotId: stableHex(0x88, 4),
      headSequence: 0,
      causalFrontier: [],
      nativeRevision: null,
      stateHash: initialStateHash,
      name: "Export Budget",
      pinned: true,
      createdBySubjectId: agentActor.subjectId,
      createdAt: now,
    });
    const pendingJob: EditableArtifactMaterializationJob = Object.freeze({
      scope,
      artifactId,
      id: jobId,
      versionId,
      inputSnapshotId: version.snapshotId,
      targetHeadSequence: version.headSequence,
      stateHash: version.stateHash,
      format: "xlsx",
      state: "pending",
      attemptCount: 0,
      errorCode: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      result: null,
    });
    const succeededJob: EditableArtifactMaterializationJob = Object.freeze({
      ...pendingJob,
      state: "succeeded",
      attemptCount: 1,
      startedAt: now,
      completedAt: now,
      result: Object.freeze({
        id: resultId,
        byteSize: 123,
        contentHash: editableArtifactContentHash(`sha256:${"b".repeat(64)}`),
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        verifiedAt: now,
        createdAt: now,
      }),
    });
    const pinCalls: Array<Parameters<EditableArtifactDurableExportService["pinVersion"]>[0]> = [];
    const enqueueCalls: Array<
      Parameters<EditableArtifactDurableExportService["enqueueMaterialization"]>[0]
    > = [];
    const statusCalls: Array<
      Parameters<EditableArtifactDurableExportService["getMaterialization"]>[0]
    > = [];
    const fileCalls: Array<
      Parameters<
        EditableArtifactAgentApplicationDependencies["workspaceFiles"]["ensureMaterializationFile"]
      >[0]
    > = [];
    const touched: string[] = [];
    const exports = {
      async pinVersion(input: (typeof pinCalls)[number]) {
        pinCalls.push(input);
        return { version, replayed: false };
      },
      async enqueueMaterialization(input: (typeof enqueueCalls)[number]) {
        enqueueCalls.push(input);
        return { job: pendingJob, replayed: false };
      },
      async getMaterialization(input: (typeof statusCalls)[number]) {
        statusCalls.push(input);
        return succeededJob;
      },
    } as unknown as EditableArtifactDurableExportService;
    const application = new EditableArtifactAgentApplication({
      domain: fixture.service,
      exports,
      associations: {
        listArtifactIds: async () => [],
        touch: async ({ artifactId: touchedId }) => {
          touched.push(touchedId);
        },
      },
      inspector: { query: async () => Promise.reject(new Error("unused")) },
      officeImports: { prepare: async () => Promise.reject(new Error("unused")) },
      workspaceFiles: {
        async ensureMaterializationFile(input) {
          fileCalls.push(input);
          return Object.freeze({
            fileId: "60000000-0000-4000-8000-000000000006",
            filename: input.filename,
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            sizeBytes: 123,
            sha256: "b".repeat(64),
            artifactId: input.artifact.id,
            versionId: input.versionId,
            materializationJobId: input.jobId,
            sourceHeadSequence: input.sourceHeadSequence,
            sourceStateHash: input.sourceStateHash,
          });
        },
      },
    });

    const started = await application.startExport({
      scope,
      actor: agentActor,
      sessionId,
      artifactId,
      idempotencyKey: "deliver-budget-xlsx",
      format: "xlsx",
      options: Object.freeze({ includeFormulas: true }),
    });
    expect(started).toMatchObject({
      artifact: { id: artifactId, title: "Budget" },
      versionId,
      jobId,
      sourceHeadSequence: 0,
      sourceStateHash: initialStateHash,
      state: "pending",
    });
    expect(pinCalls).toHaveLength(1);
    expect(enqueueCalls).toHaveLength(1);
    expect(pinCalls[0]!.idempotencyKey).not.toBe(enqueueCalls[0]!.idempotencyKey);
    expect(enqueueCalls[0]).toMatchObject({
      artifactId,
      versionId,
      format: "xlsx",
      options: { includeFormulas: true },
    });

    const completed = await application.exportStatus({
      scope,
      actor: agentActor,
      sessionId,
      artifactId,
      versionId,
      jobId,
    });
    expect(completed).toMatchObject({
      versionId,
      jobId,
      state: "succeeded",
      file: {
        fileId: "60000000-0000-4000-8000-000000000006",
        filename: "Budget.xlsx",
        artifactId,
        versionId,
        materializationJobId: jobId,
        sourceHeadSequence: 0,
        sourceStateHash: initialStateHash,
      },
    });
    expect(statusCalls).toHaveLength(1);
    expect(fileCalls).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({ id: artifactId, title: "Budget" }),
        versionId,
        jobId,
        filename: "Budget.xlsx",
        sourceHeadSequence: 0,
        sourceStateHash: initialStateHash,
      }),
    ]);
    expect(touched).toEqual([artifactId, artifactId]);
  });

  test("does not create a workspace file for a mismatched export version", async () => {
    const fixture = await artifactFixture();
    let fileCalls = 0;
    const job = Object.freeze({
      scope,
      artifactId,
      id: stableHex(0x89, 1),
      versionId: stableHex(0x89, 2),
      inputSnapshotId: stableHex(0x89, 3),
      targetHeadSequence: 0,
      stateHash: initialStateHash,
      format: "xlsx" as const,
      state: "succeeded" as const,
      attemptCount: 1,
      errorCode: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      startedAt: "2026-08-10T12:00:00.000Z",
      completedAt: "2026-08-10T12:00:00.000Z",
      result: Object.freeze({
        id: stableHex(0x89, 4),
        byteSize: 123,
        contentHash: editableArtifactContentHash(`sha256:${"c".repeat(64)}`),
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const,
        verifiedAt: "2026-08-10T12:00:00.000Z",
        createdAt: "2026-08-10T12:00:00.000Z",
      }),
    }) satisfies EditableArtifactMaterializationJob;
    const application = new EditableArtifactAgentApplication({
      domain: fixture.service,
      exports: {
        async getMaterialization() {
          return job;
        },
      } as unknown as EditableArtifactDurableExportService,
      associations: { listArtifactIds: async () => [], touch: async () => undefined },
      inspector: { query: async () => Promise.reject(new Error("unused")) },
      officeImports: { prepare: async () => Promise.reject(new Error("unused")) },
      workspaceFiles: {
        async ensureMaterializationFile() {
          fileCalls += 1;
          throw new Error("must not create a file");
        },
      },
    });

    await expect(
      application.exportStatus({
        scope,
        actor: agentActor,
        sessionId,
        artifactId,
        versionId: stableHex(0x89, 5),
        jobId: job.id,
      }),
    ).rejects.toThrow("Export version mismatch");
    expect(fileCalls).toBe(0);
  });
});

function applicationFor(
  domain: EditableArtifactAgentApplicationDependencies["domain"],
  associations: EditableArtifactAgentApplicationDependencies["associations"],
): EditableArtifactAgentApplication {
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected test dependency call");
  };
  return new EditableArtifactAgentApplication({
    domain,
    associations,
    exports: {} as EditableArtifactDurableExportService,
    inspector: { query: unavailable },
    officeImports: { prepare: unavailable },
    workspaceFiles: { ensureMaterializationFile: unavailable },
  });
}
