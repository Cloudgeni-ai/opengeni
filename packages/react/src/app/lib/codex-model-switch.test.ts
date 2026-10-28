import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";

import {
  codexUsageContinueAtResetAction,
  codexUsageContinuesAtReset,
  codexUsageResetText,
  codexUsageResetsAt,
  latestCheckpointIsCompaction,
  modelSwitchHeadsUpText,
  needsModelSwitchHeadsUp,
} from "./codex-model-switch";

const event = (type: string, sequence: number) => ({ type, sequence }) as unknown as SessionEvent;

describe("Codex model switch heads-up", () => {
  test("the newest context checkpoint decides whether Codex compacted the chat", () => {
    expect(latestCheckpointIsCompaction([event("user.message", 1)])).toBeNull();
    expect(
      latestCheckpointIsCompaction([
        event("session.context.cleared", 1),
        event("session.context.compacted", 2),
        event("agent.message.completed", 3),
      ]),
    ).toBe(true);
    // Clearing the context after a compaction leaves nothing Codex-only to rebuild.
    expect(
      latestCheckpointIsCompaction([
        event("session.context.compacted", 1),
        event("session.context.cleared", 2),
      ]),
    ).toBe(false);
    // A newest-first page answers the same.
    expect(
      latestCheckpointIsCompaction([
        event("session.context.cleared", 9),
        event("session.context.compacted", 4),
      ]),
    ).toBe(false);
  });

  test("only a chat Codex compacted, switching to another provider, gets the line", () => {
    const compacted = { codexCompactionMode: "remote_v2" as const, codexCompacted: true };
    expect(needsModelSwitchHeadsUp({ ...compacted, model: "anthropic/claude-opus-5.5" })).toBe(
      true,
    );
    // Staying on Codex keeps Codex's own memory of the chat.
    expect(needsModelSwitchHeadsUp({ ...compacted, model: "codex/gpt-5.5" })).toBe(false);
    // No Codex compaction yet: the switch has nothing to rebuild.
    expect(
      needsModelSwitchHeadsUp({ ...compacted, codexCompacted: false, model: "openai/gpt-6" }),
    ).toBe(false);
    // Portable chats already keep a summary any model can read.
    expect(
      needsModelSwitchHeadsUp({
        ...compacted,
        codexCompactionMode: "portable",
        model: "openai/gpt-6",
      }),
    ).toBe(false);
    expect(needsModelSwitchHeadsUp({ ...compacted, model: null })).toBe(false);
  });

  test("the line names the model in plain words", () => {
    expect(modelSwitchHeadsUpText("Claude Opus 5.5")).toBe(
      "Earlier messages will be re-summarized for Claude Opus 5.5, so it may remember less detail.",
    );
  });
});

describe("Codex usage limit reset", () => {
  const usage = (type: string, sequence: number, payload: Record<string, unknown>) =>
    ({ type, sequence, payload }) as unknown as SessionEvent;

  test("the newest usage-limit event names the reset", () => {
    const failed = usage("turn.failed", 4, {
      code: "codex_usage_limit_reached",
      resetsAt: "2026-10-31T13:05:00.000Z",
    });
    const waiting = usage("codex.capacity.waiting", 7, { resetsAt: "2026-10-31T14:05:00.000Z" });
    expect(codexUsageResetsAt([failed])).toBe("2026-10-31T13:05:00.000Z");
    expect(codexUsageResetsAt([waiting, failed])).toBe("2026-10-31T14:05:00.000Z");
    // Other failures and a wait without a known reset name none.
    expect(
      codexUsageResetsAt([usage("turn.failed", 9, { resetsAt: "2026-10-31T15:05:00Z" })]),
    ).toBe(null);
    expect(codexUsageResetsAt([failed, usage("codex.capacity.waiting", 8, {})])).toBe(null);
    expect(codexUsageResetsAt([])).toBe(null);
  });

  test("the reset reads as a plain time, or says it is unknown", () => {
    const now = new Date("2026-10-28T09:00:00.000Z");
    const at = { now, locale: "en-GB", timeZone: "UTC" };
    expect(codexUsageResetText(null, at)).toBe("Reset time unknown.");
    expect(codexUsageResetText("not a time", at)).toBe("Reset time unknown.");
    expect(codexUsageResetText("2026-10-28T08:00:00.000Z", at)).toBe("Resets soon.");
    expect(codexUsageResetText("2026-10-28T14:05:00.000Z", at)).toBe("Resets at 14:05.");
    expect(codexUsageResetText("2026-10-31T14:05:00.000Z", at)).toBe("Resets Sat 14:05.");
    expect(codexUsageResetText("2026-11-12T14:05:00.000Z", at)).toBe("Resets 12 Nov 14:05.");
  });
});

describe("Continue at reset", () => {
  test("a refused Codex turn waits and continues at the reset unless the chat is paused", () => {
    expect(codexUsageContinuesAtReset({ status: "waiting_capacity", paused: false })).toBe(true);
    expect(codexUsageContinuesAtReset({ status: "waiting_capacity", paused: true })).toBe(false);
    // A chat the limit stopped is not waiting.
    expect(codexUsageContinuesAtReset({ status: "idle", paused: false })).toBe(false);
    expect(codexUsageContinuesAtReset({ status: "failed", paused: false })).toBe(false);
  });

  test("switching it pauses or resumes the wait, or runs a stopped chat again on Codex", () => {
    const waiting = { status: "waiting_capacity" as const, paused: false };
    expect(codexUsageContinueAtResetAction({ ...waiting, next: false })).toBe("pause");
    expect(codexUsageContinueAtResetAction({ ...waiting, paused: true, next: true })).toBe(
      "resume",
    );
    expect(codexUsageContinueAtResetAction({ status: "idle", paused: false, next: true })).toBe(
      "run_on_codex",
    );
    expect(codexUsageContinueAtResetAction({ status: "failed", paused: false, next: true })).toBe(
      "run_on_codex",
    );
    // No change, no action.
    expect(codexUsageContinueAtResetAction({ ...waiting, next: true })).toBe(null);
    expect(codexUsageContinueAtResetAction({ status: "idle", paused: false, next: false })).toBe(
      null,
    );
  });
});
