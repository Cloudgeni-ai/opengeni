import { describe, expect, test } from "bun:test";
import { applyCodexHistoryStrip } from "../src/activities/run-input";

// Cross-account encrypted-reasoning strip (multi-account codex, on top of P1):
// a turn must NEVER replay reasoning.encrypted_content minted by a DIFFERENT
// codex account than the one it runs on. applyCodexHistoryStrip is the read-path
// selector — it drops the opaque blob from items whose producer != the turn's
// current codex account, while preserving ALL message content.

const reasoningRow = (producer: string | null, blob: string) => ({
  producerCodexCredentialId: producer,
  item: {
    type: "reasoning",
    summary: [{ type: "summary_text", text: `cot-${blob}` }],
    providerData: { encrypted_content: blob },
  } as Record<string, unknown>,
});

const messageRow = (producer: string | null, text: string) => ({
  producerCodexCredentialId: producer,
  item: {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  } as Record<string, unknown>,
});

const encOf = (item: Record<string, unknown>) =>
  (item.providerData as { encrypted_content?: string } | undefined)?.encrypted_content;

describe("applyCodexHistoryStrip", () => {
  test("cross-account: a turn on B strips A-minted encrypted reasoning, keeps B's", () => {
    const rows = [
      reasoningRow("A", "blob-A"),
      messageRow("A", "A said hi"),
      reasoningRow("B", "blob-B"),
      messageRow("B", "B said hi"),
    ];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: "B" });
    // A's encrypted reasoning is gone…
    expect(encOf(out[0])).toBeUndefined();
    // …B's (the current account's) reasoning is preserved.
    expect(encOf(out[2])).toBe("blob-B");
    // Every message's content survives verbatim.
    expect((out[1].content as any)[0].text).toBe("A said hi");
    expect((out[3].content as any)[0].text).toBe("B said hi");
    // The visible reasoning text (summary) survives even where the blob was dropped.
    expect((out[0].summary as any)[0].text).toBe("cot-blob-A");
  });

  test("same-account: nothing is stripped (continuity preserved, rows by reference)", () => {
    const rows = [reasoningRow("A", "blob-A"), messageRow("A", "hi")];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: "A" });
    expect(encOf(out[0])).toBe("blob-A");
    // Untouched rows pass through by reference (byte-identical replay).
    expect(out[0]).toBe(rows[0].item);
    expect(out[1]).toBe(rows[1].item);
  });

  test("non-codex turn (codexStrip null): every item is untouched, by reference", () => {
    const rows = [reasoningRow("A", "blob-A"), reasoningRow(null, "azure-blob")];
    const out = applyCodexHistoryStrip(rows, null);
    expect(encOf(out[0])).toBe("blob-A");
    expect(encOf(out[1])).toBe("azure-blob");
    expect(out[0]).toBe(rows[0].item);
    expect(out[1]).toBe(rows[1].item);
  });

  test("non-codex/legacy producer (null) is stripped on a codex turn — defensive", () => {
    // Azure-produced or pre-column rows carry producer=null; replaying their
    // (foreign / unknown-origin) blob to a codex account would 400.
    const rows = [reasoningRow(null, "azure-or-legacy-blob"), messageRow(null, "content stays")];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: "A" });
    expect(encOf(out[0])).toBeUndefined();
    // Message content is never dropped.
    expect((out[1].content as any)[0].text).toBe("content stays");
  });

  test("message content is preserved across a switch even when its producer mismatches", () => {
    const rows = [messageRow("A", "important user-visible answer")];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: "B" });
    // A message has no encrypted reasoning to strip, so it passes through intact.
    expect(out[0]).toBe(rows[0].item);
    expect((out[0].content as any)[0].text).toBe("important user-visible answer");
  });
});
