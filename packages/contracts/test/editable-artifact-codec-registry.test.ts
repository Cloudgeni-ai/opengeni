import { describe, expect, test } from "bun:test";

import {
  EDITABLE_ARTIFACT_CODEC_REGISTRY,
  editableArtifactCodecFor,
} from "../src/editable-artifact-codec-registry";
import modalityFixture from "./fixtures/editable-artifact-modalities-v1.json";
import spreadsheetFixture from "./fixtures/editable-artifact-spreadsheet-v1.json";

describe("editable artifact codec registry", () => {
  test("selects from durable modality and exact persisted versions", () => {
    for (const modality of ["spreadsheet", "document", "presentation"] as const) {
      const descriptor = editableArtifactCodecFor({
        durableModality: modality,
        modelSchemaVersion: 1,
        commandProtocolVersion: 1,
      });
      expect(descriptor).toBe(EDITABLE_ARTIFACT_CODEC_REGISTRY[modality]);
      expect(descriptor.modality).toBe(modality);
    }
    expect(() =>
      editableArtifactCodecFor({
        durableModality: "document",
        modelSchemaVersion: 2,
        commandProtocolVersion: 1,
      }),
    ).toThrow();
    expect(() =>
      editableArtifactCodecFor({
        durableModality: "document",
        modelSchemaVersion: 1,
        commandProtocolVersion: 2,
      }),
    ).toThrow();
  });

  test("fails closed across modalities", () => {
    const vectors = {
      spreadsheet: Uint8Array.fromHex(spreadsheetFixture.commandHex),
      document: Uint8Array.fromHex(modalityFixture.documentCommandsHex),
      presentation: Uint8Array.fromHex(modalityFixture.presentationCommandsHex),
    } as const;
    for (const modality of Object.keys(vectors) as (keyof typeof vectors)[]) {
      for (const other of Object.keys(vectors) as (keyof typeof vectors)[]) {
        if (modality === other) {
          expect(() =>
            EDITABLE_ARTIFACT_CODEC_REGISTRY[modality].command.assertCanonical(vectors[other]),
          ).not.toThrow();
        } else {
          expect(() =>
            EDITABLE_ARTIFACT_CODEC_REGISTRY[modality].command.assertCanonical(vectors[other]),
          ).toThrow();
        }
      }
    }
  });

  test("does not misrepresent authoritative document/presentation writes as CRDT", () => {
    expect(EDITABLE_ARTIFACT_CODEC_REGISTRY.spreadsheet.concurrency).toEqual({
      semantics: "causal-crdt-v1",
      collaborationEnvelope: "OGACO001",
      staleBaseMustBeRejected: false,
    });
    for (const modality of ["document", "presentation"] as const) {
      expect(EDITABLE_ARTIFACT_CODEC_REGISTRY[modality].concurrency).toEqual({
        semantics: "authoritative-serialized-stale-base-v1",
        collaborationEnvelope: null,
        staleBaseMustBeRejected: true,
      });
    }
  });
});
