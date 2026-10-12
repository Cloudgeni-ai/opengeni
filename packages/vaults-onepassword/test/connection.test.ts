import { describe, expect, test } from "bun:test";
import { createProviderCallBudget } from "@opengeni/vaults";

import {
  ONEPASSWORD_FAKE_VAULT_IDS,
  vaultProviderForOnePasswordConnection,
} from "../src/connection";
import { VaultProviderError } from "../src/contract";
import { fakeServiceAccountToken } from "./fake-sdk";

const ctx = () => ({ connectionId: null, budget: createProviderCallBudget(50) });

describe("provider for a stored 1Password connection", () => {
  test("fake tokens are refused unless explicitly allowed (no request, no echo)", () => {
    let error: unknown;
    try {
      vaultProviderForOnePasswordConnection({ token: "ops_fake_healthy" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(VaultProviderError);
    expect((error as VaultProviderError).code).toBe("provider_auth_invalid");
    expect((error as VaultProviderError).message).not.toContain("ops_fake_healthy");
  });

  test("ops_fake_healthy lists a stable Engineering vault with six items and a TOTP login", async () => {
    const provider = vaultProviderForOnePasswordConnection({
      token: "ops_fake_healthy",
      allowFakeTokens: true,
    });
    expect(provider.fake).toBe(true);
    const vaults = await provider.listVaults(ctx());
    expect(vaults.map((vault) => vault.externalVaultId)).toEqual([
      ONEPASSWORD_FAKE_VAULT_IDS.engineering,
    ]);
    const items = await provider.listItems(ctx(), ONEPASSWORD_FAKE_VAULT_IDS.engineering);
    expect(items).toHaveLength(6);
    const github = items.find((item) => item.name === "GitHub")!;
    const [otp] = await provider.readFields(
      ctx(),
      ONEPASSWORD_FAKE_VAULT_IDS.engineering,
      github.externalItemId,
      ["otp"],
    );
    expect(otp!.material.type).toBe("totp");
  });

  test("ops_fake_sync_error installs (vault list works) but every sync fails", async () => {
    const provider = vaultProviderForOnePasswordConnection({
      token: "ops_fake_sync_error",
      allowFakeTokens: true,
    });
    expect(await provider.listVaults(ctx())).toHaveLength(1);
    await expect(
      provider.listItems(ctx(), ONEPASSWORD_FAKE_VAULT_IDS.shared),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });

  test("a real token builds the SDK adapter without signing in", () => {
    const provider = vaultProviderForOnePasswordConnection({
      token: fakeServiceAccountToken(),
      planTier: "family",
    });
    expect(provider.id).toBe("onepassword");
    expect(provider.fake).toBe(false);
    expect(provider.accountName).toBe("my.1password.com");
    expect(provider.capabilities().groupGrants).toBe(false);
  });
});
