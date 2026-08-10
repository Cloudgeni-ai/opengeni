import { describe, expect, test } from "bun:test";
import { parseEditableArtifactPublicationReceipt } from "../src/editable-artifact-publication";

const artifactId = "a".repeat(32);
const receipt = {
  type: "editable_artifact" as const,
  schemaVersion: 1 as const,
  artifact: { id: artifactId, modality: "presentation" as const, title: "Launch deck" },
  sourceFile: {
    id: "11111111-1111-4111-8111-111111111111",
    filename: "launch.pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" as const,
    sizeBytes: 8_192,
    sha256: "b".repeat(64),
  },
  editorPath: `/workspaces/22222222-2222-4222-8222-222222222222/artifacts/editable/${artifactId}`,
};

describe("parseEditableArtifactPublicationReceipt", () => {
  test("parses object and serialized receipts", () => {
    expect(parseEditableArtifactPublicationReceipt(receipt)).toEqual(receipt);
    expect(parseEditableArtifactPublicationReceipt(JSON.stringify(receipt))).toEqual(receipt);
  });

  test("fails closed for mismatched artifact routes", () => {
    expect(
      parseEditableArtifactPublicationReceipt({
        ...receipt,
        editorPath: `/workspaces/22222222-2222-4222-8222-222222222222/artifacts/editable/${"c".repeat(32)}`,
      }),
    ).toBeNull();
  });
});
