import { describe, expect, test } from "bun:test";

import {
  SPREADSHEET_ARTIFACT_COMMAND_VERSION,
  DOCUMENT_ARTIFACT_COMMAND_VERSION,
  PRESENTATION_ARTIFACT_COMMAND_VERSION,
  editableArtifactStableId,
  spreadsheetSheetId,
  type SpreadsheetArtifactCommandBatch,
  type SpreadsheetCellInput,
  type SpreadsheetSheetGeneration,
  type ApplySerializedArtifactCommandsOptions,
  type DocumentArtifactCommandBatch,
  type EditableArtifactModality,
  type EditableArtifactSerializedPendingTransaction,
  type EditableArtifactSpreadsheetPendingTransaction,
  type EditableDocumentQuery,
  type EditablePresentationQuery,
  type EditablePresentationEditorSlideQuery,
  type EditablePresentationSlideCatalogQuery,
  type PresentationArtifactEditorSceneNode,
  type PresentationArtifactCommandBatch,
} from "../../src/editable-artifacts";

describe("editable artifact public exports", () => {
  test("exposes exact spreadsheet command construction without a contracts import", () => {
    const sheetId = spreadsheetSheetId("0123456789abcdef0123456789abcdef");
    const generation: SpreadsheetSheetGeneration = {
      kind: "generation",
      sheetId,
      creationOperationId: editableArtifactStableId("fedcba9876543210fedcba9876543210"),
    };
    const cell: SpreadsheetCellInput = "Ready";
    const batch: SpreadsheetArtifactCommandBatch = {
      version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
      commands: [
        {
          kind: "cells.set",
          sheet: generation,
          anchor: { row: 0, column: 0 },
          rows: 1,
          columns: 1,
          cells: [cell],
        },
      ],
    };

    expect(batch.version).toBe(1);
    expect(batch.commands).toHaveLength(1);
  });

  test("exposes durable modality unions and native command/query facades", () => {
    const modality: EditableArtifactModality = "document";
    const options: ApplySerializedArtifactCommandsOptions = { clientTransactionId: "retry.1" };
    const document: DocumentArtifactCommandBatch = {
      version: DOCUMENT_ARTIFACT_COMMAND_VERSION,
      commands: [],
    };
    const presentation: PresentationArtifactCommandBatch = {
      version: PRESENTATION_ARTIFACT_COMMAND_VERSION,
      commands: [],
    };
    const documentQuery: EditableDocumentQuery = { kind: "summary" };
    const presentationQuery: EditablePresentationQuery = { kind: "metadata", maxBytes: 4_096 };
    const catalogQuery: EditablePresentationSlideCatalogQuery = {
      kind: "slide-catalog",
      startSlide: 0,
      maxSlides: 64,
      maxTextBytes: 64 * 1024,
      maxBytes: 1024 * 1024,
    };
    const editorQuery: EditablePresentationEditorSlideQuery = {
      kind: "editor-slide",
      slideId: "0123456789abcdef0000000000000003",
      maxNodes: 1024,
      maxTextBytes: 1024 * 1024,
      maxBytes: 8 * 1024 * 1024,
    };
    const editorNode: PresentationArtifactEditorSceneNode | null = null;
    const pendingKinds: readonly [
      EditableArtifactSpreadsheetPendingTransaction["modality"],
      EditableArtifactSerializedPendingTransaction["modality"],
    ] = ["spreadsheet", "presentation"];

    expect({
      modality,
      options,
      document,
      presentation,
      documentQuery,
      presentationQuery,
      catalogQuery,
      editorQuery,
      editorNode,
    }).toBeDefined();
    expect(pendingKinds).toEqual(["spreadsheet", "presentation"]);
  });
});
