import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { prepareRunInput, type OpenGeniRuntime } from "@opengeni/runtime";
import { turnInput } from "../src/activities/run-input";
import {
  STEER_REPLACEMENT_NOTE,
  STEER_REPLACEMENT_NOTE_HEADING,
  steerReplacedTurnId,
  steerReplacementNote,
  steerReplacementNoteDue,
} from "../src/activities/agent-turn/steer-replacement";

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

const notice = (text: string) => ({
  type: "message",
  role: "system",
  content: `[Opengeni turn-scoped operational notice]\n${text}`,
});

// The shape a superseded turn leaves behind: its request, its turn notice and
// the work it finished before its next model step, then the Steer's message.
const supersededTurn = crypto.randomUUID();
const turnId = crypto.randomUUID();
const earlier = [
  {
    turnId: supersededTurn,
    item: { type: "message", role: "user", content: "Summarise this week's hours per project." },
  },
  { turnId: supersededTurn, item: notice("Connector availability for this turn: ...") },
  {
    turnId: supersededTurn,
    item: { type: "function_call", callId: "c1", name: "find_tools", arguments: "{}" },
  },
  {
    turnId: supersededTurn,
    item: { type: "function_call_result", callId: "c1", name: "find_tools", output: "ok" },
  },
];
const steerMessage = {
  turnId,
  item: { type: "message", role: "user", content: "How many open change requests are there?" },
};

async function prepare(history: ReturnType<typeof rows>, note: string | undefined) {
  const updates = spyOn(db, "listSessionSystemUpdatesForTurn").mockResolvedValue([]);
  const envelope = spyOn(db, "getSandboxSessionEnvelope").mockResolvedValue(null);
  const runtime = {
    prepareInput: async (agent, input) => await prepareRunInput(agent, input),
  } as OpenGeniRuntime;
  try {
    const prepared = await turnInput(
      {} as db.Database,
      runtime,
      {},
      {
        id: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        sequence: 9,
        type: "user.message",
        payload: { text: "How many open change requests are there?" },
        occurredAt: "2026-11-12T20:00:53.000Z",
      },
      {
        turnId,
        providerApi: "responses",
        fileAuthority: { accountId: crypto.randomUUID(), subjectId: null },
        loadActiveHistory: async () => activeHistoryRead(history),
        mcpAvailabilityNote: "Connector availability for this turn: ...",
        ...(note ? { steerReplacementNote: note } : {}),
      },
    );
    return {
      input: prepared.input.input as Array<Record<string, unknown>>,
      persisted: prepared.input.persistedHistoryCount,
    };
  } finally {
    updates.mockRestore();
    envelope.mockRestore();
  }
}

const text = (item: Record<string, unknown> | undefined) =>
  typeof item?.content === "string" ? item.content : JSON.stringify(item?.content);

test("a Steer's replacement turn is told the earlier request is unfinished, after its message", async () => {
  const history = rows([...earlier, steerMessage]);
  const plain = await prepare(history, undefined);
  const told = await prepare(history, STEER_REPLACEMENT_NOTE);

  // Every earlier item is sent byte for byte as before: the note is new text
  // at the end, so the cached prefix of earlier requests is unchanged.
  expect(told.persisted).toBe(plain.persisted);
  expect(JSON.stringify(told.input.slice(0, told.persisted))).toBe(
    JSON.stringify(plain.input.slice(0, plain.persisted)),
  );
  const last = told.input.at(-1);
  expect(last?.role).toBe("system");
  expect(text(told.input.at(-2))).toContain("How many open change requests");
  // It leads the turn's own notice, which still carries the other notes.
  const body = text(last);
  expect(body).toContain(STEER_REPLACEMENT_NOTE);
  expect(body.indexOf(STEER_REPLACEMENT_NOTE_HEADING)).toBeLessThan(
    body.indexOf("Connector availability"),
  );
  expect(JSON.stringify(plain.input)).not.toContain(STEER_REPLACEMENT_NOTE_HEADING);
});

test("the note is shown once per turn", async () => {
  // Input prepared again after the turn produced output (a reply nudge, a
  // compaction retry, a recovery attempt): the model has already seen it.
  const afterOutput = rows([
    ...earlier,
    steerMessage,
    { turnId, item: notice(STEER_REPLACEMENT_NOTE) },
    {
      turnId,
      item: {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "There are 9." }],
      },
    },
  ]);
  const again = await prepare(afterOutput, STEER_REPLACEMENT_NOTE);
  // The stored copy is the only one; this input's new notice does not repeat it.
  expect(JSON.stringify(again.input).split(STEER_REPLACEMENT_NOTE_HEADING).length).toBe(2);
  expect(text(again.input.at(-1))).not.toContain(STEER_REPLACEMENT_NOTE_HEADING);

  // Stored with the turn's notice but no output yet: still not repeated.
  const noticeOnly = rows([
    ...earlier,
    steerMessage,
    { turnId, item: notice(STEER_REPLACEMENT_NOTE) },
  ]);
  expect(steerReplacementNoteDue(noticeOnly, turnId)).toBe(false);
  // Another turn's output or note never counts for this one.
  expect(steerReplacementNoteDue(rows([...earlier, steerMessage]), turnId)).toBe(true);
});

test("only a Steer whose replaced turn really ended superseded gets the note", async () => {
  const workspaceId = crypto.randomUUID();
  const replacedTurnId = crypto.randomUUID();
  const steer = { source: "user", metadata: { delivery: "steer", replacedTurnId } };
  const status = (value: string | null) =>
    spyOn(db, "getSessionTurn").mockImplementation(async (_db, _workspace, id) => {
      expect(id).toBe(replacedTurnId);
      return value === null ? null : ({ id, status: value } as db.SessionTurn);
    });

  let lookup = status("superseded");
  expect(await steerReplacementNote({} as db.Database, workspaceId, steer)).toBe(
    STEER_REPLACEMENT_NOTE,
  );
  lookup.mockRestore();

  // A Steer deferred to the next model step found the old turn finishing on its own.
  lookup = status("completed");
  expect(await steerReplacementNote({} as db.Database, workspaceId, steer)).toBeUndefined();
  lookup.mockRestore();

  lookup = spyOn(db, "getSessionTurn").mockRejectedValue(new Error("read failed"));
  expect(await steerReplacementNote({} as db.Database, workspaceId, steer)).toBeUndefined();
  lookup.mockRestore();

  // Ordinary sends, compaction maintenance and a Steer into an idle chat carry no note.
  expect(steerReplacedTurnId({ source: "user", metadata: { delivery: "send" } })).toBeNull();
  expect(steerReplacedTurnId({ source: "compaction", metadata: steer.metadata })).toBeNull();
  expect(
    steerReplacedTurnId({ source: "user", metadata: { delivery: "steer", replacedTurnId: null } }),
  ).toBeNull();
  expect(steerReplacedTurnId(steer)).toBe(replacedTurnId);
});
