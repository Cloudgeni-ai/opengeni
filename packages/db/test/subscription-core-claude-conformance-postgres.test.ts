/**
 * The shared subscription-core conformance suite run for the Claude binding
 * with OAuth credentials (design docs/design/subscription-core-2026-10-07.md,
 * 5.3 Claude track C1a): the same placement, personal-authority, lease,
 * custody, failover, health and wait tests the Codex, SuperGrok and API-key
 * subjects pass, so Claude differs only by its binding's declared facts.
 * Since the Claude cutover (C3) the binding is registered in production, like
 * Codex's and SuperGrok's, and the cutover migration wrote its registry row
 * and receipt: the suite runs it with no test registration (asserted below).
 * Setup-token credentials, which never renew, run the same suite in
 * `subscription-core-claude-setup-token-conformance-postgres.test.ts`.
 *
 * The upstream is scripted and keyed by the access token; no network is
 * used, and the OAuth refresh goes to a scripted token endpoint through the
 * adapter's own refresh call (`requestClaudeTokenRefresh`). Claude's refusal
 * classification is the worker's (C1b); the suite's scripted classification
 * is used here. Usage readings go through the Claude usage decoder.
 */
import { describe, expect, test } from "bun:test";
import { CLAUDE_OAUTH_TOKEN_URL } from "@opengeni/config";
import { subscriptionCoreProviderIds } from "../src/subscription-core-providers";
import {
  subscriptionCoreClaudeProvider,
  type SubscriptionCoreClaudeCredential,
} from "../src/subscription-core-claude-adapter";
import { installNetworkDenialGuard } from "./fixtures/subscription-core-fake-api-key";
import { ScriptedClaudeUpstream } from "./fixtures/subscription-core-claude-upstream";
import { describeSubscriptionCoreConformance } from "./helpers/subscription-core-conformance";

let rotations = 0;
const tokenEndpoint = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input) !== CLAUDE_OAUTH_TOKEN_URL) throw new Error("unexpected token call");
  const body = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string };
  rotations += 1;
  return Response.json({
    access_token: `sk-ant-oat01-rotated-${rotations}-${body.refresh_token}`,
    refresh_token: `refresh-rotated-${rotations}-${body.refresh_token}`,
    expires_in: 8 * 60 * 60,
    scope: "user:inference user:profile",
  });
}) as unknown as typeof fetch;

const provider = subscriptionCoreClaudeProvider({ fetch: tokenEndpoint });

const upstream = new ScriptedClaudeUpstream([
  "claude-conformance-a",
  "claude-conformance-b",
  "claude-conformance-c",
]);

const accountUuid = (label: string) =>
  new Bun.CryptoHasher("sha256")
    .update(label)
    .digest("hex")
    .replace(/^(.{8})(.{4})(.{3})(.{3})(.{12}).*$/, "$1-$2-4$3-8$4-$5");

describeSubscriptionCoreConformance<SubscriptionCoreClaudeCredential>({
  name: "Claude subscription (OAuth)",
  databaseLabel: "subscription-core-claude-conformance",
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
    token: `sk-ant-oat01-access-${label}`,
    identity: { accountUuid: accountUuid(label), deviceId: "d".repeat(64) },
    oauth: {
      refreshToken: `refresh-${label}`,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      scopes: ["user:inference", "user:profile"],
    },
  }),
  // A completed Claude OAuth sign-in reports the account UUID, which is both
  // the account and the person.
  identity: async (_label, credential) => ({
    providerAccountId: credential.identity.accountUuid,
    providerSubjectId: credential.identity.accountUuid,
  }),
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
  expiresAt: () => new Date(Date.now() + 8 * 60 * 60 * 1000),
  renews: true,
  upstream,
  denyNetwork: installNetworkDenialGuard,
  // The core waiter speaks the legacy Claude wait's session events, so
  // clients and the workflow see one vocabulary across the cutover.
  sessionWaits: {
    provider: "claude",
    events: {
      waiting: "turn.capacity_waiting",
      resumed: "turn.recovery.requested",
      superseded: "turn.superseded",
    },
  },
});

describe("Claude binding after its cutover", () => {
  test("production registers the Claude binding", () => {
    expect(subscriptionCoreProviderIds()).toContain("claude");
  });
});
