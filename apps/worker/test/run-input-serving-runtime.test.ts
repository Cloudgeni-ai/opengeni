import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { prepareRunInput, type OpenGeniRuntime } from "@opengeni/runtime";
import { turnInput } from "../src/activities/run-input";
import { acceptedPolicy } from "../../../packages/contracts/test/fixtures/turn-serving-policy";

test("SUB-FAIL-08 portable request projection keeps completed tools exactly once and never edits canonical rows", async () => {
  const workspaceId = crypto.randomUUID(),
    sessionId = crypto.randomUUID(),
    turnId = crypto.randomUUID();
  const history = [
    { type: "message", role: "user", content: "Continue" },
    {
      type: "reasoning",
      id: "r",
      encrypted_content: "foreign-opaque",
      summary: [{ type: "summary_text", text: "Summary" }],
    },
    { type: "function_call", callId: "done", name: "work", arguments: "{}" },
    { type: "function_call_result", callId: "done", name: "work", output: "completed" },
  ];
  const rows = history.map((item, position) => ({
    id: crypto.randomUUID(),
    position,
    item,
    providerArtifactInvalidatedAt: null,
  }));
  const original = structuredClone(rows);
  const updates = spyOn(db, "listSessionSystemUpdatesForTurn").mockResolvedValue([]);
  const envelope = spyOn(db, "getSandboxSessionEnvelope").mockResolvedValue(null);
  const provenance = spyOn(db, "readSubscriptionHistoryProvenance").mockResolvedValue({
    turnByHistoryId: new Map(rows.map((row) => [row.id, turnId])),
    turnMetadata: new Map([[turnId, { turnExecutionPolicyV1: acceptedPolicy }]]),
  });
  const inputs: unknown[][] = [];
  const runtime = {
    prepareInput: async (agent, input) => {
      const prepared = await prepareRunInput(agent, input);
      inputs.push(prepared.input);
      return prepared;
    },
  } as OpenGeniRuntime;
  const trigger = {
    id: crypto.randomUUID(),
    workspaceId,
    sessionId,
    sequence: 1,
    type: "user.message",
    payload: { text: "Continue" },
    occurredAt: "2026-10-12T00:00:00.000Z",
  };
  try {
    const options = {
      turnId,
      providerApi: "responses" as const,
      fileAuthority: { accountId: crypto.randomUUID(), subjectId: null },
      loadActiveHistory: async () => rows,
      servingProviderId: "target",
    };
    await turnInput({} as db.Database, runtime, {}, trigger, options);
    await turnInput({} as db.Database, runtime, {}, trigger, { ...options, recovering: true });
    for (const input of inputs) {
      expect(JSON.stringify(input)).not.toContain("foreign-opaque");
      expect(input.filter((item: any) => item.type === "function_call")).toHaveLength(1);
      expect(input.filter((item: any) => item.type === "function_call_result")).toHaveLength(1);
    }
    expect(rows).toEqual(original);
    expect(provenance).toHaveBeenCalledTimes(2);
    await turnInput({} as db.Database, runtime, {}, trigger, {
      ...options,
      servingProviderId: undefined,
    });
    expect(provenance).toHaveBeenCalledTimes(2);
  } finally {
    updates.mockRestore();
    envelope.mockRestore();
    provenance.mockRestore();
  }
});
