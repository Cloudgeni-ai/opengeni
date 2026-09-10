import { describe, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { prepareRunInput, type OpenGeniRuntime } from "@opengeni/runtime";
import { turnInput } from "../src/activities/run-input";

describe("turn input update batches", () => {
  for (const triggerType of [
    "user.message",
    "system.update.delivered",
    "user.approvalDecision",
    "user.humanInputResponse",
  ] as const) {
    test(`${triggerType} accepts multiple batches without rebuilding or reordering loaded history`, async () => {
      const workspaceId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const firstBatchId = crypto.randomUUID();
      const secondBatchId = crypto.randomUUID();
      const history = [
        { type: "message", role: "user", content: "Continue the task" },
        { type: "message", role: "system", content: "First delivered batch" },
        { type: "function_call", callId: "decision", name: "approval", arguments: "{}" },
        { type: "function_call_result", callId: "decision", name: "approval", output: "approved" },
        { type: "message", role: "system", content: "Second delivered batch" },
      ];
      const updates = spyOn(db, "listSessionSystemUpdatesForTurn").mockResolvedValue([
        // Retrieval order is not model-history order. Multiple updates can
        // share a batch, and a resumed attempt can append a distinct batch.
        { deliveredHistoryItemId: secondBatchId } as never,
        { deliveredHistoryItemId: firstBatchId } as never,
        { deliveredHistoryItemId: firstBatchId } as never,
      ]);
      const loadHistory = spyOn(db, "getActiveSessionHistoryItemsPaged").mockResolvedValue(
        history.map((item, position) => ({
          id: position === 1 ? firstBatchId : position === 4 ? secondBatchId : crypto.randomUUID(),
          position,
          item,
          providerArtifactInvalidatedAt: null,
        })),
      );
      const envelope = spyOn(db, "getSandboxSessionEnvelope").mockResolvedValue(null);
      const suffix = spyOn(db, "listTurnOpenSuffixToolCalls").mockResolvedValue([
        { resultItem: history[3] } as never,
      ]);
      const preparedInputs: unknown[] = [];
      const runtime = {
        prepareInput: async (agent, input) => {
          const prepared = await prepareRunInput(agent, input);
          preparedInputs.push(prepared.input);
          return prepared;
        },
      } as OpenGeniRuntime;
      try {
        const trigger = {
          id: crypto.randomUUID(),
          workspaceId,
          sessionId,
          sequence: 1,
          type: triggerType,
          payload: { text: "Continue the task" },
          occurredAt: "2026-08-01T00:00:00.000Z",
        };
        const options = {
          turnId,
          providerApi: "responses" as const,
          fileAuthority: { accountId: crypto.randomUUID(), subjectId: "user:test" },
        };
        await turnInput({} as db.Database, runtime, {}, trigger, options);
        await turnInput({} as db.Database, runtime, {}, trigger, { ...options, recovering: true });
        expect(preparedInputs[0]).toEqual(history);
        expect((preparedInputs[1] as unknown[]).slice(0, history.length)).toEqual(history);
        expect(preparedInputs[1]).toHaveLength(history.length + 1);
        expect(updates).toHaveBeenCalledWith(expect.anything(), workspaceId, sessionId, turnId);

        updates.mockResolvedValue([{ deliveredHistoryItemId: null } as never]);
        await expect(turnInput({} as db.Database, runtime, {}, trigger, options)).rejects.toThrow(
          "Delivered internal update has no durable model-memory batch",
        );
        expect(preparedInputs).toHaveLength(2);
      } finally {
        updates.mockRestore();
        loadHistory.mockRestore();
        envelope.mockRestore();
        suffix.mockRestore();
      }
    });
  }
});
