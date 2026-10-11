/**
 * The shared subscription-core conformance suite run for the Claude binding
 * with pasted setup tokens (design docs/design/subscription-core-2026-10-07.md,
 * 5.3 Claude track C1a). It is the production binding, with an OAuth
 * refresher, but a setup token's credential format does not renew: the core
 * never refreshes it, and once Claude refuses it the connection becomes
 * needs-relogin (the suite's "refused static credential" case) instead of
 * being refreshed. Any call to the token endpoint fails the run. * Since the Claude cutover (C3) the binding is registered in production and
 * the suite runs it with no test registration.
 */
import { afterAll, expect } from "bun:test";
import { createHmac } from "node:crypto";
import {
  subscriptionCoreClaudeProvider,
  type SubscriptionCoreClaudeCredential,
} from "../src/subscription-core-claude-adapter";
import { installNetworkDenialGuard } from "./fixtures/subscription-core-fake-api-key";
import { ScriptedClaudeUpstream } from "./fixtures/subscription-core-claude-upstream";
import { describeSubscriptionCoreConformance } from "./helpers/subscription-core-conformance";

// Any token call fails the run: the refresh would swallow a throwing fetch
// as a retryable failure, so the calls are counted and checked at the end.
let tokenCalls = 0;
const provider = subscriptionCoreClaudeProvider({
  fetch: (async () => {
    tokenCalls += 1;
    throw new Error("a setup token must never be refreshed");
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
  name: "Claude subscription (setup token)",
  databaseLabel: "subscription-core-claude-setup-token-conformance",
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
    token: `sk-ant-oat01-setup-${label}`,
    identity: { accountUuid: "", deviceId: "e".repeat(64) },
  }),
  // A setup token reports no account: the writers key it by an HMAC of the token.
  identity: async (_label, credential) => {
    const id =
      "setup:" + createHmac("sha256", "conformance").update(credential.token).digest("hex");
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
    // The cutover migration registered Claude and wrote its receipt;
    // nothing is admitted or widened for the suite.
    const [registered] = await shared.admin<{ provider: boolean; receipt: boolean }[]>`
      select
        exists (select 1 from opengeni_private.subscription_core_providers
          where provider = 'claude') as provider,
        exists (select 1 from opengeni_private.subscription_provider_cutover_receipts
          where provider = 'claude') as receipt`;
    expect(registered).toEqual({ provider: true, receipt: true });
  },
  // Setup tokens record no expiry, and never renew.
  expiresAt: () => null,
  renews: false,
  upstream,
  denyNetwork: installNetworkDenialGuard,
});
