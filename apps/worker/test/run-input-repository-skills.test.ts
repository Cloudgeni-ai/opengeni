import { expect, spyOn, test } from "bun:test";
import { repositorySkillsContextItem } from "@opengeni/contracts";
import * as db from "@opengeni/db";
import { prepareRunInput, type OpenGeniRuntime } from "@opengeni/runtime";
import { turnInput } from "../src/activities/run-input";

function activeHistoryRead(items: db.ActiveSessionHistoryRow[]): db.ActiveSessionHistoryRead {
  return {
    items,
    footprint: { jsonBytes: 0, rows: items.length, jsonNodes: 0, jsonProperties: 0 },
    recovery: null,
  };
}

function rows(items: Array<{ turnId: string; item: Record<string, unknown> }>) {
  return items.map(({ turnId, item }, position) => ({
    id: crypto.randomUUID(),
    position,
    turnId,
    item,
    providerArtifactInvalidatedAt: null,
  }));
}

for (const providerApi of ["responses", "anthropic"] as const) {
  test(`the current turn sees the Repository skills index where later turns load it (${providerApi})`, async () => {
    const workspaceId = crypto.randomUUID(),
      sessionId = crypto.randomUUID(),
      earlierTurn = crypto.randomUUID(),
      turnId = crypto.randomUUID();
    const earlier = [
      { turnId: earlierTurn, item: { type: "message", role: "user", content: "First" } },
      {
        turnId: earlierTurn,
        item: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done" }],
        },
      },
    ];
    const current = { turnId, item: { type: "message", role: "user", content: "Second" } };
    const index = "### Available repository skills\n- added";
    const stored = { turnId, item: repositorySkillsContextItem(index) };
    const updates = spyOn(db, "listSessionSystemUpdatesForTurn").mockResolvedValue([]);
    const envelope = spyOn(db, "getSandboxSessionEnvelope").mockResolvedValue(null);
    const runtime = {
      prepareInput: async (agent, input) => await prepareRunInput(agent, input),
    } as OpenGeniRuntime;
    const trigger = {
      id: crypto.randomUUID(),
      workspaceId,
      sessionId,
      sequence: 2,
      type: "user.message",
      payload: { text: "Second" },
      occurredAt: "2026-11-10T00:00:00.000Z",
    };
    const options = (history: ReturnType<typeof rows>) => ({
      turnId,
      providerApi,
      fileAuthority: { accountId: crypto.randomUUID(), subjectId: null },
      loadActiveHistory: async () => activeHistoryRead(history),
    });
    try {
      // This turn, before the run writes the index.
      const now = await turnInput({} as db.Database, runtime, {}, trigger, {
        ...options(rows([...earlier, current])),
      });
      // A later request that loads the stored index before this turn's rows.
      const later = await turnInput({} as db.Database, runtime, {}, trigger, {
        ...options(rows([...earlier, stored, current])),
      });
      const input = now.input.input as unknown[];
      expect(now.input.turnStartIndex).toBeNumber();
      const spliced = [
        ...input.slice(0, now.input.turnStartIndex),
        now.input.renderRepositorySkillsItem!(index),
        ...input.slice(now.input.turnStartIndex),
      ];
      expect(JSON.stringify(spliced)).toBe(JSON.stringify(later.input.input));
      expect(JSON.stringify(input)).not.toContain("turn start");
      expect(now.input.persistedHistoryCount + 1).toBe(later.input.persistedHistoryCount);

      // A turn whose rows are not stored yet starts after the history.
      const fresh = await turnInput({} as db.Database, runtime, {}, trigger, {
        ...options(rows(earlier)),
      });
      const freshInput = fresh.input.input as unknown[];
      expect(fresh.input.turnStartIndex).toBe(fresh.input.persistedHistoryCount);
      expect(JSON.stringify(freshInput)).not.toContain("turn start");
    } finally {
      updates.mockRestore();
      envelope.mockRestore();
    }
  });
}
