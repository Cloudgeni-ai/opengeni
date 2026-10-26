import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL } from "@opengeni/codex";
import {
  ACTIVE_HISTORY_INLINE_PAYLOAD_OMISSION,
  ACTIVE_SESSION_HISTORY_COMPACTION_RATIO,
  ACTIVE_SESSION_HISTORY_LIMITS,
  ActiveSessionHistoryLimitExceededError,
  activeSessionHistoryCompactionPressure,
  addActiveSessionHistoryFootprint,
  appendSessionHistoryItems,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getActiveSessionHistoryItemsPaged,
  planActiveSessionHistoryRecovery,
  readActiveSessionHistory,
  restoreElidedInlinePayloads,
  withWorkspaceRls,
  type ActiveSessionHistoryFootprint,
  type ActiveSessionHistoryRowMeasure,
} from "../src/index";
import * as schema from "../src/schema";
import { submitTestHumanPrompt } from "../../../test/integration/helpers/session-control";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("active-session-history");
  if (!acquired) throw new Error("Restricted PostgreSQL fixture required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

function screenshot(bytes: number): string {
  return `data:image/png;base64,${"A".repeat(bytes)}`;
}

async function sessionFixture() {
  const id = crypto.randomUUID();
  const {
    workspaceGrants: [grant],
  } = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Active history footprint",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Active history footprint",
    subjectId: id,
  });
  if (!grant) throw new Error("Missing fixture grant");
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { accountId: grant.accountId, workspaceId: grant.workspaceId, sessionId: session.id };
}

async function insertHistory(
  fixture: Awaited<ReturnType<typeof sessionFixture>>,
  items: Array<Record<string, unknown>>,
) {
  await withWorkspaceRls(client.db, fixture.workspaceId, async (db) => {
    await db.insert(schema.sessionHistoryItems).values(
      items.map((item, position) => ({
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        position,
        item,
      })),
    );
  });
}

/** A browser-automation transcript: each step is a tool call plus a screenshot result. */
function screenshotTranscript(steps: number, imageBytes: number) {
  const items: Array<Record<string, unknown>> = [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Fill in the form on this page" },
        { type: "input_image", image: screenshot(imageBytes) },
      ],
    },
  ];
  for (let step = 0; step < steps; step += 1) {
    const callId = `call_${step}`;
    items.push({
      type: "function_call",
      callId,
      name: "browser_screenshot",
      arguments: "{}",
      status: "completed",
    });
    items.push({
      type: "function_call_result",
      callId,
      name: "browser_screenshot",
      status: "completed",
      output: [
        { type: "input_text", text: `step ${step}` },
        { type: "input_image", image: screenshot(imageBytes) },
      ],
    });
  }
  return items;
}

describe("active session history footprint", () => {
  test("compaction pressure starts at the ratio of any limit and prefers an exceeded limit", () => {
    const limits = { jsonBytes: 1_000, rows: 100, jsonNodes: 1_000, jsonProperties: 1_000 };
    const small = { jsonBytes: 10, rows: 1, jsonNodes: 1, jsonProperties: 1 };
    expect(ACTIVE_SESSION_HISTORY_COMPACTION_RATIO).toBe(0.6);
    expect(activeSessionHistoryCompactionPressure(small, limits)).toBeNull();
    expect(activeSessionHistoryCompactionPressure({ ...small, jsonBytes: 599 }, limits)).toBeNull();
    expect(
      activeSessionHistoryCompactionPressure({ ...small, jsonBytes: 600 }, limits),
    ).toMatchObject({ limitKind: "json_bytes", actual: 600, threshold: 600, exceeded: false });
    expect(activeSessionHistoryCompactionPressure({ ...small, rows: 60 }, limits)).toMatchObject({
      limitKind: "rows",
      threshold: 60,
      exceeded: false,
    });
    expect(
      activeSessionHistoryCompactionPressure(
        { jsonBytes: 700, rows: 1, jsonNodes: 1_001, jsonProperties: 1 },
        limits,
      ),
    ).toMatchObject({ limitKind: "json_nodes", exceeded: true, maximum: 1_000 });
    // Production thresholds: 9 MiB of the 15 MiB byte guard, for example.
    expect(
      activeSessionHistoryCompactionPressure({
        jsonBytes: Math.floor(ACTIVE_SESSION_HISTORY_LIMITS.jsonBytes * 0.6),
        rows: 1,
        jsonNodes: 1,
        jsonProperties: 1,
      }),
    ).toMatchObject({ limitKind: "json_bytes", threshold: 9_437_184 });
  });

  test("an append reports the inserted rows' footprint exactly as the guarded read measures it", async () => {
    const id = crypto.randomUUID();
    const {
      workspaceGrants: [grant],
    } = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: id,
      accountName: "Append footprint",
      workspaceExternalSource: "test",
      workspaceExternalId: id,
      workspaceName: "Append footprint",
      subjectId: id,
    });
    if (!grant) throw new Error("Missing fixture grant");
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "take screenshots",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await submitTestHumanPrompt(client.db, {
      ...grant,
      sessionId: session.id,
      text: "take screenshots",
      resources: [],
      tools: [],
      reasoningEffortFallback: "medium",
    });
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: session.id,
      attemptId,
      dispatchId: crypto.randomUUID(),
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error("Missing fixture claim");
    const before = await readActiveSessionHistory(client.db, grant.workspaceId, session.id);
    const deltas: ActiveSessionHistoryFootprint[] = [];
    const append = (items: Array<Record<string, unknown>>) =>
      appendSessionHistoryItems(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId: claim.turn.id,
        expectedExecutionGeneration: claim.turn.executionGeneration,
        expectedAttemptId: attemptId,
        items: items.map((item, index) => ({ position: 1_000 + index, item })),
        onAppendedFootprint: (delta) => deltas.push(delta),
      });
    // Non-ASCII text checks that bytes are UTF-8 bytes, not characters.
    const items = [
      ...screenshotTranscript(2, 4_096).slice(1),
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "fertig ✓" }] },
    ];
    expect(await append(items)).toBe(true);
    const after = await readActiveSessionHistory(client.db, grant.workspaceId, session.id);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.rows).toBe(items.length);
    expect(addActiveSessionHistoryFootprint(before.footprint, deltas[0]!)).toEqual(after.footprint);

    // An idempotent replay inserts nothing and adds nothing.
    expect(await append(items)).toBe(true);
    expect(deltas[1]).toEqual({ jsonBytes: 0, rows: 0, jsonNodes: 0, jsonProperties: 0 });
  });

  test("throw mode is unchanged: an over-limit history is rejected before decoding", async () => {
    const fixture = await sessionFixture();
    await insertHistory(fixture, screenshotTranscript(6, 8_192));
    const limits = { jsonBytes: 40_000 };
    await expect(
      readActiveSessionHistory(client.db, fixture.workspaceId, fixture.sessionId, { limits }),
    ).rejects.toBeInstanceOf(ActiveSessionHistoryLimitExceededError);
    await expect(
      getActiveSessionHistoryItemsPaged(
        client.db,
        fixture.workspaceId,
        fixture.sessionId,
        16,
        40_000,
      ),
    ).rejects.toMatchObject({ code: "active_history_too_large", limitKind: "json_bytes" });
  });

  test("bounded recovery leaves out the oldest inline images in PostgreSQL and keeps everything else", async () => {
    const fixture = await sessionFixture();
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      content: [],
      // Raw base64 that is not a data URL must survive untouched.
      providerData: { encryptedContent: "QUJD".repeat(2_000) },
    };
    const computerScreenshot = {
      type: "computer_call_result",
      callId: "computer_1",
      status: "completed",
      output: { type: "computer_screenshot", data: screenshot(8_192) },
    };
    const items = [
      ...screenshotTranscript(6, 8_192),
      {
        type: "computer_call",
        callId: "computer_1",
        status: "completed",
        action: { type: "screenshot" },
      },
      computerScreenshot,
      reasoning,
      { type: "message", role: "user", content: [{ type: "input_text", text: "keep going" }] },
    ];
    await insertHistory(fixture, items);
    const complete = await readActiveSessionHistory(
      client.db,
      fixture.workspaceId,
      fixture.sessionId,
    );
    const limits = { jsonBytes: Math.floor(complete.footprint.jsonBytes * 0.9) };

    const read = await readActiveSessionHistory(client.db, fixture.workspaceId, fixture.sessionId, {
      limits,
      overLimit: "bounded_recovery",
    });
    expect(read.footprint).toEqual(complete.footprint);
    expect(read.recovery).toMatchObject({
      limitKind: "json_bytes",
      actual: complete.footprint.jsonBytes,
      maximum: limits.jsonBytes,
      omittedRows: 0,
    });
    expect(read.recovery!.elidedRows).toBeGreaterThan(0);
    // Every row is kept, in order; the bounded view fits the recovery budget.
    expect(read.items.map((row) => row.position)).toEqual(items.map((_, index) => index));
    const viewBytes = read.items.reduce(
      (total, row) => total + Buffer.byteLength(JSON.stringify(row.item)) + 1,
      1,
    );
    expect(viewBytes).toBeLessThanOrEqual(
      limits.jsonBytes * ACTIVE_SESSION_HISTORY_COMPACTION_RATIO,
    );

    // Tool results lose their images oldest-first; the user message keeps its
    // image because eliding tool results alone was enough.
    expect(read.items[0]!.item).toEqual(items[0]!);
    const firstResult = read.items[2]!.item;
    expect(firstResult).toEqual({
      type: "function_call_result",
      callId: "call_0",
      name: "browser_screenshot",
      status: "completed",
      output: [
        { type: "input_text", text: "step 0" },
        { type: "input_text", text: ACTIVE_HISTORY_INLINE_PAYLOAD_OMISSION },
      ],
    });
    // Stored key order survives the elision round trip.
    expect(Object.keys(firstResult)).toEqual(Object.keys(items[2]!));
    expect(JSON.stringify(read.items.slice(-4).map((row) => row.item))).toBe(
      JSON.stringify(items.slice(-4)),
    );
    expect(JSON.stringify(read.items.map((row) => row.item))).toContain(
      reasoning.providerData.encryptedContent,
    );

    // A tighter limit also elides the computer screenshot and then messages.
    const tight = await readActiveSessionHistory(
      client.db,
      fixture.workspaceId,
      fixture.sessionId,
      { limits: { jsonBytes: 20_000 }, overLimit: "bounded_recovery" },
    );
    expect(tight.recovery?.omittedRows).toBe(0);
    const tightItems = tight.items.map((row) => row.item);
    expect(JSON.stringify(tightItems)).not.toContain("data:image/png;base64,AAAA");
    expect(tightItems.at(-3)).toEqual({
      ...computerScreenshot,
      output: {
        type: "computer_screenshot",
        data: MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL,
      },
    });
    expect((tightItems[0]!.content as unknown[])[1]).toEqual({
      type: "input_text",
      text: ACTIVE_HISTORY_INLINE_PAYLOAD_OMISSION,
    });
    expect(tightItems.at(-2)).toEqual(reasoning);
  });

  test("bounded recovery leaves out the oldest rows when the row limit binds, and fails when nothing fits", async () => {
    const fixture = await sessionFixture();
    const items = screenshotTranscript(4, 64);
    await insertHistory(fixture, [
      ...items,
      { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    ]);
    // 11 rows over a 10-row limit: the view keeps at most 6 and starts at a
    // message, so no tool result is kept without its call.
    const read = await readActiveSessionHistory(client.db, fixture.workspaceId, fixture.sessionId, {
      limits: { rows: 10 },
      overLimit: "bounded_recovery",
    });
    expect(read.recovery).toMatchObject({ limitKind: "rows", actual: 11, maximum: 10 });
    expect(read.items.map((row) => row.position)).toEqual([9, 10]);
    expect(read.recovery!.omittedRows).toBe(9);

    const huge = await sessionFixture();
    await insertHistory(huge, [
      { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(4_000) }] },
    ]);
    await expect(
      readActiveSessionHistory(client.db, huge.workspaceId, huge.sessionId, {
        limits: { jsonBytes: 2_000 },
        overLimit: "bounded_recovery",
      }),
    ).rejects.toBeInstanceOf(ActiveSessionHistoryLimitExceededError);
  });
});

describe("bounded recovery planning", () => {
  const row = (
    position: number,
    jsonBytes: number,
    elidedJsonBytes: number,
    message: boolean,
  ): ActiveSessionHistoryRowMeasure => ({
    position,
    jsonBytes,
    elidedJsonBytes,
    jsonNodes: 1,
    jsonProperties: 1,
    message,
  });
  const budget = { jsonBytes: 1_000, rows: 100, jsonNodes: 100, jsonProperties: 100 };

  test("elides tool results oldest-first before any message", () => {
    const plan = planActiveSessionHistoryRecovery(
      [row(0, 400, 20, true), row(1, 400, 20, false), row(2, 400, 20, false), row(3, 50, 50, true)],
      budget,
    );
    expect(plan).toEqual({
      startPosition: 0,
      omittedRows: 0,
      elideOtherThrough: 1,
      elideMessagesThrough: null,
      elidedRows: 1,
    });
  });

  test("moves an omission boundary forward to the next message", () => {
    const plan = planActiveSessionHistoryRecovery(
      [
        row(0, 600, 600, true),
        row(1, 600, 600, false),
        row(2, 100, 100, false),
        row(3, 100, 100, true),
        row(4, 100, 100, false),
      ],
      budget,
    );
    expect(plan).toMatchObject({ startPosition: 3, omittedRows: 3 });
  });

  test("returns null when the newest row alone exceeds the budget", () => {
    expect(
      planActiveSessionHistoryRecovery([row(0, 10, 10, true), row(1, 2_000, 1_500, true)], budget),
    ).toBeNull();
  });

  test("restores sentinels into protocol-valid content without touching other values", () => {
    const untouched = { type: "message", content: [{ type: "input_text", text: "plain" }] };
    expect(restoreElidedInlinePayloads(untouched)).toBe(untouched);
  });
});
