import { describe, expect, test } from "bun:test";
import {
  PreparedEditableArtifactPublicationSchema,
  PublishEditableArtifactReceiptSchema,
  PublishEditableArtifactToolInput,
} from "../src/editable-artifact-publication";

const artifactId = "a".repeat(32);

describe("editable artifact publication contracts", () => {
  test("accepts one closed tool request and durable receipt", () => {
    expect(
      PublishEditableArtifactToolInput.parse({
        path: "/workspace/final.docx",
        title: "Final report",
        modality: "document",
      }),
    ).toEqual({
      path: "/workspace/final.docx",
      title: "Final report",
      modality: "document",
    });
    expect(
      PublishEditableArtifactReceiptSchema.parse({
        type: "editable_artifact",
        schemaVersion: 1,
        artifact: { id: artifactId, modality: "document", title: "Final report" },
        sourceFile: {
          id: "11111111-1111-4111-8111-111111111111",
          filename: "final.docx",
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 42,
          sha256: "b".repeat(64),
        },
        editorPath: `/workspaces/22222222-2222-4222-8222-222222222222/artifacts/editable/${artifactId}`,
      }).artifact.id,
    ).toBe(artifactId);
    expect(
      PublishEditableArtifactToolInput.safeParse({
        path: "/workspace/final.docx",
        title: "\ud800",
        modality: "document",
      }).success,
    ).toBe(false);
  });

  test("rejects mismatched paths, source formats, snapshots, and unsorted frontiers", () => {
    expect(
      PublishEditableArtifactReceiptSchema.safeParse({
        type: "editable_artifact",
        schemaVersion: 1,
        artifact: { id: artifactId, modality: "document", title: "Final report" },
        sourceFile: {
          id: "11111111-1111-4111-8111-111111111111",
          filename: "final.docx",
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 42,
          sha256: "b".repeat(64),
        },
        editorPath: `/workspaces/22222222-2222-4222-8222-222222222222/artifacts/editable/${"c".repeat(32)}`,
      }).success,
    ).toBe(false);

    const prepared = {
      schemaVersion: 1,
      modality: "spreadsheet",
      source: {
        byteSize: 42,
        contentHash: `sha256:${"a".repeat(64)}`,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      snapshot: {
        modality: "spreadsheet",
        byteSize: 64,
        contentHash: `sha256:${"b".repeat(64)}`,
        mimeType: "application/vnd.opengeni.editable-artifact-snapshot",
        coveredHeadSequence: 0,
        stateHash: `sha256:${"c".repeat(64)}`,
        modelSchemaVersion: 1,
        kernelVersion: "kernel-1",
        coveredCausalFrontier: [
          { replicaId: "bbbbbbbbbbbbbbbb", counter: 1 },
          { replicaId: "aaaaaaaaaaaaaaaa", counter: 2 },
        ],
        operationProtocolVersion: 1,
        crdtStateVersion: 1,
      },
    };
    expect(PreparedEditableArtifactPublicationSchema.safeParse(prepared).success).toBe(false);
    expect(
      PreparedEditableArtifactPublicationSchema.safeParse({
        ...prepared,
        modality: "document",
      }).success,
    ).toBe(false);
    expect(
      PublishEditableArtifactReceiptSchema.safeParse({
        type: "editable_artifact",
        schemaVersion: 1,
        artifact: { id: artifactId, modality: "document", title: "Final report" },
        sourceFile: {
          id: "11111111-1111-4111-8111-111111111111",
          filename: "final.xlsx",
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sizeBytes: 42,
          sha256: "b".repeat(64),
        },
        editorPath: `/workspaces/22222222-2222-4222-8222-222222222222/artifacts/editable/${artifactId}`,
      }).success,
    ).toBe(false);
  });
});
