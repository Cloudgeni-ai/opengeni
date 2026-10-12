import { describe, expect, test } from "bun:test";
import {
  createProviderCallBudget,
  VaultProviderError,
  type VaultProvider,
  type VaultProviderContext,
} from "../provider";

export interface VaultProviderUnderTest {
  provider: VaultProvider;
  /** A writable external vault the suite may create items in. */
  externalVaultId: string;
  connectionId?: string | null;
  /** Called once after the suite (delete created items, close clients). */
  cleanup?: () => Promise<void>;
}

/**
 * Behaviour every `VaultProvider` must share. Runs against the fake in CI and
 * against live 1Password behind `OPENGENI_ONEPASSWORD_LIVE=1` (W5 extends it).
 */
export function runVaultProviderContractSuite(
  name: string,
  make: () => Promise<VaultProviderUnderTest>,
): void {
  describe(`VaultProvider contract: ${name}`, () => {
    const context = (subject: VaultProviderUnderTest): VaultProviderContext => ({
      connectionId: subject.connectionId ?? null,
      budget: createProviderCallBudget(50),
    });

    test("validates and lists the writable vault", async () => {
      const subject = await make();
      try {
        const ctx = context(subject);
        await subject.provider.validate(ctx);
        const vaults = await subject.provider.listVaults(ctx);
        expect(vaults.some((vault) => vault.externalVaultId === subject.externalVaultId)).toBe(
          true,
        );
        expect(subject.provider.capabilities().passkeys).toBe(false);
      } finally {
        await subject.cleanup?.();
      }
    });

    test("writes, lists, reads and archives an item", async () => {
      const subject = await make();
      try {
        const ctx = context(subject);
        if (!subject.provider.capabilities().write) return;
        const itemName = `ogtest-${crypto.randomUUID()}`;
        const written = await subject.provider.writeItem(ctx, subject.externalVaultId, {
          name: itemName,
          type: "login",
          websites: ["https://example.test"],
          fields: [
            { name: "username", kind: "text", value: "agent@example.test" },
            { name: "password", kind: "concealed", value: "contract-suite-value" },
          ],
        });
        expect(written.name).toBe(itemName);
        const listed = await subject.provider.listItems(ctx, subject.externalVaultId);
        const item = listed.find(
          (candidate) => candidate.externalItemId === written.externalItemId,
        );
        expect(item).toBeDefined();
        const password = item!.fields.find((field) => field.name === "password")!;
        const [value] = await subject.provider.readFields(
          ctx,
          subject.externalVaultId,
          item!.externalItemId,
          [password.externalFieldId],
        );
        expect(value?.material).toEqual({ type: "text", value: "contract-suite-value" });
        await subject.provider.archiveItem(ctx, subject.externalVaultId, written.externalItemId);
        const after = await subject.provider.listItems(ctx, subject.externalVaultId);
        expect(after.some((candidate) => candidate.externalItemId === written.externalItemId)).toBe(
          false,
        );
      } finally {
        await subject.cleanup?.();
      }
    });

    test("maps a missing item to provider_not_found", async () => {
      const subject = await make();
      try {
        const ctx = context(subject);
        const error = await subject.provider
          .readFields(ctx, subject.externalVaultId, "missing-item", ["missing-field"])
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(VaultProviderError);
        expect((error as VaultProviderError).code).toBe("provider_not_found");
      } finally {
        await subject.cleanup?.();
      }
    });
  });
}
