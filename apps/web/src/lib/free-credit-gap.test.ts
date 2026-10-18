import { expect, test } from "bun:test";
import type { PickerModelRow } from "@/lib/model-policy";
import { failedSessionCopy } from "./failed-session-copy";
import { freeCreditGap, freeCreditGapReason } from "./free-credit-gap";

type Funding = "promotional" | "general" | "unavailable" | undefined;
function row(id: string, label: string, creditFunding: Funding, selectable = true) {
  return { id, label, selectable, catalog: { creditFunding } } as unknown as PickerModelRow;
}
const rows = [
  row("claude-opus", "Claude Opus 5.5", "unavailable"),
  row("gpt-6-luna", "GPT-6 Luna", "promotional"),
  row("azure-sol/gpt-6.1-sol", "GPT-6.1 Sol", "promotional"),
  row("hidden-free", "Hidden free", "promotional", false),
  row("connected", "Connected", undefined),
];
const failure = {
  reason: "insufficient Opengeni credits",
  failedAt: null,
  consecutiveRecoveryCount: null,
};

test("free credit for other models names the gap and the covered models", () => {
  const gap = freeCreditGap(rows, "claude-opus", "azure-sol/gpt-6.1-sol");
  expect(gap).toEqual({
    modelLabel: "Claude Opus 5.5",
    covered: [
      { id: "azure-sol/gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
    ],
  });
  const copy = failedSessionCopy(failure, true, false, true, gap);
  expect(copy.reason).toBe(
    "Your free credits don't cover Claude Opus 5.5. Switch to a model they cover, such as GPT-6.1 Sol or GPT-6 Luna, or add credits.",
  );
  expect(copy.reason).not.toMatch(/out of Opengeni credits/);
  expect(freeCreditGapReason(gap!, true)).toBe(
    "Your free credits don't cover Claude Opus 5.5. Send a message to continue with the selected model.",
  );
  expect(freeCreditGapReason({ ...gap!, covered: gap!.covered.slice(1) }, false)).toBe(
    "Your free credits don't cover Claude Opus 5.5. Switch to a model they cover, such as GPT-6 Luna, or add credits.",
  );
});

test("no usable credit anywhere keeps the out-of-credits copy", () => {
  const empty = rows.map((candidate) =>
    candidate.catalog.creditFunding === "promotional"
      ? row(candidate.id, candidate.label, "unavailable", candidate.selectable)
      : candidate,
  );
  expect(freeCreditGap(empty, "claude-opus")).toBeNull();
  // Only an unselectable model is covered: nothing to switch to.
  expect(freeCreditGap([rows[0]!, rows[3]!], "claude-opus")).toBeNull();
  expect(failedSessionCopy(failure, true, false, true, null).reason).toBe(
    "This workspace is out of Opengeni credits.",
  );
});

test("a model that still has credit, or is not credit-billed, has no gap", () => {
  expect(freeCreditGap(rows, "gpt-6-luna")).toBeNull();
  expect(freeCreditGap([row("argon", "Argon", "general"), rows[1]!], "argon")).toBeNull();
  expect(freeCreditGap(rows, "connected")).toBeNull();
  expect(freeCreditGap(rows, "missing-model")).toBeNull();
});
