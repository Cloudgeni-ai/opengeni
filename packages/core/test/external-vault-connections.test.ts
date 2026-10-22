import { describe, expect, test } from "bun:test";
import type { ConnectionMetadata } from "@opengeni/contracts";
import {
  createProviderCallBudget,
  providerOperations,
  type VaultProvider,
  type VaultProviderContext,
} from "@opengeni/vaults";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import {
  bindVaultProviderAuthority,
  externalVaultConnectionDetails,
  externalVaultConnectionMetadata,
  isExternalVaultConnection,
  StoredVaultProviderCredentials,
} from "../src/domain/vaults/external-provider-connections";

const operations = providerOperations(createFakeVaultProvider().capabilities());
const details = {
  version: 1 as const,
  provider: "external" as const,
  ownership: "workspace" as const,
  accountId: "account",
  accountName: "Example",
  label: null,
  verifiedAt: "2026-10-15T00:00:00.000Z",
  operations,
};

describe("external vault connection metadata", () => {
  test("requires exact role and complete versioned metadata", () => {
    const metadata = externalVaultConnectionMetadata(details);
    expect(externalVaultConnectionDetails(metadata)).toEqual(details);
    expect(externalVaultConnectionDetails({ vaultProvider: details })).toBeNull();
    expect(
      externalVaultConnectionDetails({
        ...metadata,
        credentialRole: "onepassword_service_account",
      }),
    ).toBeNull();
    expect(
      externalVaultConnectionDetails({
        ...metadata,
        vaultProvider: { ...details, ownership: undefined },
      }),
    ).toBeNull();
    expect(
      externalVaultConnectionDetails({
        ...metadata,
        vaultProvider: { ...details, token: "not metadata" },
      }),
    ).toBeNull();
  });

  test("checks domain, kind and personal ownership rather than labels", () => {
    const connection = {
      providerDomain: "vault:external",
      kind: "api_key",
      subjectId: null,
      metadata: externalVaultConnectionMetadata(details),
    } as ConnectionMetadata;
    expect(isExternalVaultConnection(connection)).toBe(true);
    expect(isExternalVaultConnection({ ...connection, providerDomain: "vault:keeper" })).toBe(
      false,
    );
    expect(isExternalVaultConnection({ ...connection, kind: "oauth2" })).toBe(false);
    expect(isExternalVaultConnection({ ...connection, subjectId: "someone" })).toBe(false);
    expect(
      isExternalVaultConnection({
        ...connection,
        subjectId: "someone",
        metadata: externalVaultConnectionMetadata({ ...details, ownership: "user" }),
      }),
    ).toBe(true);
  });

  test("Keeper bootstrap tokens are never runtime bundles, nor broker headers", () => {
    expect(
      StoredVaultProviderCredentials.safeParse({ provider: "keeper", oneTimeToken: "a".repeat(32) })
        .success,
    ).toBe(false);
    expect(
      StoredVaultProviderCredentials.safeParse({
        provider: "keeper",
        configuration: { appKey: "fixture" },
      }).success,
    ).toBe(true);
    expect(
      StoredVaultProviderCredentials.safeParse({
        provider: "protonpass",
        token: "a".repeat(32),
        headers: { authorization: "fixture" },
      }).success,
    ).toBe(false);
  });
});

describe("bound native provider authority", () => {
  const authority = {
    accountId: "account",
    workspaceId: "workspace",
    connectionWorkspaceId: "home",
    subjectId: "person",
    attemptId: "attempt",
  };
  const ctx: VaultProviderContext = {
    connectionId: "spoof",
    budget: createProviderCallBudget(50),
    authority: { ...authority, subjectId: "other", workspaceId: "other" },
    forceRefresh: true,
    cacheEpoch: "epoch",
  };

  test("overwrites supplied identity and checks reach on every operation", async () => {
    const raw: VaultProvider = { ...createFakeVaultProvider(), id: "external" };
    const observed: VaultProviderContext[] = [];
    raw.listVaults = async (value) => {
      observed.push(value);
      return [];
    };
    raw.readFields = async (value) => {
      observed.push(value);
      return [];
    };
    let checks = 0;
    const provider = bindVaultProviderAuthority(raw, {
      connectionId: "real",
      authority,
      operations,
      revalidate: async () => {
        checks++;
      },
    });
    await provider.listVaults(ctx);
    await provider.readFields(ctx, "v", "i", ["f"]);
    expect(checks).toBe(2);
    expect(observed).toHaveLength(2);
    for (const value of observed) {
      expect(value.authority).toEqual(authority);
      expect(value.connectionId).toBe("real");
      expect(value.forceRefresh).toBe(true);
      expect(value.cacheEpoch).toBe("epoch");
      expect(value.budget).toBe(ctx.budget);
    }
    expect(ctx.connectionId).toBe("spoof");
  });

  test("revocation and abort fail before invoking the provider", async () => {
    const raw = createFakeVaultProvider();
    const provider = bindVaultProviderAuthority(raw, {
      connectionId: "real",
      authority,
      operations,
      revalidate: async () => {
        throw new Error("revoked");
      },
    });
    await expect(provider.listVaults(ctx)).rejects.toThrow("revoked");
    const signal = AbortSignal.abort();
    await expect(provider.readFields({ ...ctx, signal }, "v", "i", ["f"])).rejects.toBeDefined();
    expect(raw.calls).toHaveLength(0);
  });

  test("a later adapter cannot widen verified connection capabilities", () => {
    const provider = bindVaultProviderAuthority(createFakeVaultProvider(), {
      connectionId: "real",
      authority,
      operations: { ...operations, updateItem: false, archiveItem: false, archiveKind: "none" },
      revalidate: async () => {},
    });
    expect(provider.capabilities().operations).toMatchObject({
      updateItem: false,
      archiveItem: false,
      archiveKind: "none",
    });
  });
});
