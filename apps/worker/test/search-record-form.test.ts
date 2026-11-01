import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { prepareRunInput, type OpenGeniRuntime } from "@opengeni/runtime";
import { hostedSearchFixture } from "../../../packages/runtime/test/fixtures/hosted-search";
import { turnInput } from "../src/activities/run-input";
import {
  projectTurnHistoryForProvider,
  type TurnSearchRecords,
} from "../src/activities/search-record-form";

const SEARCH_TEXT = "exactly seven colors";

function rowsOf(items: Array<Record<string, unknown>>): db.ActiveSessionHistoryRead {
  return {
    items: items.map((item, position) => ({
      id: crypto.randomUUID(),
      position,
      item,
      providerArtifactInvalidatedAt: null,
    })),
    footprint: { jsonBytes: 0, rows: items.length, jsonNodes: 0, jsonProperties: 0 },
    recovery: null,
  };
}

/** The role the model receives a search in, or undefined if it is absent. */
function searchRole(input: unknown): unknown {
  const items = Array.isArray(input) ? (input as Array<Record<string, unknown>>) : [];
  return items.find((item) => JSON.stringify(item).includes(SEARCH_TEXT))?.role;
}

test("turn input sends earlier searches in the form the turn settles on", async () => {
  const conversation = [
    { type: "message", role: "user", content: "What changed?" },
    { type: "message", role: "assistant", content: "Version 2 adds search." },
  ];
  const searched = [...conversation, hostedSearchFixture()];
  const updates = spyOn(db, "listSessionSystemUpdatesForTurn").mockResolvedValue([]);
  const envelope = spyOn(db, "getSandboxSessionEnvelope").mockResolvedValue(null);
  const adopt = spyOn(db, "adoptSessionSearchRecordsAsInput").mockResolvedValue(undefined);
  const inputs: unknown[] = [];
  const runtime = {
    prepareInput: async (agent, input) => {
      const prepared = await prepareRunInput(agent, input);
      inputs.push(prepared.input);
      return prepared;
    },
  } as OpenGeniRuntime;
  const trigger = {
    id: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    sequence: 1,
    type: "user.message",
    payload: { text: "Thanks" },
    occurredAt: "2026-10-30T00:00:00.000Z",
  };
  const run = (history: Array<Record<string, unknown>>, searchRecords: TurnSearchRecords) =>
    turnInput({} as db.Database, runtime, {}, trigger, {
      turnId: crypto.randomUUID(),
      providerApi: "responses",
      fileAuthority: { accountId: crypto.randomUUID(), subjectId: null },
      loadActiveHistory: async () => rowsOf(history),
      searchRecords,
    });
  try {
    // A session already in the runtime form sends a labelled user-role record.
    const runtimeRecords: TurnSearchRecords = { form: "runtime" };
    await run(searched, runtimeRecords);
    expect(searchRole(inputs.at(-1))).toBe("user");
    // One whose sent history holds a search keeps the form those requests used.
    const kept: TurnSearchRecords = { form: "assistant" };
    await run(searched, kept);
    expect(searchRole(inputs.at(-1))).toBe("assistant");
    expect(kept.form).toBe("assistant");
    expect(adopt).not.toHaveBeenCalled();
    // One whose history projects the same in both moves, durably, before the
    // run's model calls read the form.
    const moving: TurnSearchRecords = { form: "assistant" };
    await run(conversation, moving);
    expect(moving.form).toBe("runtime");
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledWith({}, trigger.workspaceId, trigger.sessionId);
  } finally {
    updates.mockRestore();
    envelope.mockRestore();
    adopt.mockRestore();
  }
});

test("compaction projects with the form the turn holds when compaction runs", () => {
  const items = [{ type: "message", role: "user", content: "Find it" }, hostedSearchFixture()];
  const records: TurnSearchRecords = { form: "assistant" };
  for (const api of ["responses", "chat", "anthropic-messages"] as const) {
    records.form = "assistant";
    expect(searchRole(projectTurnHistoryForProvider(items, api, records))).toBe("assistant");
    // Turn input settles the form after the projector was built.
    records.form = "runtime";
    expect(searchRole(projectTurnHistoryForProvider(items, api, records))).toBe("user");
  }
});
