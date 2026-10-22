import { expect, test } from "bun:test";
import { acceptedPolicy, servingRevision } from "../../contracts/test/fixtures/turn-serving-policy";
import {
  assertTurnServingPolicyMatchesConfigV1,
  configuredModels,
  getSettings,
  resolveTurnExecutionPolicyV1,
  withCodexCatalogProvider,
} from "../src";

const enabled = withCodexCatalogProvider(
  getSettings({
    OPENGENI_ENV: "test",
    OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true",
    OPENGENI_SUBSCRIPTION_CROSS_PROVIDER_FAILOVER_ENABLED: "true",
  }),
);
const model = configuredModels(enabled).find(
  (candidate) => candidate.credentialSource.kind === "connected_subscription",
)!;
const revision = servingRevision({
  policy: resolveTurnExecutionPolicyV1(enabled, {
    modelId: model.id,
    requestedModelId: null,
    modelSource: "continuation",
    reasoningEffort: "medium",
    reasoningSource: "continuation",
  }),
});

test("D-43 deployment gate defaults OFF and explicit false keeps serving configuration inert", () => {
  for (const env of [{}, { OPENGENI_SUBSCRIPTION_CROSS_PROVIDER_FAILOVER_ENABLED: "false" }]) {
    const settings = getSettings({ OPENGENI_ENV: "test", ...env });
    expect(settings.subscriptionCrossProviderFailoverEnabled).toBe(false);
    expect(() =>
      assertTurnServingPolicyMatchesConfigV1(settings, revision, acceptedPolicy),
    ).toThrow("disabled");
  }
  expect(enabled.subscriptionCrossProviderFailoverEnabled).toBe(true);
});

test("D-37 config checks the serving model and mapped reasoning without changing accepted policy", () => {
  const before = structuredClone(acceptedPolicy);
  expect(assertTurnServingPolicyMatchesConfigV1(enabled, revision, acceptedPolicy).policy).toEqual(
    revision.policy,
  );
  expect(revision.policy.productModelId).not.toBe(acceptedPolicy.productModelId);
  expect(revision.policy.reasoningEffort).not.toBe(acceptedPolicy.reasoningEffort);
  expect(acceptedPolicy).toEqual(before);
  for (const patch of [
    { definitionVersion: `sha256:${"f".repeat(64)}` },
    { providerId: "unconfigured" },
    { upstreamModelId: "another" },
    { wireApi: "chat" as const },
    { productModelId: "missing/model" },
  ])
    expect(() =>
      assertTurnServingPolicyMatchesConfigV1(
        enabled,
        { ...revision, policy: { ...revision.policy, ...patch } },
        acceptedPolicy,
      ),
    ).toThrow();
});

test("D-37 configuration refuses a restricted accepted policy even for a valid serving definition", () => {
  expect(() =>
    assertTurnServingPolicyMatchesConfigV1(enabled, revision, {
      ...acceptedPolicy,
      credentialRestriction: "developer_setup",
    }),
  ).toThrow("Restricted");
});
