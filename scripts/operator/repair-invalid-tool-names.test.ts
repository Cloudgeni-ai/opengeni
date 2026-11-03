import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, createSession } from "../../packages/db/src";
import {
  collectToolNames,
  mappedVisitor,
  repairInvalidToolNames,
  rewriteItemToolNames,
  rewriteRunStateToolNames,
  toolNameMapping,
} from "./repair-invalid-tool-names";

const SECRET_LABEL = ["{", "{secret:Task/db/password}}"].join("");
const KNOWN = "connected__fetch_prod-db-0042";
const MASKED = `connected__fetch_${SECRET_LABEL}`;

const call = (name: string, callId: string) => ({
  type: "function_call",
  callId,
  name,
  arguments: JSON.stringify({ note: SECRET_LABEL }),
});
const result = (name: string, callId: string) => ({
  type: "function_call_result",
  callId,
  name,
  output: { type: "text", text: `ran ${name}` },
});

describe("tool-name mapping", () => {
  test("masked and dotted names denote the session's tool; others get a stable alias", () => {
    const items = [
      call(KNOWN, "a"),
      call(MASKED, "b"),
      result(MASKED, "b"),
      call("connected.list_items", "c"),
      call("connected__list_items", "d"),
      call("no such tool!", "e"),
    ];
    const { invalid, valid } = collectToolNames(items);
    expect([...invalid.keys()]).toEqual([MASKED, "connected.list_items", "no such tool!"]);
    const mapping = toolNameMapping(invalid, valid);
    expect(mapping.get(MASKED)).toBe(KNOWN);
    expect(mapping.get("connected.list_items")).toBe("connected__list_items");
    expect(mapping.get("no such tool!")).toMatch(/^no_such_tool__[0-9a-f]{16}$/);
    const visit = mappedVisitor(mapping);
    const rewritten = items.map((item) => rewriteItemToolNames(item, visit));
    expect(rewritten.map((item) => (item as { name: string }).name)).toEqual([
      KNOWN,
      KNOWN,
      KNOWN,
      "connected__list_items",
      "connected__list_items",
      mapping.get("no such tool!")!,
    ]);
    // Valid items keep their identity; only the name changes, never content.
    expect(rewritten[0]).toBe(items[0]);
    expect((rewritten[1] as { arguments: string }).arguments).toBe(call(MASKED, "b").arguments);
    expect((rewritten[2] as { output: unknown }).output).toBe((items[2] as { output: unknown }).output);
  });

  test("a run state's model responses and generated items are fixed, outputs untouched", () => {
    const state = {
      currentAgent: { name: "agent with spaces" },
      modelResponses: [{ output: [call(MASKED, "b")] }],
      generatedItems: [{ type: "tool_call_output_item", rawItem: result(MASKED, "b"), output: MASKED }],
    };
    const { invalid } = collectToolNames([state], rewriteRunStateToolNames);
    const mapping = toolNameMapping(invalid, [KNOWN]);
    const next = rewriteRunStateToolNames(state, mappedVisitor(mapping)) as typeof state;
    expect(next.modelResponses[0]!.output[0]!.name).toBe(KNOWN);
    expect(next.generatedItems[0]!.rawItem.name).toBe(KNOWN);
    expect(next.generatedItems[0]!.output).toBe(MASKED);
    expect(next.currentAgent).toBe(state.currentAgent);
  });

  test("a definition list that would declare one name twice keeps the first", () => {
    const search = {
      type: "tool_search_output",
      tools: [
        { type: "function", name: "connected.list_items" },
        { type: "function", name: "connected__list_items" },
      ],
    };
    const { invalid, valid } = collectToolNames([search]);
    const next = rewriteItemToolNames(search, mappedVisitor(toolNameMapping(invalid, valid)));
    expect((next as typeof search).tools).toEqual([
      { type: "function", name: "connected__list_items" },
    ]);
  });
});

describe("repair against PostgreSQL", () => {
  let fixture: SharedTestDatabase;
  let client: ReturnType<typeof createDb>;
  let accountId: string, workspaceId: string, sessionId: string, cleanSessionId: string;

  beforeAll(async () => {
    const shared = await acquireSharedTestDatabase("operator-repair-tool-names");
    if (!shared) throw Error("Real PostgreSQL required");
    fixture = shared;
    client = createDb(shared.appUrl, { max: 1 });
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Repair",
      workspaceExternalSource: "test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Repair",
      subjectId: crypto.randomUUID(),
    });
    ({ accountId, workspaceId } = access.workspaceGrants[0]!);
    const session = () =>
      createSession(client.db, {
        accountId,
        workspaceId,
        initialMessage: "Fixture",
        resources: [],
        metadata: {},
        model: "test",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      });
    sessionId = (await session()).id;
    cleanSessionId = (await session()).id;
    const insert = async (session: string, position: number, item: unknown) =>
      await fixture.admin`insert into session_history_items
        (account_id, workspace_id, session_id, position, item_ordered, item_codec_version)
        values (${accountId}, ${workspaceId}, ${session}, ${position}, ${fixture.admin.json(item as never)}, 1)`;
    await insert(sessionId, 0, { type: "message", role: "user", content: `use ${SECRET_LABEL}` });
    await insert(sessionId, 1, call(KNOWN, "a"));
    await insert(sessionId, 2, result(KNOWN, "a"));
    await insert(sessionId, 3, call(MASKED, "b"));
    await insert(sessionId, 4, result(MASKED, "b"));
    await insert(cleanSessionId, 0, call(KNOWN, "z"));
    await fixture.admin`insert into agent_run_states
      (account_id, workspace_id, session_id, state_version, serialized_run_state, serialized_run_state_codec_version)
      values (${accountId}, ${workspaceId}, ${sessionId}, 1,
        ${JSON.stringify({ modelResponses: [{ output: [call(MASKED, "b")] }] })}, 1)`;
  });
  afterAll(async () => {
    await client?.close();
    await fixture?.release();
  });

  const stored = async () =>
    (
      await fixture.admin<Array<{ item: Record<string, unknown> }>>`
        select item_ordered as item from session_history_items
        where session_id = ${sessionId} order by position`
    ).map((row) => row.item);

  test("a dry run counts without writing, and apply fixes only tool names", async () => {
    const before = await stored();
    const dry = await repairInvalidToolNames(fixture.admin, false);
    expect(dry).toMatchObject({ sessions: 1, historyItems: 2, runStates: 1, failedSessions: [] });
    expect(dry.names[MASKED]).toBe(KNOWN);
    expect(await stored()).toEqual(before);

    const applied = await repairInvalidToolNames(fixture.admin, true);
    expect(applied).toMatchObject({ sessions: 1, historyItems: 2, runStates: 1 });
    const after = await stored();
    expect(after.map((item) => item.name ?? null)).toEqual([null, KNOWN, KNOWN, KNOWN, KNOWN]);
    // Message text, arguments and outputs keep exactly what they held.
    expect(after[0]).toEqual(before[0]!);
    expect(after[3]!.arguments).toBe(before[3]!.arguments);
    expect(after[4]!.output).toEqual(before[4]!.output);
    const [jsonb] = await fixture.admin`select item->>'name' as name from session_history_items
      where session_id = ${sessionId} and position = 3`;
    expect(jsonb!.name).toBe(KNOWN);
    const [state] = await fixture.admin`select serialized_run_state as state from agent_run_states
      where session_id = ${sessionId}`;
    expect(JSON.parse(state!.state).modelResponses[0].output[0].name).toBe(KNOWN);

    // Idempotent: nothing is left to fix.
    expect(await repairInvalidToolNames(fixture.admin, false)).toMatchObject({
      sessions: 0,
      historyItems: 0,
      runStates: 0,
    });
  });
});
