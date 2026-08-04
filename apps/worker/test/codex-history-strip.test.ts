import { describe, expect, test } from "bun:test";
import { projectRejectedProviderArtifacts, resumeRunState } from "../src/activities/run-input";
import {
  historyRowsToAppend,
  selectRejectedProviderArtifactHistoryIds,
} from "../src/activities/agent-turn";
import { opaqueProviderArtifactFingerprint } from "@opengeni/codex";

const reasoning = (id = "rs_1") => ({
  type: "reasoning",
  id,
  content: [{ type: "input_text", text: "durable reasoning summary" }],
  providerData: { encrypted_content: `opaque-${id}` },
});

const message = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

const toolSearchPair = () => [
  {
    type: "tool_search_call",
    call_id: "search-1",
    status: "completed",
    execution: "client",
    arguments: { query: "mail" },
  },
  {
    type: "tool_search_output",
    call_id: "search-1",
    status: "completed",
    execution: "client",
    tools: [{ type: "function", name: "codex_apps__gmail_search" }],
  },
];

describe("projectRejectedProviderArtifacts", () => {
  test("ordinary replay keeps every canonical row by reference", () => {
    const items = [reasoning(), message("answer"), ...toolSearchPair()];
    const rows = items.map((item) => ({ item }));
    const projected = projectRejectedProviderArtifacts(rows);

    expect(projected).toEqual(items);
    projected.forEach((item, index) => expect(item).toBe(items[index]));
  });

  test("provider rejection preserves reasoning content while removing rejected identity", () => {
    const rejectedAt = new Date("2026-08-04T00:00:00.000Z");
    const keptMessage = message("durable answer");
    const [searchCall, searchOutput] = toolSearchPair();
    const projected = projectRejectedProviderArtifacts([
      { item: reasoning("rs_rejected"), providerArtifactInvalidatedAt: rejectedAt },
      {
        item: { type: "compaction", encrypted_content: "opaque-compaction" },
        providerArtifactInvalidatedAt: rejectedAt,
      },
      { item: keptMessage, providerArtifactInvalidatedAt: rejectedAt },
      { item: searchCall!, providerArtifactInvalidatedAt: rejectedAt },
      { item: searchOutput!, providerArtifactInvalidatedAt: rejectedAt },
    ]);

    expect(projected).toHaveLength(4);
    expect(projected[0]).toEqual({
      type: "reasoning",
      content: [{ type: "input_text", text: "durable reasoning summary" }],
    });
    expect(projected.slice(1)).toEqual([keptMessage, searchCall, searchOutput]);
    expect((projected[2] as { execution: string }).execution).toBe("client");
    expect((projected[3] as { execution: string }).execution).toBe("client");
  });
});

describe("resumeRunState", () => {
  const serialized = () =>
    JSON.stringify({
      $schemaVersion: "1.12",
      originalInput: [
        reasoning("rs_original"),
        { type: "compaction", encrypted_content: "opaque-compaction", summary: "summary" },
        ...toolSearchPair(),
        { type: "message", role: "user", content: "question" },
      ],
      modelResponses: [],
      generatedItems: [],
    });

  test("ordinary resume returns the exact durable RunState string", () => {
    const value = serialized();
    expect(resumeRunState({ serializedRunState: value })).toBe(value);
  });

  test("explicit rejection builds a temporary recovery view without rewriting tool_search", () => {
    const value = serialized();
    const projected = resumeRunState({
      serializedRunState: value,
      providerArtifactInvalidatedAt: new Date("2026-08-04T00:00:00.000Z"),
    });
    const parsed = JSON.parse(projected) as {
      originalInput: Array<Record<string, unknown>>;
    };

    expect(projected).not.toContain("rs_original");
    expect(projected).not.toContain("opaque-rs_original");
    expect(projected).not.toContain("opaque-compaction");
    expect(parsed.originalInput.some((item) => item.type === "compaction")).toBe(false);
    const searches = parsed.originalInput.filter((item) =>
      String(item.type).startsWith("tool_search_"),
    );
    expect(searches).toHaveLength(2);
    expect(searches.map((item) => item.execution)).toEqual(["client", "client"]);

    // Durable input remains byte-for-byte untouched.
    expect(value).toContain("rs_original");
    expect(value).toContain("opaque-compaction");
  });
});

describe("history reconciliation", () => {
  test("historical tool_search is treated as an ordinary persisted fact", () => {
    const existing = [message("old"), ...toolSearchPair()];
    const fresh = message("new");
    const reconciled = historyRowsToAppend([...existing, fresh], existing.length, 40);

    expect(reconciled.rows).toEqual([{ position: 40, item: fresh }]);
    expect((existing[1] as { execution: string }).execution).toBe("client");
    expect((existing[2] as { execution: string }).execution).toBe("client");
  });

  test("a pre-existing opaque row omitted from the model view cannot authorize recovery", () => {
    const omitted = reasoning("rs-omitted");
    const retained = reasoning("rs-retained");
    const selected = selectRejectedProviderArtifactHistoryIds(
      [
        { id: "row-omitted", item: omitted, providerArtifactInvalidatedAt: null },
        { id: "row-retained", item: retained, providerArtifactInvalidatedAt: null },
      ],
      {
        knownHistoryItemIds: ["row-omitted", "row-retained"],
        historyItemIds: ["row-retained"],
      },
      [opaqueProviderArtifactFingerprint(omitted)!, opaqueProviderArtifactFingerprint(retained)!],
    );

    expect(selected).toEqual(["row-retained"]);
  });
});
