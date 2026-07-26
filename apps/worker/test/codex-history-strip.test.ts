import { describe, expect, test } from "bun:test";
import { sanitizeHistoryItemsForModel } from "@opengeni/runtime";
import { applyCodexHistoryStrip, resumeRunStateForCodexAccount } from "../src/activities/run-input";
import { historyRowsToAppend, reconcileSeedCount } from "../src/activities/agent-turn";

// Cross-account reasoning strip (multi-account codex, on top of P1, hardened by
// the verify holes A/B/C): a turn must NEVER replay reasoning produced by a
// DIFFERENT codex account than the one it runs on. The single rule across every
// read path: DROP any reasoning item whose producing codex account differs from
// the turn's current codex account (current = the resolved codex credential id on
// a codex turn, or null on a non-codex turn). A FOREIGN reasoning item is dropped
// WHOLE (id + blob), because the Responses backend validates the foreign rs_ id
// and rejects it under store:false once the encrypted_content is gone. All
// message/tool content is preserved.

const reasoningRow = (producer: string | null, blob: string, id = `rs_${blob}`) => ({
  producerCodexCredentialId: producer,
  item: {
    type: "reasoning",
    id,
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

const toolCallRow = (producer: string | null, callId: string) => ({
  producerCodexCredentialId: producer,
  item: { type: "function_call", callId, name: "do_it", arguments: "{}" } as Record<
    string,
    unknown
  >,
});

const toolSearchCallRow = (producer: string | null, callId: string) => ({
  producerCodexCredentialId: producer,
  item: {
    type: "tool_search_call",
    call_id: callId,
    status: "completed",
    execution: "client",
    arguments: { query: "send email" },
  } as Record<string, unknown>,
});

const toolSearchOutputRow = (producer: string | null, callId: string) => ({
  producerCodexCredentialId: producer,
  item: {
    type: "tool_search_output",
    call_id: callId,
    status: "completed",
    execution: "client",
    tools: [{ type: "function", name: "codex_apps__gmail_send_email" }],
  } as Record<string, unknown>,
});

describe("applyCodexHistoryStrip", () => {
  test("cross-account: a turn on B DROPS A-minted reasoning whole, keeps B's and all messages", () => {
    const rows = [
      reasoningRow("A", "blob-A"),
      messageRow("A", "A said hi"),
      reasoningRow("B", "blob-B"),
      messageRow("B", "B said hi"),
    ];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: "B" });
    // A's reasoning item is gone ENTIRELY (id + blob) — not just blanked.
    expect(out).toHaveLength(3);
    expect(out.some((item) => item.type === "reasoning" && (item as any).id === "rs_blob-A")).toBe(
      false,
    );
    // B's (the current account's) reasoning survives untouched, blob intact.
    const bReasoning = out.find((item) => item.type === "reasoning") as any;
    expect(bReasoning.id).toBe("rs_blob-B");
    expect(bReasoning.providerData.encrypted_content).toBe("blob-B");
    // Every message's content survives verbatim, in order.
    const messages = out.filter((item) => item.type === "message") as any[];
    expect(messages.map((m) => m.content[0].text)).toEqual(["A said hi", "B said hi"]);
  });

  test("foreign reasoning item is fully dropped — its id leaves the history", () => {
    const rows = [reasoningRow("A", "blob-A", "rs_foreign"), messageRow("A", "kept")];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: "B" });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("message");
    // Prove the foreign rs_ id is nowhere in the output (the HOLE A vector).
    expect(JSON.stringify(out)).not.toContain("rs_foreign");
  });

  test("same-account: nothing is stripped (continuity preserved, rows by reference)", () => {
    const rows = [reasoningRow("A", "blob-A"), messageRow("A", "hi")];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: "A" });
    expect(out).toHaveLength(2);
    // Untouched rows pass through by reference (byte-identical replay).
    expect(out[0]).toBe(rows[0].item);
    expect(out[1]).toBe(rows[1].item);
  });

  test("HOLE B — codex→non-codex: a non-codex turn (current=null) DROPS codex-produced reasoning", () => {
    // Before the fix this no-op'd, replaying codex-minted encrypted reasoning into
    // the Azure/built-in Responses call (which any responses provider 400s).
    const rows = [
      reasoningRow("A", "codex-blob"),
      reasoningRow(null, "azure-blob"),
      messageRow("A", "answer"),
    ];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: null });
    // The codex-produced reasoning (producer != null) is dropped…
    expect(out.some((item) => (item as any).id === "rs_codex-blob")).toBe(false);
    // …the non-codex reasoning (producer == null == current) survives by reference…
    expect(out).toContain(rows[1].item);
    // …and the message content is preserved.
    expect(out.some((item) => item.type === "message")).toBe(true);
  });

  test("non-codex turn with NO codex history is a no-op (every item by reference)", () => {
    const rows = [reasoningRow(null, "azure-blob"), messageRow(null, "hi")];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: null });
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(rows[0].item);
    expect(out[1]).toBe(rows[1].item);
  });

  test("foreign tool call / message content is always preserved (only reasoning is dropped)", () => {
    const rows = [
      messageRow("A", "important user-visible answer"),
      toolCallRow("A", "call_1"),
      reasoningRow("A", "blob-A"),
    ];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: "B" });
    // The foreign message + tool call survive by reference; only reasoning drops.
    expect(out).toEqual([rows[0].item, rows[1].item]);
    expect(out[0]).toBe(rows[0].item);
    expect(out[1]).toBe(rows[1].item);
  });

  test("foreign compaction summary is kept; only its encrypted_content blob is stripped", () => {
    const rows = [
      {
        producerCodexCredentialId: "A",
        item: {
          type: "compaction",
          encrypted_content: "comp-blob",
          summary: "the story so far",
        } as Record<string, unknown>,
      },
    ];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: "B" });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("compaction");
    expect("encrypted_content" in out[0]).toBe(false);
    // The summary (real conversation content) survives.
    expect(out[0].summary).toBe("the story so far");
  });
});

// HOLE C — the run-state REPLAY paths (approval resume + items-mode run-state
// fallback). The blob carries no per-item producer tag, so the worker records the
// FREEZING codex account on the run-state row and resumeRunStateForCodexAccount
// neutralizes the blob's reasoning identity when the resuming turn's account
// differs (else replays the blob byte-for-byte by reference).
describe("resumeRunStateForCodexAccount", () => {
  const blobWithReasoning = (accountTag: string) =>
    JSON.stringify({
      $schemaVersion: "1.12",
      originalInput: [
        {
          type: "reasoning",
          id: `rs_${accountTag}_orig`,
          content: [{ type: "input_text", text: "t" }],
          providerData: { encrypted_content: `enc-${accountTag}-orig` },
        },
        { type: "message", role: "user", content: "hi" },
      ],
      modelResponses: [
        {
          output: [
            {
              type: "reasoning",
              id: `rs_${accountTag}_resp`,
              content: [],
              providerData: { encrypted_content: `enc-${accountTag}-resp` },
            },
          ],
        },
      ],
      generatedItems: [
        {
          type: "reasoning_item",
          rawItem: {
            type: "reasoning",
            id: `rs_${accountTag}_gen`,
            content: [],
            providerData: { encrypted_content: `enc-${accountTag}-gen` },
          },
        },
        {
          type: "message_output_item",
          rawItem: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        },
      ],
    });

  test("cross-account resume strips every reasoning item's id + encrypted_content from the blob", () => {
    const out = resumeRunStateForCodexAccount(
      { serializedRunState: blobWithReasoning("A"), frozenCodexCredentialId: "A" },
      { currentCodexCredentialId: "B" },
    );
    // No encrypted reasoning blob and no foreign rs_ id survive anywhere…
    expect(out).not.toContain("enc-A-orig");
    expect(out).not.toContain("enc-A-resp");
    expect(out).not.toContain("enc-A-gen");
    expect(out).not.toContain("rs_A_orig");
    expect(out).not.toContain("rs_A_resp");
    expect(out).not.toContain("rs_A_gen");
    // …while message content is preserved.
    expect(out).toContain("answer");
  });

  test("codex→non-codex resume (current=null) also strips the codex-frozen reasoning", () => {
    const out = resumeRunStateForCodexAccount(
      { serializedRunState: blobWithReasoning("A"), frozenCodexCredentialId: "A" },
      { currentCodexCredentialId: null },
    );
    expect(out).not.toContain("enc-A-gen");
    expect(out).not.toContain("rs_A_gen");
  });

  test("same-account resume replays the blob byte-for-byte (same string reference)", () => {
    const blob = blobWithReasoning("A");
    const out = resumeRunStateForCodexAccount(
      { serializedRunState: blob, frozenCodexCredentialId: "A" },
      { currentCodexCredentialId: "A" },
    );
    expect(out).toBe(blob);
  });

  test("non-codex freeze + non-codex resume (null == null) is a byte-for-byte no-op", () => {
    const blob = blobWithReasoning("A");
    const out = resumeRunStateForCodexAccount(
      { serializedRunState: blob, frozenCodexCredentialId: null },
      { currentCodexCredentialId: null },
    );
    expect(out).toBe(blob);
  });
});

// HOLE D + HOLE E — the reconcile watermark (`reconcileSeedCount`) must be seeded
// from EXACTLY the view `state.history` was seeded from, so the model-input length
// and the watermark can NEVER disagree. The strip drops foreign reasoning items, so
// the seed is PATH-DEPENDENT (the `modelHistoryFromItems` flag run-input returns):
//   - items read path  (model from STRIPPED items)        → seed applies the strip (D).
//   - run-state blob path (model from neutralize-KEPT blob) → seed must NOT strip (E).
// These exercise the REAL exported reconcileSeedCount + applyCodexHistoryStrip +
// sanitizeHistoryItemsForModel + historyRowsToAppend (no re-implementation).
describe("cross-account reconcile-seed consistency (reconcileSeedCount)", () => {
  // The exact length the model-input pipeline (run-input.ts → prepareRunInput)
  // produces on the ITEMS read path: sanitize(strip(active items)).
  const itemsPathModelLen = (
    rows: ReturnType<typeof messageRow>[],
    current: { currentCodexCredentialId: string | null },
  ) => sanitizeHistoryItemsForModel(applyCodexHistoryStrip(rows, current)).length;

  test("HOLE D — items path: reconcile-seed equals the stripped model-input length and is strictly less than the un-stripped count", () => {
    // A cross-account switch to B over a history holding ≥1 A-minted reasoning item.
    const activeRows = [
      messageRow("A", "u1"),
      reasoningRow("A", "blob-A"), // foreign on a B turn → dropped from the model AND the seed
      messageRow("A", "a1"),
      reasoningRow("B", "blob-B"), // B's own reasoning → kept
    ];
    const current = { currentCodexCredentialId: "B" };

    // The REAL seed the worker computes this turn (modelHistoryFromItems = true).
    const strippedSeed = reconcileSeedCount(activeRows, true, current);
    // The OLD (pre-HOLE-D) seed: the un-stripped sanitized active count. This is
    // exactly what the blob-path branch (modelHistoryFromItems = false) still yields.
    const unstrippedCount = reconcileSeedCount(activeRows, false, current);

    // The model-input length THIS turn is seeded from (prepareRunInput sanitizes the
    // stripped items): the watermark and state.history's starting length agree.
    expect(strippedSeed).toBe(itemsPathModelLen(activeRows, current));

    // ≥1 foreign reasoning item was dropped, so the stripped seed is STRICTLY less
    // than the un-stripped count. Before HOLE D the seed WAS the un-stripped count.
    expect(strippedSeed).toBe(3);
    expect(unstrippedCount).toBe(4);
    expect(strippedSeed).toBeLessThan(unstrippedCount);

    // Drive the live reconcile with the OLD vs FIXED seed. state.history this turn =
    // the stripped prior history (3 items) + the user's switch-turn message + reply.
    const stateHistory = [
      messageRow("A", "u1").item,
      messageRow("A", "a1").item,
      {
        type: "reasoning",
        id: "rs_blob-B",
        summary: [{ type: "summary_text", text: "cot-blob-B" }],
        providerData: { encrypted_content: "blob-B" },
      },
      messageRow("B", "switch-turn message").item,
      messageRow("B", "reply").item,
    ];
    // OLD seed (4): slices past the genuinely-new switch-turn message — it is SILENTLY
    // LOST (the exact HOLE D failure).
    const old = historyRowsToAppend(stateHistory, unstrippedCount);
    expect(old.rows.map((row) => row.item)).not.toContainEqual(
      messageRow("B", "switch-turn message").item,
    );
    // FIXED seed (3): the slice begins exactly at the first genuinely-new item; the
    // user's message and the reply are both persisted.
    const fixed = historyRowsToAppend(stateHistory, strippedSeed);
    expect(fixed.rows.map((row) => row.item)).toEqual([
      messageRow("B", "switch-turn message").item,
      messageRow("B", "reply").item,
    ]);
  });

  test("HOLE E — blob path (approval resume): the seed must NOT strip, else the reconcile re-appends already-persisted items at fresh positions", () => {
    // Active rows persisted by the requires_action pause (producer A), incl. an
    // A-minted reasoning item. A B turn resumes the approval.
    const activeRows = [
      messageRow("A", "u1"),
      reasoningRow("A", "blob-A"), // foreign on the resuming B turn
      messageRow("A", "a1"),
    ];
    const current = { currentCodexCredentialId: "B" };

    // The model on the approval path is seeded from the run-state BLOB, where the
    // A reasoning is NEUTRALIZED-IN-PLACE (id/encrypted_content gone) but the item is
    // KEPT — so state.history's completed prefix still has all 3 items. Plus the
    // post-approval reply this turn generated.
    const blobStateHistory = [
      messageRow("A", "u1").item,
      { type: "reasoning", summary: [{ type: "summary_text", text: "cot-blob-A" }] }, // neutralized, KEPT
      messageRow("A", "a1").item,
      messageRow("B", "answer after approval").item, // genuinely new this turn
    ];

    // The REAL seeds: blob path (modelHistoryFromItems = false) vs the WRONG strip.
    const blobSeed = reconcileSeedCount(activeRows, false, current);
    const strippedSeed = reconcileSeedCount(activeRows, true, current);
    expect(blobSeed).toBe(3); // matches the blob's 3-item completed prefix
    expect(strippedSeed).toBe(2); // the bug: under-counts by K=1 (drops the kept reasoning)

    // FIXED seed (3): the reconcile appends ONLY the genuinely-new post-approval reply.
    const fixed = historyRowsToAppend(blobStateHistory, blobSeed);
    expect(fixed.rows.map((row) => row.item)).toEqual([
      messageRow("B", "answer after approval").item,
    ]);

    // WRONG seed (2, the unconditional strip): the reconcile RE-APPENDS the already-
    // persisted "a1" message at a fresh position — the HOLE E duplication the fix avoids.
    const buggy = historyRowsToAppend(blobStateHistory, strippedSeed);
    expect(buggy.rows.map((row) => row.item)).toContainEqual(messageRow("A", "a1").item);
    expect(buggy.rows.length).toBeGreaterThan(fixed.rows.length);
  });

  test("no-op invariant: same-account and non-codex turns seed identically on BOTH paths (strip is a no-op)", () => {
    const sameAccountRows = [
      messageRow("A", "u1"),
      reasoningRow("A", "blob-A"),
      messageRow("A", "a1"),
    ];
    // Same-account (current == producer A): items-path seed == blob-path seed.
    expect(reconcileSeedCount(sameAccountRows, true, { currentCodexCredentialId: "A" })).toBe(
      reconcileSeedCount(sameAccountRows, false, { currentCodexCredentialId: "A" }),
    );
    // Non-codex over a no-codex history (every producer null == current null): identical.
    const nonCodexRows = [
      messageRow(null, "u1"),
      reasoningRow(null, "azure-blob"),
      messageRow(null, "a1"),
    ];
    expect(reconcileSeedCount(nonCodexRows, true, { currentCodexCredentialId: null })).toBe(
      reconcileSeedCount(nonCodexRows, false, { currentCodexCredentialId: null }),
    );
  });
});

describe("applyCodexHistoryStrip: tool_search items (progressive connector disclosure)", () => {
  test("cross-account: a turn on B drops A-minted tool_search_call AND tool_search_output whole", () => {
    const rows = [
      messageRow("A", "checking mail"),
      toolSearchCallRow("A", "tsA"),
      toolSearchOutputRow("A", "tsA"),
      messageRow("B", "later"),
    ];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: "B" });
    expect(out.map((i) => i.type)).toEqual(["message", "message"]);
  });

  test("same-account tool_search pair replays verbatim (by reference)", () => {
    const rows = [toolSearchCallRow("B", "tsB"), toolSearchOutputRow("B", "tsB")];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: "B" });
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(rows[0]!.item);
    expect(out[1]).toBe(rows[1]!.item);
  });

  test("a non-codex turn (current=null) drops codex-produced tool_search items", () => {
    const rows = [
      toolSearchCallRow("A", "tsA"),
      toolSearchOutputRow("A", "tsA"),
      messageRow(null, "plain"),
    ];
    const out = applyCodexHistoryStrip(rows, { currentCodexCredentialId: null });
    expect(out.map((i) => i.type)).toEqual(["message"]);
  });

  test("a HALF-foreign pair (mixed producers) never leaves a stranded half after the downstream sanitizer", () => {
    // Pathological: the call was A-minted, the output B-minted (should not occur,
    // but rotation edge cases are exactly where invariants die). The strip drops
    // A's call; the downstream history sanitizer must then drop B's now-orphaned
    // output so the replay cannot 400.
    const rows = [
      toolSearchCallRow("A", "tsX"),
      toolSearchOutputRow("B", "tsX"),
      messageRow("B", "hi"),
    ];
    const stripped = applyCodexHistoryStrip(rows, { currentCodexCredentialId: "B" });
    expect(stripped.map((i) => i.type)).toEqual(["tool_search_output", "message"]);
    const sanitized = sanitizeHistoryItemsForModel(stripped);
    expect(sanitized.map((i) => i.type)).toEqual(["message"]);
  });
});
