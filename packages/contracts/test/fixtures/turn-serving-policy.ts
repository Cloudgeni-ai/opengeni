import { TurnExecutionPolicyV1, TurnServingPolicyV1 } from "../../src";

export const acceptedPolicy = TurnExecutionPolicyV1.parse({
  schemaVersion: 1, productModelId: "source/model", requestedModelId: null,
  modelSource: "session", reasoningEffort: "high", reasoningSource: "session",
  providerId: "source", upstreamModelId: "model", wireApi: "responses",
  credentialSource: { kind: "organization_connection", mechanism: "api_key" },
  billing: { upstreamPayer: "organization", metering: "external" },
  definitionVersion: `sha256:${"a".repeat(64)}`,
});

export function servingRevision(overrides: Partial<TurnServingPolicyV1> = {}): TurnServingPolicyV1 {
  return TurnServingPolicyV1.parse({
    schemaVersion: 1,
    policy: { ...acceptedPolicy, providerId: "target", productModelId: "target/model", reasoningEffort: "medium" },
    executionGeneration: 1, connectionId: "00000000-0000-4000-8000-000000000001",
    reason: "failover_cross_provider", historyPosition: 10,
    ...overrides,
  });
}
