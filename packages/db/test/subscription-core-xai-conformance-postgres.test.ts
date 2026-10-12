/**
 * The shared subscription-core conformance suite run for the SuperGrok
 * binding (design docs/design/subscription-core-2026-10-07.md, 5.3 SuperGrok
 * track X1a): the same placement, personal-authority, lease, custody,
 * failover, health and wait tests the Codex and API-key subjects pass, so
 * SuperGrok differs only by its binding's declared facts. Before the
 * SuperGrok cutover (X3) the binding is registered only in this process and
 * this test database; production registers nothing (asserted below).
 *
 * The upstream is scripted and keyed by the access token; no network is
 * used, and the OAuth refresh call is a scripted rotation. The transport and
 * classification are the suite's scripted ones: SuperGrok's own refusal
 * classification moves into its adapter with X1b, and its transport custody
 * hooks are covered in `@opengeni/xai-subscription` and the worker.
 *
 * Run this file in its own process: the registration below replaces module
 * bindings for the whole process.
 */
import { describe, expect, mock, test } from "bun:test";
import { subscriptionCoreProviderIds } from "../src/subscription-core-providers";
import {
  subscriptionCoreXaiProvider,
  type SubscriptionCoreXaiTokens,
} from "../src/subscription-core-xai-adapter";
import {
  installNetworkDenialGuard,
  ScriptedApiKeyUpstream,
} from "./fixtures/subscription-core-fake-api-key";
import {
  admitTestSubscriptionCoreProvider,
  testSubscriptionCoreProviderModules,
} from "./helpers/subscription-core-test-provider";

// Read before the test registration: what production registers.
const productionProviderIds = subscriptionCoreProviderIds();

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

for (const [specifier, factory] of testSubscriptionCoreProviderModules(provider))
  mock.module(specifier, factory);
const { describeSubscriptionCoreConformance } =
  await import("./helpers/subscription-core-conformance");

const upstream = new ScriptedApiKeyUpstream<SubscriptionCoreXaiTokens>(
  (tokens) => tokens.accessToken,
);

describeSubscriptionCoreConformance<SubscriptionCoreXaiTokens>({
  name: "SuperGrok subscription",
  databaseLabel: "subscription-core-xai-conformance",
  // The adapter's declared usage-reading completeness (asserted by the suite).
  usageReadingsComplete: true,
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
    const admitted = await admitTestSubscriptionCoreProvider(shared.admin, provider);
    // Every migration already lists SuperGrok: nothing is widened for it.
    expect(admitted.constraints).toEqual([]);
    expect(admitted.routines.filter((routine) => !routine.includes("receipt"))).toEqual([]);
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

describe("SuperGrok binding before its cutover", () => {
  test("production registers no SuperGrok binding", () => {
    expect(productionProviderIds).not.toContain("xai");
  });
});
