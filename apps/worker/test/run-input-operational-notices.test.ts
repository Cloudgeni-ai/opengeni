import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { prepareRunInput, type OpenGeniRuntime } from "@opengeni/runtime";
import { turnInput } from "../src/activities/run-input";

test("repreparation reuses the last unchanged notice of this turn without rewriting history", async () => {
  const turnId = crypto.randomUUID();
  const earlierTurnId = crypto.randomUUID();
  const trigger = {
    id: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    sequence: 2,
    type: "user.message",
    payload: { text: "Check the latest result." },
    occurredAt: "2026-11-10T00:00:00.000Z",
  };
  const runtime = { prepareInput: prepareRunInput } as OpenGeniRuntime;
  const history: db.ActiveSessionHistoryRow[] = [];
  const updates = spyOn(db, "listSessionSystemUpdatesForTurn").mockResolvedValue([]);
  const envelope = spyOn(db, "getSandboxSessionEnvelope").mockResolvedValue(null);
  const add = (item: Record<string, unknown>, owner = turnId) =>
    history.push({
      id: crypto.randomUUID(),
      position: history.length,
      turnId: owner,
      item,
      providerArtifactInvalidatedAt: null,
    });
  const prepare = async (mcpAvailabilityNote: string) => {
    const result = await turnInput({} as db.Database, runtime, {}, trigger, {
      turnId,
      mcpAvailabilityNote,
      providerApi: "anthropic-messages",
      fileAuthority: { accountId: crypto.randomUUID(), subjectId: null },
      loadActiveHistory: async () => ({
        items: history,
        footprint: { jsonBytes: 0, rows: history.length, jsonNodes: 0, jsonProperties: 0 },
        recovery: null,
      }),
    });
    return result.input.input as Record<string, unknown>[];
  };
  try {
    const initial = await prepare("Connector A is unavailable.");
    expect(initial).toHaveLength(1);
    add(initial[0]!, earlierTurnId);
    const newTurn = await prepare("Connector A is unavailable.");
    expect(newTurn).toEqual([...initial, initial[0]]);
    add(newTurn[1]!);
    add({ type: "message", role: "user", content: "Check the latest result." });

    const durable = structuredClone(history.map(({ item }) => item));
    expect(await prepare("Connector A is unavailable.")).toEqual(durable);
    const changed = await prepare("Connector B is unavailable.");
    expect(changed.slice(0, -1)).toEqual(durable);
    expect(changed.at(-1)?.content).toContain("Connector B is unavailable.");
    add(changed.at(-1)!);
    const reverted = await prepare("Connector A is unavailable.");
    expect(reverted.slice(0, -1)).toEqual(history.map(({ item }) => item));
    expect(reverted.at(-1)).toEqual(initial[0]);
  } finally {
    updates.mockRestore();
    envelope.mockRestore();
  }
});
