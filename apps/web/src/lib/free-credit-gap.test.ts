import { expect, test } from "bun:test";
import type { PickerModelRow } from "@/lib/model-policy";
import { failedSessionCopy } from "./failed-session-copy";
import {
  coveredModelChoice,
  creditRefusalGap,
  freeCreditGap,
  freeCreditGapReason,
} from "./free-credit-gap";

type Funding = "promotional" | "general" | "unavailable" | undefined;
function row(id: string, label: string, creditFunding: Funding, selectable = true) {
  return { id, label, selectable, catalog: { creditFunding } } as unknown as PickerModelRow;
}
const rows = [
  row("claude-opus", "Claude Opus 5.5", "unavailable"),
  row("claude-sonnet", "Claude Sonnet 5", "unavailable"),
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
const switchCopy =
  "Your free credits don't cover Claude Opus 5.5. Switch to a model they cover, such as GPT-6.1 Sol or GPT-6 Luna, or add credits.";
const continueCopy =
  "Your free credits don't cover Claude Opus 5.5. Send a message to continue with the selected model.";

test("free credit for other models names the gap and the covered models", () => {
  const gap = freeCreditGap(rows, "claude-opus", {
    selectedModel: "claude-opus",
    preferredModel: "azure-sol/gpt-6.1-sol",
  });
  expect(gap).toEqual({
    modelLabel: "Claude Opus 5.5",
    covered: [
      { id: "azure-sol/gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
    ],
    selectionUsable: false,
  });
  const copy = failedSessionCopy(failure, true, false, true, gap);
  expect(copy.reason).toBe(switchCopy);
  expect(copy.reason).not.toMatch(/out of Opengeni credits/);
  expect(freeCreditGapReason({ ...gap!, covered: gap!.covered.slice(1) })).toBe(
    "Your free credits don't cover Claude Opus 5.5. Switch to a model they cover, such as GPT-6 Luna, or add credits.",
  );
});

test("only a selected model that can run counts as recovery", () => {
  for (const selectedModel of ["gpt-6-luna", "connected"]) {
    const gap = freeCreditGap(rows, "claude-opus", { selectedModel })!;
    expect(gap.selectionUsable).toBe(true);
    expect(failedSessionCopy(failure, true, true, true, gap).reason).toBe(continueCopy);
  }
  // Another uncovered model, or an unselectable one, still needs the switch.
  for (const selectedModel of ["claude-sonnet", "hidden-free", "missing-model"]) {
    const gap = freeCreditGap(rows, "claude-opus", { selectedModel })!;
    expect(gap.selectionUsable).toBe(false);
    expect(failedSessionCopy(failure, true, true, true, gap).reason).toBe(
      switchCopy.replace("GPT-6.1 Sol or GPT-6 Luna", "GPT-6 Luna or GPT-6.1 Sol"),
    );
  }
});

test("no usable credit anywhere keeps the out-of-credits copy", () => {
  const empty = rows.map((candidate) =>
    candidate.catalog.creditFunding === "promotional"
      ? row(candidate.id, candidate.label, "unavailable", candidate.selectable)
      : candidate,
  );
  expect(freeCreditGap(empty, "claude-opus")).toBeNull();
  // Only an unselectable model is covered: nothing to switch to.
  expect(freeCreditGap([rows[0]!, rows[4]!], "claude-opus")).toBeNull();
  expect(failedSessionCopy(failure, true, false, true, null).reason).toBe(
    "This workspace is out of Opengeni credits.",
  );
});

test("a model that still has credit, or is not credit-billed, has no gap", () => {
  expect(freeCreditGap(rows, "gpt-6-luna")).toBeNull();
  expect(freeCreditGap([row("argon", "Argon", "general"), rows[2]!], "argon")).toBeNull();
  expect(freeCreditGap(rows, "connected")).toBeNull();
  expect(freeCreditGap(rows, "missing-model")).toBeNull();
});

test("the one-click switch keeps the composer policy sendable", () => {
  const sol = {
    id: "azure-sol/gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    selectable: true,
    catalog: {
      creditFunding: "promotional",
      capabilities: {
        reasoning: { efforts: ["low", "medium", "high"], defaultEffort: "medium" },
        latencyModes: [
          { id: "standard", runnable: true },
          { id: "priority", runnable: true },
        ],
      },
    },
  } as unknown as PickerModelRow;
  // Supported effort and speed carry over.
  expect(coveredModelChoice(sol, "high", "priority")).toEqual({
    model: "azure-sol/gpt-6.1-sol",
    effort: "high",
    latencyMode: null,
  });
  // Unsupported ones fall back to the model default and standard speed.
  expect(coveredModelChoice(sol, "max", "fast")).toEqual({
    model: "azure-sol/gpt-6.1-sol",
    effort: "medium",
    latencyMode: "standard",
  });
  expect(coveredModelChoice({ ...sol, selectable: false }, "high", "standard")).toBeNull();
});

test("a credit refusal names its model even while the catalog still says it is funded", () => {
  // The catalog was read before general credit ran out: Argon still reads "general".
  const stale = [row("vertex-gateway/gemini-4-argon", "Gemini 4 Argon", "general"), ...rows];
  expect(freeCreditGap(stale, "vertex-gateway/gemini-4-argon")).toBeNull();
  expect(
    creditRefusalGap(stale, "vertex-gateway/gemini-4-argon", {
      selectedModel: "vertex-gateway/gemini-4-argon",
      preferredModel: "azure-sol/gpt-6.1-sol",
    }),
  ).toEqual({
    modelLabel: "Gemini 4 Argon",
    covered: [
      { id: "azure-sol/gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
    ],
    selectionUsable: false,
  });
});

test("a credit refusal without covered models still names the model", () => {
  const gap = creditRefusalGap([rows[0]!, rows[5]!], "claude-opus", { selectedModel: "connected" });
  expect(gap).toEqual({ modelLabel: "Claude Opus 5.5", covered: [], selectionUsable: true });
  // A model missing from the catalog falls back to its display name.
  expect(creditRefusalGap([], "gpt-6-sol").modelLabel).toBe("GPT-6 Sol");
});
