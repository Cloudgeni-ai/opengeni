import { expect, test } from "bun:test";
import { prepareRunInput, buildRemoteCompactionV2PromptInput } from "@opengeni/runtime";
import { historyRowsToAppend } from "../src/activities/agent-turn/history";

test("turn notices preserve the full previous prefix across turns and compaction", async () => {
  const first = await prepareRunInput({} as any, {
    kind: "message",
    historyItems: [{ type: "message", role: "user", content: "first" }],
    internalContext: "codex_apps disconnected",
  });
  const firstInput = first.input as Array<Record<string, unknown>>;
  const response = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "done" }],
  };
  const seen = [...firstInput, response];
  const rows = historyRowsToAppend(seen, first.persistedHistoryCount);
  expect(rows.rows).toHaveLength(2);
  const durable = [firstInput[0]!, ...rows.rows.map((row) => row.item)];
  const next = await prepareRunInput({} as any, {
    kind: "message",
    historyItems: durable as any,
    internalContext: "codex_apps connected",
    text: "second",
  });
  expect((next.input as unknown[]).slice(0, seen.length)).toEqual(seen);
  const compact = buildRemoteCompactionV2PromptInput(durable as any);
  expect(JSON.stringify(compact)).toContain("codex_apps disconnected");
  expect(JSON.stringify(durable)).toContain("historical context, not current availability");
  const replay = historyRowsToAppend(seen, rows.nextWatermark, rows.nextPosition);
  expect(replay.rows).toEqual([]);
});

test("SDK-normalized turn notices remain durable without admitting unscoped system messages", async () => {
  const prepared = await prepareRunInput({} as any, {
    kind: "message",
    internalContext: "temporary recovery status",
  });
  const notice = (prepared.input as Array<Record<string, unknown>>)[0]!;
  const normalized = { ...notice, content: [{ type: "input_text", text: notice.content }] };
  const unscoped = { type: "message", role: "system", content: "legacy transient instruction" };
  expect(historyRowsToAppend([normalized, unscoped], 0).rows.map((row) => row.item)).toEqual([
    normalized,
  ]);
});
