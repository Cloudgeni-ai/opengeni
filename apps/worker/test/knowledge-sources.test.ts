import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { KnowledgeFilePreparationResult, ResourceRef } from "@opengeni/contracts";
import {
  prepareTurnKnowledgeSources,
  type KnowledgeSourcePreparationOutcome,
} from "../src/activities/agent-turn/knowledge-sources";

const scope = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  turnId: crypto.randomUUID(),
  attemptId: crypto.randomUUID(),
  executionGeneration: 1,
};
const file = (id = crypto.randomUUID()): ResourceRef => ({ kind: "file", fileId: id });
const result = (fileId: string): KnowledgeFilePreparationResult => ({
  status: "retained",
  fileId,
  filename: "Acme.pdf",
  receipt: {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    version: 1,
    outcome: "pending",
    reviewBatchId: crypto.randomUUID(),
    replayed: false,
  },
});

describe("ordinary task attachment preparation", () => {
  test("prepares each original once and returns nonblocking evidence receipts", async () => {
    const resource = file();
    const ids: string[] = [];
    const events: KnowledgeSourcePreparationOutcome[] = [];
    const note = await prepareTurnKnowledgeSources({
      settings: testSettings(),
      scope,
      resources: [resource, resource],
      learningMode: "review_first",
      prepare: async (id) => {
        ids.push(id);
        return result(id);
      },
      onOutcome: async (outcome) => {
        events.push(outcome);
      },
    });
    expect(ids).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(note).toContain('"outcome":"pending"');
    expect(note).toContain("Pending review does not block");
  });
  test("Off and narrower tool/permission selections do not read or prepare files", async () => {
    for (const override of [
      { learningMode: "off" as const },
      { selectedTools: [] },
      { permissions: [] },
    ]) {
      expect(
        await prepareTurnKnowledgeSources({
          settings: testSettings(),
          scope,
          resources: [file()],
          learningMode: "automatic",
          ...override,
          prepare: async () => {
            throw new Error("Must not read");
          },
          onOutcome: async () => {
            throw new Error("Must not emit");
          },
        }),
      ).toBeUndefined();
    }
  });
  test("a parse failure is visible and does not stop the remaining attachments or chat", async () => {
    const events: KnowledgeSourcePreparationOutcome[] = [];
    let calls = 0;
    const note = await prepareTurnKnowledgeSources({
      settings: testSettings(),
      scope,
      resources: [file(), file()],
      learningMode: "automatic",
      prepare: async (id) => {
        if (++calls === 1) throw new Error("Parser failed");
        return result(id);
      },
      onOutcome: async (outcome) => {
        events.push(outcome);
      },
    });
    expect(events.map((event) => event.status)).toEqual(["failed", "retained"]);
    expect(note).toContain("retryable with knowledge_retain_file");
  });
  test("cancellation is not swallowed as an ordinary parser failure", async () => {
    const controller = new AbortController();
    await expect(
      prepareTurnKnowledgeSources({
        settings: testSettings(),
        scope,
        resources: [file()],
        learningMode: "automatic",
        signal: controller.signal,
        prepare: async () => {
          controller.abort(new Error("Cancelled"));
          throw new Error("Aborted I/O");
        },
        onOutcome: async () => {
          throw new Error("Must not emit");
        },
      }),
    ).rejects.toThrow("Cancelled");
  });
});
