import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";

import {
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
