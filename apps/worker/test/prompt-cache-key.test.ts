import { describe, expect, test } from "bun:test";

import { promptCacheKeyForTurn } from "../src/activities/agent-turn/codex";

const codex = { provider: { kind: "codex-subscription" as const } };
const claude = {
  provider: { kind: "claude-subscription" as const, api: "anthropic-messages" as const },
};
const gateway = { provider: { kind: "openai-compatible" as const, api: "responses" as const } };

const base = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  rootSessionId: "22222222-2222-4222-8222-222222222222",
};

describe("promptCacheKeyForTurn", () => {
  test("groups off keeps one key per conversation", () => {
    expect(promptCacheKeyForTurn({ ...base, resolvedModel: codex as never, groups: 0 })).toBe(
      base.sessionId,
    );
    expect(promptCacheKeyForTurn({ ...base, resolvedModel: null, groups: 0 })).toBe(base.sessionId);
  });

  test("transports that must not receive a key get none, and Claude keeps its session identity", () => {
    expect(promptCacheKeyForTurn({ ...base, resolvedModel: gateway as never, groups: 8 })).toBe(
      undefined,
    );
    expect(promptCacheKeyForTurn({ ...base, resolvedModel: claude as never, groups: 8 })).toBe(
      base.sessionId,
    );
  });

  test("a conversation keeps one stable group key, and child sessions share their root's", () => {
    const key = promptCacheKeyForTurn({ ...base, resolvedModel: codex as never, groups: 8 });
    expect(key).toMatch(/^og-pc-[0-9a-f]{16}-8-[0-7]$/);
    expect(promptCacheKeyForTurn({ ...base, resolvedModel: codex as never, groups: 8 })).toBe(key);
    const child = promptCacheKeyForTurn({
      ...base,
      sessionId: "33333333-3333-4333-8333-333333333333",
      resolvedModel: codex as never,
      groups: 8,
    });
    expect(child).toBe(key);
  });

  test("new conversations in a workspace spread over the groups, and workspaces never share", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
      keys.add(
        promptCacheKeyForTurn({
          ...base,
          sessionId: id,
          rootSessionId: id,
          resolvedModel: null,
          groups: 4,
        })!,
      );
    }
    expect(keys.size).toBe(4);
    const other = promptCacheKeyForTurn({
      ...base,
      workspaceId: "44444444-4444-4444-8444-444444444444",
      resolvedModel: null,
      groups: 4,
    })!;
    expect(keys.has(other)).toBe(false);
  });
});
