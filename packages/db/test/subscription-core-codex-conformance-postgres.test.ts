/**
 * The shared subscription-core conformance suite run for the registered
 * Codex binding (design docs/design/subscription-core-2026-10-07.md, 5.3 step
 * F): the same tests the fake API-key connector passes, so a difference
 * between a subscription and an API-key connector can only come from the
 * binding's declared facts (connection kind, refresh, primary column, health
 * durations), never from a different code path. The upstream is scripted and
 * keyed by the access token; no network is used, and the OAuth refresh call
 * is a scripted rotation (a new access and refresh token per call).
 */
import { subscriptionCoreCodexProvider } from "../src/subscription-core-codex-adapter";
import {
  fakeApiKeyProvider,
  installNetworkDenialGuard,
  ScriptedApiKeyUpstream,
} from "./fixtures/subscription-core-fake-api-key";
import { describeSubscriptionCoreConformance } from "./helpers/subscription-core-conformance";
import { admitTestSubscriptionCoreProvider } from "./helpers/subscription-core-test-provider";

type CodexTokens = { accessToken: string; refreshToken: string; idToken: string };

const upstream = new ScriptedApiKeyUpstream<CodexTokens>((tokens) => tokens.accessToken);
let rotations = 0;

describeSubscriptionCoreConformance<CodexTokens>({
  name: "Codex subscription",
  databaseLabel: "subscription-core-codex-conformance",
  provider: subscriptionCoreCodexProvider({
    refresh: async (refreshToken) => {
      rotations += 1;
      return {
        accessToken: `access-rotated-${rotations}-${refreshToken}`,
        refreshToken: `refresh-rotated-${rotations}-${refreshToken}`,
      };
    },
  }),
  models: [
    { productModelId: "gpt-conformance-a", upstreamModelId: "gpt-conformance-a" },
    { productModelId: "gpt-conformance-b", upstreamModelId: "gpt-conformance-b" },
    { productModelId: "gpt-conformance-c", upstreamModelId: "gpt-conformance-c" },
  ],
  credential: (label) => ({
    accessToken: `access-${label}`,
    refreshToken: `refresh-${label}`,
    idToken: `id-${label}`,
  }),
  // A completed OAuth sign-in reports the ChatGPT account and user.
  identity: async (label) => ({
    providerAccountId: `account-${label}`,
    providerSubjectId: `user-${label}`,
  }),
  providerState: {},
  executionPolicy: {
    wireApi: "responses",
    credentialSource: { kind: "connected_subscription", provider: "codex" },
    billing: { upstreamPayer: "connected_subscription", metering: "external" },
  },
  // The API-key connector's rows only (its binding is not registered here).
  foreignProvider: fakeApiKeyProvider.adapter.provider,
  async prepareDatabase(shared) {
    await admitTestSubscriptionCoreProvider(shared.admin, fakeApiKeyProvider);
  },
  expiresAt: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
  upstream,
  denyNetwork: installNetworkDenialGuard,
});
