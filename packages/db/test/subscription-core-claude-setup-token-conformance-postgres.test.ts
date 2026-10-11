/**
 * The shared subscription-core conformance suite run for the Claude binding
 * with pasted setup tokens (design docs/design/subscription-core-2026-10-07.md,
 * 5.3 Claude track C1a). It is the production binding, with an OAuth
 * refresher, but a setup token's credential format does not renew: the core
 * never refreshes it, and once Claude refuses it the connection becomes
 * needs-relogin (the suite's "refused static credential" case) instead of
 * being refreshed. Any call to the token endpoint fails the run.
 *
 * Run this file in its own process: the registration below replaces module
 * bindings for the whole process.
 */
import { expect, mock } from "bun:test";
import { createHmac } from "node:crypto";
import {
  subscriptionCoreClaudeProvider,
  type SubscriptionCoreClaudeCredential,
} from "../src/subscription-core-claude-adapter";
import {
  installNetworkDenialGuard,
  ScriptedApiKeyUpstream,
} from "./fixtures/subscription-core-fake-api-key";
import {
  admitTestSubscriptionCoreProvider,
  testSubscriptionCoreProviderModules,
} from "./helpers/subscription-core-test-provider";

const provider = subscriptionCoreClaudeProvider({
  fetch: (async () => {
    throw new Error("a setup token must never be refreshed");
  }) as unknown as typeof fetch,
});

for (const [specifier, factory] of testSubscriptionCoreProviderModules(provider))
  mock.module(specifier, factory);
const { describeSubscriptionCoreConformance } =
  await import("./helpers/subscription-core-conformance");

const upstream = new ScriptedApiKeyUpstream<SubscriptionCoreClaudeCredential>(
  (credential) => credential.token,
);

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
    // Every provider list a migration wrote already names Claude: the
    // registration widens nothing a Claude migration would have to.
    const lists = await shared.admin<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where contype = 'c' and pg_get_constraintdef(oid) like '%''xai''::text]%'`;
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) expect(list.definition).toContain("'claude'::text");
    await admitTestSubscriptionCoreProvider(shared.admin, provider);
  },
  // Setup tokens record no expiry.
  expiresAt: () => null,
  upstream,
  denyNetwork: installNetworkDenialGuard,
});
