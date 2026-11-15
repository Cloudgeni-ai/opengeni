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

for (const providerApi of ["responses", "anthropic-messages", "chat"] as const) {
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
      // What the run shows once it stored the index: its history as later
      // turns load it, then its own turn input.
      const shown = async (prepared: typeof now) => [
        ...(await prepared.input.historyWithRepositorySkills!(index))!,
        ...(prepared.input.input as unknown[]).slice(prepared.input.persistedHistoryCount),
      ];
      expect(JSON.stringify(await shown(now))).toBe(JSON.stringify(later.input.input));
      expect(JSON.stringify(now.input.input)).not.toContain("opengeni_repository_skills");
      expect(now.input.persistedHistoryCount + 1).toBe(later.input.persistedHistoryCount);

      // A turn whose rows are not stored yet has the index after the history.
      const fresh = await turnInput({} as db.Database, runtime, {}, trigger, {
        ...options(rows(earlier)),
      });
      const freshLater = await turnInput({} as db.Database, runtime, {}, trigger, {
        ...options(rows([...earlier, stored])),
      });
      expect(JSON.stringify(await shown(fresh))).toBe(JSON.stringify(freshLater.input.input));
    } finally {
      updates.mockRestore();
      envelope.mockRestore();
    }
  });
}

test("without a new index, the run input is the stored history exactly", async () => {
  // Sanitizing drops reasoning tied to an unpaired call, across the turn start.
  const earlierTurn = crypto.randomUUID(),
    turnId = crypto.randomUUID();
  const history = rows([
    { turnId: earlierTurn, item: { type: "message", role: "user", content: "First" } },
    { turnId: earlierTurn, item: { type: "reasoning", id: "rs_1", summary: [] } },
    {
      turnId,
      item: { type: "function_call", callId: "open", name: "work", arguments: "{}" },
    },
    { turnId, item: { type: "message", role: "user", content: "Second" } },
  ]);
  const updates = spyOn(db, "listSessionSystemUpdatesForTurn").mockResolvedValue([]);
  const envelope = spyOn(db, "getSandboxSessionEnvelope").mockResolvedValue(null);
  const runtime = {
    prepareInput: async (agent, input) => await prepareRunInput(agent, input),
  } as OpenGeniRuntime;
  const trigger = {
    id: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    sequence: 2,
    type: "user.message",
    payload: { text: "Second" },
    occurredAt: "2026-11-10T00:00:00.000Z",
  };
  const options = {
    providerApi: "responses" as const,
    fileAuthority: { accountId: crypto.randomUUID(), subjectId: null },
    loadActiveHistory: async () => activeHistoryRead(history),
  };
  try {
    const withTurn = await turnInput({} as db.Database, runtime, {}, trigger, {
      ...options,
      turnId,
    });
    const withoutTurn = await turnInput({} as db.Database, runtime, {}, trigger, {
      ...options,
      turnId: undefined as unknown as string,
    });
    expect(JSON.stringify(withTurn.input.input)).toBe(JSON.stringify(withoutTurn.input.input));
    expect(JSON.stringify(withTurn.input.input)).not.toContain("rs_1");
  } finally {
    updates.mockRestore();
    envelope.mockRestore();
  }
});
