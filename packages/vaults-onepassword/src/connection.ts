import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";

import type { OnePasswordPlanTier } from "./budget";
import { type VaultProvider, VaultProviderError } from "./contract";
import { createOnePasswordVaultProvider } from "./provider";
import { type OnePasswordClientCache } from "./sdk";
import { type OnePasswordFakeToken, describeOnePasswordToken } from "./token";

export type OnePasswordConnectionProviderOptions = {
  token: string;
  planTier?: OnePasswordPlanTier;
  /** `settings.onePasswordFakeTokens` (refused by the managed runtime posture). */
  allowFakeTokens?: boolean;
  clientCache?: OnePasswordClientCache;
};

/** Stable IDs so API and worker processes agree on the fake vaults. */
export const ONEPASSWORD_FAKE_VAULT_IDS = {
  engineering: "fakeengineeringvault000001",
  shared: "fakesharedvault00000000001",
} as const;

const fakeProviders = new Map<OnePasswordFakeToken, VaultProvider>();

function fakeLogin(id: string, name: string, website: string, totp = false) {
  return {
    externalItemId: id,
    name,
    type: "login" as const,
    websites: [website],
    fields: [
      { externalFieldId: "username", name: "username", kind: "text" as const, value: `${id}@example.test` },
      { externalFieldId: "password", name: "password", kind: "concealed" as const, value: `fake-${id}-password` },
      ...(totp
        ? [
            {
              externalFieldId: "otp",
              name: "one-time password",
              kind: "totp" as const,
              value: "otpauth://totp/Fake:engineering?secret=JBSWY3DPEHPK3PXP&period=30&digits=6",
            },
          ]
        : []),
    ],
  };
}

function fakeProviderFor(token: OnePasswordFakeToken): VaultProvider {
  const existing = fakeProviders.get(token);
  if (existing) return existing;
  let provider: VaultProvider;
  if (token === "ops_fake_healthy") {
    provider = createFakeVaultProvider({
      accountName: "fake.1password.test",
      capabilities: { files: false, groupGrants: false },
      vaults: [
        {
          externalVaultId: ONEPASSWORD_FAKE_VAULT_IDS.engineering,
          name: "Engineering",
          items: [
            fakeLogin("fakeitemgithub000000000001", "GitHub", "https://github.com", true),
            fakeLogin("fakeitemgrafana00000000001", "Grafana", "https://grafana.example.test"),
            fakeLogin("fakeitemstatuspage0000001", "Statuspage", "https://status.example.test"),
            {
              externalItemId: "fakeitemstripekey00000001",
              name: "Stripe API key",
              type: "api_key",
              fields: [{ externalFieldId: "credential", name: "credential", kind: "concealed", value: "sk_test_fake" }],
            },
            {
              externalItemId: "fakeitemsentrydsn00000001",
              name: "Sentry DSN",
              type: "api_key",
              fields: [{ externalFieldId: "credential", name: "credential", kind: "concealed", value: "https://fake@sentry.example.test/1" }],
            },
            {
              externalItemId: "fakeitemoncallnote0000001",
              name: "On-call runbook",
              type: "note",
              fields: [{ externalFieldId: "@notes", name: "note", kind: "concealed", value: "Page the fake on-call." }],
            },
          ],
        },
      ],
    });
  } else {
    const base = createFakeVaultProvider({
      accountName: "fake.1password.test",
      capabilities: { files: false, groupGrants: false },
      vaults: [
        {
          externalVaultId: ONEPASSWORD_FAKE_VAULT_IDS.shared,
          name: "Shared",
          items: [
            fakeLogin("fakeitemaws000000000000001", "AWS console", "https://console.aws.amazon.com"),
            fakeLogin("fakeitemjira00000000000001", "Jira", "https://jira.example.test"),
            fakeLogin("fakeitemwifi00000000000001", "Office Wi-Fi", "https://wifi.example.test"),
          ],
        },
      ],
    });
    const syncError = () =>
      new VaultProviderError(
        "provider_unavailable",
        "1Password could not be reached (simulated sync error for ops_fake_sync_error)",
      );
    provider = {
      ...base,
      async listItems() {
        throw syncError();
      },
      async writeItem() {
        throw syncError();
      },
    };
  }
  fakeProviders.set(token, provider);
  return provider;
}

/**
 * The provider for one stored 1Password connection credential. Checks the
 * token offline first (no request); dev fake tokens resolve to a process-wide
 * in-memory fake only when `allowFakeTokens` is set.
 */
export function vaultProviderForOnePasswordConnection(
  options: OnePasswordConnectionProviderOptions,
): VaultProvider & { readonly accountName: string | null; readonly fake: boolean } {
  const token = options.token.trim();
  const description = describeOnePasswordToken(token, {
    allowFakeTokens: options.allowFakeTokens ?? false,
  });
  const provider = description.fake
    ? fakeProviderFor(token as OnePasswordFakeToken)
    : createOnePasswordVaultProvider({
        token,
        planTier: options.planTier ?? "teams",
        ...(options.clientCache ? { clientCache: options.clientCache } : {}),
      });
  return { ...provider, accountName: description.accountName, fake: description.fake };
}

export function resetOnePasswordFakeProvidersForTests() {
  fakeProviders.clear();
}
