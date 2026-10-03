import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { prepareRunInput, type OpenGeniRuntime } from "@opengeni/runtime";
import { foreignProviderArtifactRowIds, turnInput } from "../src/activities/run-input";

const workspaceId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const azureTurn = crypto.randomUUID();
const gatewayTurn = crypto.randomUUID();
const legacyTurn = crypto.randomUUID();
const currentTurn = crypto.randomUUID();

function reasoning(id: string, encryptedContent: string) {
  return {
    type: "reasoning",
    id,
    content: [],
    providerData: {
      summary: [{ type: "summary_text", text: `${id} summary` }],
      encrypted_content: encryptedContent,
    },
  };
}

const rows = [
  { turnId: azureTurn, item: { type: "message", role: "user", content: "first" } },
  { turnId: azureTurn, item: reasoning("rs_azure", "azure-minted") },
  { turnId: azureTurn, item: { type: "message", role: "assistant", content: "azure answer" } },
  { turnId: legacyTurn, item: reasoning("rs_legacy", "legacy-minted") },
  { turnId: null, item: reasoning("rs_unowned", "unowned-minted") },
  { turnId: gatewayTurn, item: reasoning("rs_gateway", "gateway-minted") },
  { turnId: gatewayTurn, item: { type: "message", role: "assistant", content: "gateway answer" } },
].map((row, position) => ({
  id: crypto.randomUUID(),
  position,
  providerArtifactInvalidatedAt: null,
  ...row,
}));

// Legacy turns have no frozen policy, so they are absent from the lookup.
const turnProviders = new Map([
  [azureTurn, "azure"],
  [gatewayTurn, "opengeni-gateway"],
]);

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function preparedHistory(opaqueArtifactProviderId: string | undefined) {
  spies.push(
    spyOn(db, "listSessionSystemUpdatesForTurn").mockResolvedValue([]),
    spyOn(db, "getActiveSessionHistoryItemsPaged").mockResolvedValue(rows),
    spyOn(db, "getSandboxSessionEnvelope").mockResolvedValue(null),
  );
  const lookups: string[][] = [];
  const prepared: unknown[] = [];
  const runtime = {
    prepareInput: async (agent, input) => {
      const result = await prepareRunInput(agent, input);
      prepared.push(result.input);
      return result;
    },
  } as OpenGeniRuntime;
  const result = await turnInput(
    {} as db.Database,
    runtime,
    {},
    {
      id: crypto.randomUUID(),
      workspaceId,
      sessionId,
      sequence: 9,
      type: "user.message",
      payload: { text: "continue" },
      occurredAt: "2026-10-05T00:00:00.000Z",
    },
    {
      turnId: currentTurn,
      providerApi: "responses",
      fileAuthority: { accountId: crypto.randomUUID(), subjectId: "user:test" },
      ...(opaqueArtifactProviderId ? { opaqueArtifactProviderId } : {}),
      loadTurnProviderIds: async (_db, scopeWorkspaceId, scopeSessionId, turnIds) => {
        expect([scopeWorkspaceId, scopeSessionId]).toEqual([workspaceId, sessionId]);
        lookups.push([...turnIds]);
        return new Map([...turnProviders].filter(([turnId]) => turnIds.includes(turnId)));
      },
    },
  );
  const reasoningItems = (prepared[0] as Array<Record<string, unknown>>).filter(
    (item) => item.type === "reasoning",
  );
  return { result, lookups, reasoningItems };
}

function encrypted(item: Record<string, unknown>): unknown {
  const providerData = item.providerData as Record<string, unknown> | undefined;
  return item.encrypted_content ?? providerData?.encrypted_content;
}

describe("opaque artifacts minted by another provider", () => {
  test("a turn on the Gateway fallback never replays Azure-minted encrypted reasoning", async () => {
    const { result, lookups, reasoningItems } = await preparedHistory("opengeni-gateway");
    expect(lookups).toHaveLength(1);
    expect(new Set(lookups[0])).toEqual(new Set([azureTurn, legacyTurn, gatewayTurn]));
    expect(reasoningItems.map(encrypted)).toEqual([
      undefined, // Azure turn: provider-bound content removed, summary kept
      "legacy-minted", // no frozen policy: unchanged behavior
      "unowned-minted", // no producing turn: unchanged behavior
      "gateway-minted", // same provider: reasoning continuity kept
    ]);
    const azureReasoning = reasoningItems[0]!;
    expect(azureReasoning.id).toBeUndefined();
    expect(JSON.stringify(azureReasoning)).toContain("rs_azure summary");
    // A removed artifact is not a candidate for provider-rejection recovery.
    const azureRow = rows.find((row) => row.item.id === "rs_azure")!;
    expect(result.providerArtifactCandidates.historyItemIds).not.toContain(azureRow.id);
    // Durable rows are untouched.
    expect(azureRow.item.providerData.encrypted_content).toBe("azure-minted");
  });

  test("switching back to Azure drops Gateway-minted reasoning the same way", async () => {
    const { reasoningItems } = await preparedHistory("azure");
    expect(reasoningItems.map(encrypted)).toEqual([
      "azure-minted",
      "legacy-minted",
      "unowned-minted",
      undefined,
    ]);
  });

  test("callers without a provider (Codex) keep exact replay and do no lookup", async () => {
    const { lookups, reasoningItems } = await preparedHistory(undefined);
    expect(lookups).toEqual([]);
    expect(reasoningItems.map(encrypted)).toEqual([
      "azure-minted",
      "legacy-minted",
      "unowned-minted",
      "gateway-minted",
    ]);
  });

  test("rows already invalidated or without opaque content are not looked up", async () => {
    const lookups: string[][] = [];
    const selected = await foreignProviderArtifactRowIds(
      {} as db.Database,
      { workspaceId, sessionId },
      [
        { id: "a", turnId: azureTurn, item: { type: "message", role: "user", content: "x" } },
        {
          id: "b",
          turnId: azureTurn,
          item: reasoning("rs_b", "azure-minted"),
          providerArtifactInvalidatedAt: new Date(),
        },
      ],
      "opengeni-gateway",
      async (_db, _workspaceId, _sessionId, turnIds) => {
        lookups.push([...turnIds]);
        return new Map();
      },
    );
    expect(selected.size).toBe(0);
    expect(lookups).toEqual([]);
  });
});
