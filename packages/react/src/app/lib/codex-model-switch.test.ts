import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";

import {
  codexUsageContinueAtResetAction,
  codexUsageContinuesAtReset,
  codexUsageNoticeApplies,
  codexUsageResetText,
  codexUsageResetsAt,
  codexWaitIsUsageLimit,
  latestCheckpointIsCompaction,
  modelSwitchHeadsUpText,
  needsModelSwitchHeadsUp,
  pickedModelContinuesBlockedChat,
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

  test("a wait whose reason changed names its reset as earliestResetAt", () => {
    const reclassified = usage("codex.capacity.waiting", 9, {
      waitReason: "no_eligible_capacity",
      earliestResetAt: "2026-10-31T16:05:00.000Z",
    });
    expect(codexUsageResetsAt([reclassified])).toBe("2026-10-31T16:05:00.000Z");
    expect(
      codexUsageResetsAt([usage("codex.capacity.waiting", 9, { earliestResetAt: null })]),
    ).toBe(null);
  });

  test("only a capacity wait that no person needs to act on is a usage wait", () => {
    const wait = (payload: Record<string, unknown>) => [
      usage("codex.capacity.waiting", 3, { waitReason: "pinned_account_disabled" }),
      usage("codex.capacity.waiting", 5, payload),
    ];
    expect(codexWaitIsUsageLimit(wait({ waitReason: "no_eligible_capacity" }))).toBe(true);
    expect(codexWaitIsUsageLimit(wait({ waitReason: "compaction_provider_locked" }))).toBe(true);
    expect(codexWaitIsUsageLimit(wait({ waitReason: "pinned_account_unavailable" }))).toBe(true);
    // An older wait event without a reason.
    expect(codexWaitIsUsageLimit(wait({}))).toBe(true);
    expect(
      codexWaitIsUsageLimit(wait({ waitReason: "pinned_account_disabled", actionRequired: true })),
    ).toBe(false);
    expect(codexWaitIsUsageLimit(wait({ waitReason: "model_not_allowed" }))).toBe(false);
    expect(codexWaitIsUsageLimit([])).toBe(false);
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
    // A paused chat the limit stopped is resumed first, so the work isn't held back.
    expect(codexUsageContinueAtResetAction({ status: "idle", paused: true, next: true })).toBe(
      "resume_and_run_on_codex",
    );
    expect(codexUsageContinueAtResetAction({ status: "failed", paused: true, next: true })).toBe(
      "resume_and_run_on_codex",
    );
    // No change, no action.
    expect(codexUsageContinueAtResetAction({ ...waiting, next: true })).toBe(null);
    expect(codexUsageContinueAtResetAction({ status: "idle", paused: false, next: false })).toBe(
      null,
    );
  });

  test("a wait with no reset in sight, or one needing action, keeps the server's message", () => {
    const resetsAt = "2026-10-31T14:05:00.000Z";
    const waiting = { status: "waiting_capacity" as const, usageWait: true };
    expect(codexUsageNoticeApplies({ ...waiting, resetsAt })).toBe(true);
    // No ChatGPT plan can serve the chat (for example it was disconnected).
    expect(codexUsageNoticeApplies({ ...waiting, resetsAt: null })).toBe(false);
    // A turned-off or ineligible account needs a person, not a reset.
    expect(codexUsageNoticeApplies({ ...waiting, resetsAt, usageWait: false })).toBe(false);
    // A usage-limit failure names the limit even when its reset is unknown.
    expect(codexUsageNoticeApplies({ status: "failed", resetsAt: null, usageWait: false })).toBe(
      true,
    );
    expect(codexUsageNoticeApplies({ status: "idle", resetsAt: null, usageWait: false })).toBe(
      true,
    );
  });
});

describe("Picking another model on a blocked chat", () => {
  test("a turn parked on any provider's usage limit continues on the picked model", () => {
    // A Claude chat whose subscription ran out: switching to a Codex model
    // must continue it now, not leave it waiting for the Claude reset.
    expect(
      pickedModelContinuesBlockedChat({
        status: "waiting_capacity",
        codexUsageBlocked: false,
        canControl: true,
      }),
    ).toBe(true);
    // A Codex chat its usage limit stopped keeps continuing too.
    expect(
      pickedModelContinuesBlockedChat({
        status: "failed",
        codexUsageBlocked: true,
        canControl: true,
      }),
    ).toBe(true);
  });

  test("a chat that is not blocked, or a person who cannot control it, continues nothing", () => {
    for (const status of ["idle", "running", "failed", "requires_action"] as const)
      expect(
        pickedModelContinuesBlockedChat({ status, codexUsageBlocked: false, canControl: true }),
      ).toBe(false);
    expect(
      pickedModelContinuesBlockedChat({
        status: "waiting_capacity",
        codexUsageBlocked: true,
        canControl: false,
      }),
    ).toBe(false);
  });
});
