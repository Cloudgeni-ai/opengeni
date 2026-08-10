import { describe, expect, test } from "bun:test";
import {
  parseEditableArtifactPublicationReceipt,
  projectEditableArtifactPublications,
} from "../src/editable-artifact-publication";
import type { SessionEvent } from "../src/types";

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

  test("projects closed receipts without requiring the tool-call input", () => {
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const first = event(8, workspaceId, { output: receipt });
    const replay = event(12, workspaceId, { output: JSON.stringify(receipt) });
    const unrelated = event(10, workspaceId, { output: "done" });

    expect(projectEditableArtifactPublications([replay, unrelated, first], workspaceId)).toEqual([
      {
        receipt,
        eventId: replay.id,
        sequence: 12,
        occurredAt: replay.occurredAt,
      },
    ]);
  });

  test("rejects errors and receipts routed to another workspace or session", () => {
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const otherWorkspaceId = "33333333-3333-4333-8333-333333333333";
    const sessionId = "44444444-4444-4444-8444-444444444444";
    expect(
      projectEditableArtifactPublications(
        [
          event(1, workspaceId, { output: receipt, error: true }),
          event(2, otherWorkspaceId, { output: receipt }),
          { ...event(3, workspaceId, { output: receipt }), sessionId: crypto.randomUUID() },
        ],
        workspaceId,
        sessionId,
      ),
    ).toEqual([]);
  });
});

function event(sequence: number, workspaceId: string, payload: unknown): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId,
    sessionId: "44444444-4444-4444-8444-444444444444",
    sequence,
    type: "agent.toolCall.output",
    payload,
    occurredAt: `2026-08-10T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}
