import { describe, expect, test } from "bun:test";
import type {
  ComposerDraft,
  SessionComposerRuntimeStore,
  TurnQueueStore,
} from "@opengeni/sdk/session";
import { editQueuedTurnIntoComposer } from "../src/queue-edit";

function harness(hasDraftContent: boolean, restored: ComposerDraft | null = draft()) {
  const edits: unknown[] = [];
  const applied: ComposerDraft[] = [];
  const queue = {
    editTurn: async (turnId: string, options: unknown) => {
      edits.push({ turnId, options });
      return restored;
    },
  } as unknown as TurnQueueStore;
  const composer = {
    hasDraftContent: () => hasDraftContent,
    getSnapshot: () => ({ draftRevision: 7 }),
    applyDraft: (value: ComposerDraft) => applied.push(value),
  } as unknown as SessionComposerRuntimeStore;
  return { queue, composer, edits, applied };
}

describe("native Svelte queue edit checkout", () => {
  test("checks out directly when the composer is empty", async () => {
    const state = harness(false);
    let confirmations = 0;
    expect(
      await editQueuedTurnIntoComposer({
        ...state,
        turnId: "turn-1",
        confirmReplace: () => {
          confirmations += 1;
          return true;
        },
      }),
    ).toBe(true);
    expect(confirmations).toBe(0);
    expect(state.edits).toEqual([
      {
        turnId: "turn-1",
        options: { expectedDraftRevision: 7, replaceDraft: false },
      },
    ]);
    expect(state.applied).toHaveLength(1);
  });

  test("preserves an existing draft when replacement is declined", async () => {
    const state = harness(true);
    expect(
      await editQueuedTurnIntoComposer({
        ...state,
        turnId: "turn-1",
        confirmReplace: () => false,
      }),
    ).toBe(false);
    expect(state.edits).toEqual([]);
    expect(state.applied).toEqual([]);
  });

  test("uses the current draft revision when replacement is confirmed", async () => {
    const state = harness(true);
    expect(
      await editQueuedTurnIntoComposer({
        ...state,
        turnId: "turn-1",
        confirmReplace: async () => true,
      }),
    ).toBe(true);
    expect(state.edits).toEqual([
      {
        turnId: "turn-1",
        options: { expectedDraftRevision: 7, replaceDraft: true },
      },
    ]);
    expect(state.applied).toHaveLength(1);
  });
});

function draft(): ComposerDraft {
  return { revision: 8, text: "queued prompt" } as ComposerDraft;
}
