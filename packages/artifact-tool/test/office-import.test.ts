import { describe, expect, test } from "bun:test";
import { encodeEditableArtifactCausalFrontier } from "@opengeni/contracts/editable-artifact-causal-frontier";
import {
  COMMITTED_TRANSACTION_PROTOCOL_VERSION,
  DOCUMENT_ARTIFACT_MODEL_SCHEMA_VERSION,
  DOCUMENT_ARTIFACT_SNAPSHOT_VERSION,
  PRESENTATION_ARTIFACT_MODEL_SCHEMA_VERSION,
  PRESENTATION_ARTIFACT_SNAPSHOT_VERSION,
  SPREADSHEET_ARTIFACT_MODEL_SCHEMA_VERSION,
  SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION,
} from "@opengeni/contracts/editable-artifact-versions";
import { prepareArtifactOfficeImport, type ArtifactOfficeModality } from "../src/office-import";

const runtimeTarget = "test-runtime";
const kernelVersion = "test-kernel";
const sourceBytes = Uint8Array.of(1, 2, 3);
const snapshotBytes = Uint8Array.of(4, 5, 6);
const stateHash = `sha256:${"a".repeat(64)}`;

describe("verified Office import snapshot boundary", () => {
  test.each([
    {
      modality: "spreadsheet" as const,
      filename: "forecast.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const,
      modelSchemaVersion: SPREADSHEET_ARTIFACT_MODEL_SCHEMA_VERSION,
      snapshotVersion: SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION,
    },
    {
      modality: "document" as const,
      filename: "brief.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const,
      modelSchemaVersion: DOCUMENT_ARTIFACT_MODEL_SCHEMA_VERSION,
      snapshotVersion: DOCUMENT_ARTIFACT_SNAPSHOT_VERSION,
    },
    {
      modality: "presentation" as const,
      filename: "deck.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" as const,
      modelSchemaVersion: PRESENTATION_ARTIFACT_MODEL_SCHEMA_VERSION,
      snapshotVersion: PRESENTATION_ARTIFACT_SNAPSHOT_VERSION,
    },
  ])("accepts only the current $modality snapshot tuple", async (fixture) => {
    const disposed: unknown[] = [];
    const result = await prepareArtifactOfficeImport({
      facade: facade(
        fixture.modality,
        fixture.modelSchemaVersion,
        fixture.snapshotVersion,
        disposed,
      ),
      modality: fixture.modality,
      filename: fixture.filename,
      mimeType: fixture.mimeType,
      bytes: sourceBytes,
      expectedRuntimeTarget: runtimeTarget,
      expectedKernelVersion: kernelVersion,
    });

    expect(result.snapshot).toMatchObject({
      modality: fixture.modality,
      modelSchemaVersion: fixture.modelSchemaVersion,
      kernelVersion,
      stateHash,
    });
    expect(result.snapshot.bytes).toEqual(snapshotBytes);
    expect(disposed).toHaveLength(1);
  });

  test("rejects the removed spreadsheet tuple and still disposes the imported artifact", async () => {
    const disposed: unknown[] = [];
    await expect(
      prepareArtifactOfficeImport({
        facade: facade("spreadsheet", 1, 1, disposed),
        modality: "spreadsheet",
        filename: "forecast.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: sourceBytes,
        expectedRuntimeTarget: runtimeTarget,
        expectedKernelVersion: kernelVersion,
      }),
    ).rejects.toThrow("differs from the verified native runtime boundary");
    expect(disposed).toHaveLength(1);
  });
});

function facade(
  modality: ArtifactOfficeModality,
  modelSchemaVersion: number,
  snapshotVersion: number,
  disposed: unknown[],
) {
  const artifact = Object.freeze({ modality });
  const importer = async () => artifact;
  return {
    FileBlob: { fromBytes: () => Object.freeze({}) },
    SpreadsheetFile: { importXlsx: importer },
    DocumentFile: { importDocx: importer },
    PresentationFile: { importPptx: importer },
    createArtifactSnapshot: () => ({
      schemaVersion: 1,
      modality,
      runtimeTarget,
      kernelVersion,
      stateHash,
      snapshotBytes,
      modelSchemaVersion,
      snapshotVersion,
      ...(modality === "spreadsheet"
        ? {
            coveredCausalFrontierBytes: encodeEditableArtifactCausalFrontier([]),
            operationProtocolVersion: COMMITTED_TRANSACTION_PROTOCOL_VERSION,
            crdtStateVersion: SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION,
          }
        : { nativeRevision: 0 }),
    }),
    disposeArtifact: (value: unknown) => disposed.push(value),
  };
}
