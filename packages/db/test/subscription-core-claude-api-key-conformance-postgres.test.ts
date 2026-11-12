/**
 * The shared subscription-core conformance suite run for the Claude binding
 * with Anthropic API keys as pool accounts (SUB-KEY-01). It is the
 * production binding, with an OAuth refresher, but an API key's credential
 * format never renews: the core never refreshes it, and once Anthropic
 * refuses it the connection needs a new key (the suite's "refused static
 * credential" case). Any call to the token endpoint fails the run.
 */
import { afterAll, expect } from "bun:test";
import {
  subscriptionCoreClaudeProvider,
  type SubscriptionCoreClaudeCredential,
} from "../src/subscription-core-claude-adapter";
import { subscriptionCoreClaudeApiKeyAccountId } from "../src/subscription-core-claude-compat";
import { installNetworkDenialGuard } from "./fixtures/subscription-core-fake-api-key";
import { ScriptedClaudeUpstream } from "./fixtures/subscription-core-claude-upstream";
import { describeSubscriptionCoreConformance } from "./helpers/subscription-core-conformance";

let tokenCalls = 0;
const provider = subscriptionCoreClaudeProvider({
  fetch: (async () => {
    tokenCalls += 1;
    throw new Error("an API key must never be refreshed");
  }) as unknown as typeof fetch,
});
afterAll(() => {
  expect(tokenCalls).toBe(0);
});

const upstream = new ScriptedClaudeUpstream([
  "claude-conformance-a",
  "claude-conformance-b",
  "claude-conformance-c",
]);

describeSubscriptionCoreConformance<SubscriptionCoreClaudeCredential>({
  name: "Claude subscription (API key)",
  databaseLabel: "subscription-core-claude-api-key-conformance",
  usageReadingsComplete: false,
  provider,
  models: [
    {
      productModelId: "organization-claude-subscription/claude-conformance-a",
      upstreamModelId: "claude-conformance-a",
    },
    {
      productModelId: "organization-claude-subscription/claude-conformance-b",
      upstreamModelId: "claude-conformance-b",
    },
    {
      productModelId: "workspace-claude-subscription/claude-conformance-c",
      upstreamModelId: "claude-conformance-c",
    },
  ],
  credential: (label) => ({
    version: 1,
    kind: "api_key",
    apiKey: `sk-ant-api03-conformance-${label}`,
  }),
  // An API key is the account of its Anthropic organization.
  identity: async (label) => {
    const id = subscriptionCoreClaudeApiKeyAccountId(`org-${label}`);
    return { providerAccountId: id, providerSubjectId: id };
  },
  providerState: {},
  executionPolicy: {
    wireApi: "anthropic-messages",
    credentialSource: { kind: "connected_subscription", provider: "claude" },
    billing: { upstreamPayer: "connected_subscription", metering: "external" },
  },
  foreignProvider: "codex",
  async prepareDatabase(shared) {
    const [registered] = await shared.admin<{ provider: boolean }[]>`
      select exists (select 1 from opengeni_private.subscription_core_providers
        where provider = 'claude') as provider`;
    expect(registered).toEqual({ provider: true });
  },
  // API keys record no expiry, and never renew.
  expiresAt: () => null,
  renews: false,
  upstream,
  denyNetwork: installNetworkDenialGuard,
  sessionWaits: {
    provider: "claude",
    events: {
      waiting: "turn.capacity_waiting",
      resumed: "turn.recovery.requested",
      superseded: "turn.superseded",
    },
  },
});
