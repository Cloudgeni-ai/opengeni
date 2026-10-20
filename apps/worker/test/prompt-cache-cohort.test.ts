import { expect, test } from "bun:test";
import { promptCacheCohortKey, promptCacheKeyForTurn } from "../src/activities/agent-turn/codex";

type ResolvedModel = Parameters<typeof promptCacheKeyForTurn>[0];
const resolved = (
  kind: "api-key" | "codex-subscription",
  api: "responses" | "chat" | "anthropic-messages",
  builtin?: boolean,
) => ({ provider: { kind, api, builtin } }) as ResolvedModel;

test("one account shares a cohort across sessions, workspaces, people and retries", () => {
  const key = promptCacheCohortKey("account-a");
  expect(promptCacheCohortKey("account-a")).toBe(key);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(key).not.toContain("account-a");
});

test("accounts get separate cohorts", () => {
  expect(promptCacheCohortKey("account-b")).not.toBe(promptCacheCohortKey("account-a"));
});

test("OpenAI-wire turns send the account cohort, never the session id", () => {
  const ids = { accountId: "account-a", sessionId: "session-a" };
  const cohort = promptCacheCohortKey("account-a");
  expect(promptCacheKeyForTurn(null, ids)).toBe(cohort);
  expect(promptCacheKeyForTurn(resolved("api-key", "responses", true), ids)).toBe(cohort);
  expect(promptCacheKeyForTurn(resolved("codex-subscription", "responses"), ids)).toBe(cohort);
  expect(
    promptCacheKeyForTurn(resolved("codex-subscription", "responses"), {
      accountId: "account-a",
      sessionId: "session-b",
    }),
  ).toBe(cohort);
});

test("native Claude keeps the session identity and other providers get no key", () => {
  const ids = { accountId: "account-a", sessionId: "session-a" };
  expect(promptCacheKeyForTurn(resolved("api-key", "anthropic-messages"), ids)).toBe("session-a");
  expect(promptCacheKeyForTurn(resolved("api-key", "chat"), ids)).toBeUndefined();
  expect(promptCacheKeyForTurn(resolved("api-key", "responses"), ids)).toBeUndefined();
});
