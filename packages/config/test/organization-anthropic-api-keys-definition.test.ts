import { expect, test } from "bun:test";
import {
  assertTurnExecutionPolicyMatchesConfigV1,
  configuredModels,
  getSettings,
  resolveTurnExecutionPolicyV1,
  withClaudeConnectionCatalog,
  withOrganizationAnthropicApiKeys,
} from "../src";

// MP-KEYS-14: an organization's several Anthropic API keys are credential
// material, like its single key. Which keys it holds, their order and which
// still have credits change while turns run, so none of it is part of a
// model's executable definition.

const MODEL_ID = "organization-anthropic/claude-opus-5-5";
const catalog = () =>
  withClaudeConnectionCatalog(getSettings({ OPENGENI_ENV: "test" }), {
    anthropic: { active: true, models: [{ upstreamModelId: "claude-opus-5-5" }] },
  });
const withKeys = (ids: string[]) =>
  withOrganizationAnthropicApiKeys(
    catalog(),
    ids.map((id) => ({ id, apiKey: `test-anthropic-key-${id}` })),
  );
const definition = (settings: ReturnType<typeof catalog>) =>
  configuredModels(settings).find((model) => model.id === MODEL_ID)?.definitionVersion;
const input = {
  modelId: MODEL_ID,
  requestedModelId: MODEL_ID,
  modelSource: "explicit",
  reasoningEffort: "high",
  reasoningSource: "explicit",
} as const;

test("MP-KEYS-14: the keys an organization's Anthropic API connection holds are not in the model's definition", () => {
  const single = definition(catalog());
  expect(single).toBeDefined();
  // The settings really carry the keys; only the definition leaves them out.
  expect(withKeys(["primary-v1", "a"]).modelProvidersJson).toContain("test-anthropic-key-a");
  for (const ids of [["primary-v1"], ["primary-v1", "a", "b"], ["b", "primary-v1"], []])
    expect(definition(withKeys(ids))).toBe(single);
});

test("MP-KEYS-14: a turn accepted before a key was added, removed or ran out of credits keeps running", () => {
  // A new session's first turn is accepted on the catalog and runs on the
  // settings that carry the keys.
  const accepted = resolveTurnExecutionPolicyV1(catalog(), input);
  expect(() =>
    assertTurnExecutionPolicyMatchesConfigV1(withKeys(["primary-v1", "a", "b"]), accepted, input),
  ).not.toThrow();
  const running = resolveTurnExecutionPolicyV1(withKeys(["primary-v1", "a", "b"]), input);
  for (const ids of [
    ["primary-v1", "a", "b", "c"], // a key was added
    ["primary-v1", "b"], // a key ran out of credits or was removed
    [], // every key is out of credits
  ])
    expect(() =>
      assertTurnExecutionPolicyMatchesConfigV1(withKeys(ids), running, input),
    ).not.toThrow();
});
