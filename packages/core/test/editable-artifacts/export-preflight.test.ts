import { describe, expect, test } from "bun:test";
import { EditableArtifactAgentApplication } from "../../src/domain/editable-artifacts/agent-application";
import {
  EditableArtifactDurableExportService,
  type EditableArtifactDurableExportServiceDependencies,
  type EditableArtifactMaterializationFormat,
} from "../../src/domain/editable-artifacts/durable-export";

const scope = { accountId: "acct-a", workspaceId: "workspace-a" };
const artifactId = "00000000000000010000000000000001";
const actor = {
  kind: "agent",
  subjectId: "worker:test",
  replicaId: "aaaabbbbccccdddd",
  sessionId: "64f8c722-463d-418e-b586-60f981269bb5",
  turnId: "aa9345e2-b40b-4c49-9d68-9a8dd560ae30",
  attemptId: "ee36aa8f-6421-4daf-9442-5157f8616ba0",
  generation: 1,
} as const;

function scenario(
  modality: "spreadsheet" | "document",
  format: EditableArtifactMaterializationFormat,
) {
  const calls = { snapshots: 0, pins: 0, enqueues: 0, ids: 0, touches: 0 };
  const snapshot = { scope, artifactId, modality, snapshotId: "00000000000000090000000000000001" };
  const version = {
    scope,
    artifactId,
    modality,
    id: "00000000000000090000000000000002",
    snapshotId: snapshot.snapshotId,
    headSequence: 7,
    stateHash: `sha256:${"1".repeat(64)}`,
    name: "Export Test",
    pinned: true,
    createdBySubjectId: actor.subjectId,
    createdAt: "2026-09-30T10:17:00.000Z",
  };
  const service = new EditableArtifactDurableExportService({
    authorization: { authorize: async () => ({ allowed: true, revision: 1 }) },
    exactSnapshots: {
      async ensure() {
        calls.snapshots++;
        return snapshot;
      },
    },
    ids: {
      next() {
        calls.ids++;
        return "00000000000000090000000000000005";
      },
    },
    store: {
      async pinVersion() {
        calls.pins++;
        return { kind: "result", version, replayed: false };
      },
      async readVersion() {
        return { kind: "result", version };
      },
      async enqueueMaterialization() {
        calls.enqueues++;
        return {
          kind: "result",
          job: {
            id: "00000000000000090000000000000003",
            state: "pending",
            targetHeadSequence: 7,
            stateHash: version.stateHash,
          },
          replayed: false,
        };
      },
    },
    profiles: {
      supportedFormats: {
        spreadsheet: modality === "spreadsheet" ? [format] : [],
        document: modality === "document" ? [format] : [],
        presentation: [],
      },
      async resolve(input) {
        if (
          input.modality !== modality ||
          input.format !== format ||
          Object.keys(input.options).length
        )
          return null;
        return {
          modality,
          format,
          codecId: `custom.${format}`,
          codecVersion: "1",
          kernelVersion: "artifact-kernel/test",
          fontRegistryHash: `sha256:${"4".repeat(64)}`,
          policyHash: `sha256:${"5".repeat(64)}`,
          normalizedOptions: "{}",
        };
      },
    },
    materializationObjects: {
      open: async () => {
        throw new Error("must not read");
      },
    },
  } as EditableArtifactDurableExportServiceDependencies);
  const application = new EditableArtifactAgentApplication({
    domain: {
      getArtifact: async () => ({
        id: artifactId,
        scope,
        modality,
        title: "Test",
        lifecycle: "active",
        headSequence: 7,
        stateHash: version.stateHash,
        createdAt: version.createdAt,
        updatedAt: version.createdAt,
      }),
    } as never,
    exports: service,
    associations: {
      listArtifactIds: async () => [],
      touch: async () => {
        calls.touches++;
      },
    },
    inspector: {} as never,
    officeImports: {} as never,
    workspaceFiles: {} as never,
  });
  return { calls, application };
}

describe("configured export preflight", () => {
  test("unsupported formats and XLSX options make zero snapshots, pins or store writes", async () => {
    for (const request of [
      { format: "pdf" as const },
      { format: "xlsx" as const, options: { sheetId: "one" } },
    ]) {
      const { application, calls } = scenario("spreadsheet", "xlsx");
      await expect(
        application.startExport({
          scope,
          actor,
          sessionId: actor.sessionId,
          artifactId,
          idempotencyKey: "refused",
          ...request,
        }),
      ).rejects.toMatchObject({ code: "unsupported_format" });
      expect(calls).toEqual({ snapshots: 0, pins: 0, enqueues: 0, ids: 0, touches: 0 });
      expect(application.describeExportFormats()).toContain("spreadsheet → xlsx");
    }
  });
  test("custom DOCX exporter works through the agent and supplies its own guidance", async () => {
    const { application, calls } = scenario("document", "docx");
    expect(application.describeExportFormats()).toContain("document → docx");
    expect(application.describeExportFormats()).not.toContain("document artifacts cannot");
    await application.startExport({
      scope,
      actor,
      sessionId: actor.sessionId,
      artifactId,
      idempotencyKey: "custom",
      format: "docx",
    });
    expect(calls.snapshots).toBe(1);
    expect(calls.pins).toBe(1);
    expect(calls.enqueues).toBe(1);
  });
});
