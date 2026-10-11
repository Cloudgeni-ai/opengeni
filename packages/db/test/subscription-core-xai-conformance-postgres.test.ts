/**
 * The shared subscription-core conformance suite run for the SuperGrok
 * binding (design docs/design/subscription-core-2026-10-07.md, 5.3 SuperGrok
 * track X1a): the same placement, personal-authority, lease, custody,
 * failover, health and wait tests the Codex and API-key subjects pass, so
 * SuperGrok differs only by its binding's declared facts. Since the SuperGrok
 * cutover (X3) the binding is registered in production, like Codex's, and the
 * cutover migration wrote its registry row and receipt: the suite runs it
 * as it runs Codex, with no test registration (asserted below).
 *
 * The upstream is scripted and keyed by the access token; no network is
 * used, and the OAuth refresh call is a scripted rotation. The transport and
 * classification are the suite's scripted ones: SuperGrok's own refusal
 * classification is covered with its adapter, and its transport custody
 * hooks in `@opengeni/xai-subscription` and the worker.
 */
import { describe, expect, test } from "bun:test";
import { subscriptionCoreProviderIds } from "../src/subscription-core-providers";
import {
  subscriptionCoreXaiProvider,
  type SubscriptionCoreXaiTokens,
} from "../src/subscription-core-xai-adapter";
import {
  installNetworkDenialGuard,
  ScriptedApiKeyUpstream,
} from "./fixtures/subscription-core-fake-api-key";
import { describeSubscriptionCoreConformance } from "./helpers/subscription-core-conformance";

let rotations = 0;
const provider = subscriptionCoreXaiProvider({
  refresh: async (refreshToken) => {
    rotations += 1;
    return {
      accessToken: `access-rotated-${rotations}-${refreshToken}`,
      refreshToken: `refresh-rotated-${rotations}-${refreshToken}`,
      idToken: null,
      tokenType: "Bearer",
      scope: null,
      expiresInSeconds: 3_600,
    };
  },
});

const upstream = new ScriptedApiKeyUpstream<SubscriptionCoreXaiTokens>(
  (tokens) => tokens.accessToken,
);

describeSubscriptionCoreConformance<SubscriptionCoreXaiTokens>({
  name: "SuperGrok subscription",
  databaseLabel: "subscription-core-xai-conformance",
  provider,
  models: [
    { productModelId: "supergrok/conformance-a", upstreamModelId: "conformance-a" },
    { productModelId: "supergrok/conformance-b", upstreamModelId: "conformance-b" },
    { productModelId: "supergrok/conformance-c", upstreamModelId: "conformance-c" },
  ],
  credential: (label) => ({ accessToken: `access-${label}`, refreshToken: `refresh-${label}` }),
  // A completed SuperGrok sign-in reports the token identity subject, which
  // is both the account and the person.
  identity: async (label) => ({
    providerAccountId: `xai-subject-${label}`,
    providerSubjectId: `xai-subject-${label}`,
  }),
  providerState: {},
  executionPolicy: {
    wireApi: "responses",
    credentialSource: { kind: "connected_subscription", provider: "xai" },
    billing: { upstreamPayer: "connected_subscription", metering: "external" },
  },
  foreignProvider: "codex",
  async prepareDatabase(shared) {
    // The cutover migration registered SuperGrok and wrote its receipt;
    // nothing is admitted or widened for the suite.
    const [registered] = await shared.admin<{ provider: boolean; receipt: boolean }[]>`
      select
        exists (select 1 from opengeni_private.subscription_core_providers
          where provider = 'xai') as provider,
        exists (select 1 from opengeni_private.subscription_provider_cutover_receipts
          where provider = 'xai') as receipt`;
    expect(registered).toEqual({ provider: true, receipt: true });
  },
  expiresAt: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
  upstream,
  denyNetwork: installNetworkDenialGuard,
  // The core waiter speaks the legacy SuperGrok wait's session events, so
  // clients and the workflow see one vocabulary across the cutover.
  sessionWaits: {
    provider: "xai",
    events: {
      waiting: "turn.capacity_waiting",
      resumed: "turn.recovery.requested",
      superseded: "turn.superseded",
    },
  },
});

describe("SuperGrok binding after its cutover", () => {
  test("production registers the SuperGrok binding", () => {
    expect(subscriptionCoreProviderIds()).toContain("xai");
  });
});
