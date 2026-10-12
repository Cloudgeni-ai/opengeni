import { afterAll, describe, expect, test } from "bun:test";

import {
  type ProviderItemMeta,
  type VaultProvider,
  type VaultProviderContext,
  VaultProviderError,
  type VaultProviderErrorCode,
  totpCode,
} from "../src/contract";

/**
 * Body of runVaultProviderContractSuite (dossier §10B.1.4, W5). Written to be
 * call-frugal: one run costs about 16 provider calls, so it can run against live
 * 1Password on a FAMILY plan (1,000 requests/day).
 */
export interface VaultProviderUnderTest {
  provider: VaultProvider;
  /** A fresh context (fresh attempt budget) for each step. */
  context(): VaultProviderContext;
  readWriteVaultId: string;
  readOnlyVaultId: string | null;
  /** Existing login with username, password and TOTP (live: "Test Login"). */
  fixtureItemName: string | null;
  /** Prefix for throwaway items, swept by the live harness. */
  namePrefix: string;
  /** Error a write into the read-only vault must raise. */
  readOnlyWriteError?: VaultProviderErrorCode;
  /** Called once after the suite; must remove throwaway items. */
  cleanup?(): Promise<void>;
}

const TOTP_SEED = "JBSWY3DPEHPK3PXP";
const TOTP_URI = `otpauth://totp/OpenGeni:ogtest?secret=${TOTP_SEED}&issuer=OpenGeni&period=30&digits=6`;

function generatedPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!#%+-.:=?@_";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

async function expectProviderError(promise: Promise<unknown>, code: VaultProviderErrorCode) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(VaultProviderError);
    expect((error as VaultProviderError).code).toBe(code);
    return error as VaultProviderError;
  }
  throw new Error(`expected ${code}`);
}

function field(meta: ProviderItemMeta, name: string) {
  const found = meta.fields.find((candidate) => candidate.name.toLowerCase() === name);
  if (!found) throw new Error(`field ${name} missing from ${meta.name}`);
  return found;
}

export function defineVaultProviderContract(
  name: string,
  make: () => Promise<VaultProviderUnderTest>,
) {
  describe(`VaultProvider contract: ${name}`, () => {
    let subject: VaultProviderUnderTest;
    let created: ProviderItemMeta | null = null;
    const password = generatedPassword();
    const nextPassword = generatedPassword();
    const ready = (async () => {
      subject = await make();
    })();

    afterAll(async () => {
      await ready;
      await subject.cleanup?.();
    });

    test("lists reachable vaults with change tokens", async () => {
      await ready;
      const vaults = await subject.provider.listVaults(subject.context());
      const rw = vaults.find((vault) => vault.externalVaultId === subject.readWriteVaultId);
      expect(rw).toBeDefined();
      expect(typeof rw!.name).toBe("string");
      if (subject.readOnlyVaultId) {
        expect(vaults.some((vault) => vault.externalVaultId === subject.readOnlyVaultId)).toBe(true);
      }
    });

    test("mirrors item metadata without values and reads values live (including TOTP)", async () => {
      await ready;
      const items = await subject.provider.listItems(subject.context(), subject.readWriteVaultId);
      for (const item of items) {
        expect(JSON.stringify(item)).not.toContain('"value"');
      }
      if (!subject.fixtureItemName) return;
      const fixture = items.find((item) => item.name === subject.fixtureItemName);
      expect(fixture).toBeDefined();
      const username = field(fixture!, "username");
      const pw = field(fixture!, "password");
      const otp = fixture!.fields.find((candidate) => candidate.kind === "totp");
      expect(pw.kind).toBe("concealed");
      expect(otp).toBeDefined();
      const values = await subject.provider.readFields(
        subject.context(),
        subject.readWriteVaultId,
        fixture!.externalItemId,
        [username.externalFieldId, pw.externalFieldId, otp!.externalFieldId],
      );
      expect(values.map((value) => value.material.type)).toEqual(["text", "text", "totp"]);
      const material = values[2]!.material;
      if (material.type !== "totp") throw new Error("expected totp material");
      expect(await totpCode(material.params, Date.now())).toMatch(/^\d{6,8}$/);
    });

    test("creates an item with a generated password and a TOTP seed", async () => {
      await ready;
      created = await subject.provider.writeItem(subject.context(), subject.readWriteVaultId, {
        name: `${subject.namePrefix}${crypto.randomUUID().slice(0, 8)}`,
        type: "login",
        websites: ["https://login.example.test"],
        fields: [
          { name: "username", kind: "text", value: "ogtest@example.test" },
          { name: "password", kind: "concealed", value: password },
          { name: "one-time password", kind: "totp", value: TOTP_URI },
        ],
      });
      expect(created.type).toBe("login");
      expect(created.websites).toEqual(["https://login.example.test"]);
      expect(field(created, "username").kind).toBe("text");
      expect(field(created, "password").kind).toBe("concealed");
      expect(field(created, "one-time password").kind).toBe("totp");
      const values = await subject.provider.readFields(
        subject.context(),
        subject.readWriteVaultId,
        created.externalItemId,
        [field(created, "password").externalFieldId, field(created, "one-time password").externalFieldId],
      );
      expect(values[0]!.material).toEqual({ type: "text", value: password });
      const otp = values[1]!.material;
      expect(otp.type).toBe("totp");
      if (otp.type === "totp") expect(otp.params.secretBase32).toBe(TOTP_SEED);
    });

    test("updates by field patch with an expected version; a stale version is provider_conflict", async () => {
      await ready;
      if (!created) throw new Error("create step failed");
      const before = created;
      const updated = await subject.provider.writeItem(subject.context(), subject.readWriteVaultId, {
        externalItemId: before.externalItemId,
        expectedVersion: before.version,
        name: before.name,
        type: "login",
        websites: before.websites,
        fields: [
          {
            externalFieldId: field(before, "password").externalFieldId,
            name: "password",
            kind: "concealed",
            value: nextPassword,
          },
        ],
      });
      expect(updated.version).not.toBe(before.version);
      // The untouched fields survive the patch.
      expect(updated.fields.map((f) => f.name).sort()).toEqual(before.fields.map((f) => f.name).sort());
      await expectProviderError(
        subject.provider.writeItem(subject.context(), subject.readWriteVaultId, {
          externalItemId: before.externalItemId,
          expectedVersion: before.version,
          name: before.name,
          type: "login",
          websites: before.websites,
          fields: [{ name: "password", kind: "concealed", value: password }],
        }),
        "provider_conflict",
      );
      const [value] = await subject.provider.readFields(
        subject.context(),
        subject.readWriteVaultId,
        updated.externalItemId,
        [field(updated, "password").externalFieldId],
      );
      expect(value!.material).toEqual({ type: "text", value: nextPassword });
      created = updated;
    });

    test("archives an item; it leaves the metadata mirror", async () => {
      await ready;
      if (!created) throw new Error("create step failed");
      const archivedId = created.externalItemId;
      await subject.provider.archiveItem(subject.context(), subject.readWriteVaultId, archivedId);
      const items = await subject.provider.listItems(subject.context(), subject.readWriteVaultId);
      expect(items.some((item) => item.externalItemId === archivedId)).toBe(false);
    });

    test("reads from a read-only vault but refuses writes there", async () => {
      await ready;
      if (!subject.readOnlyVaultId) return;
      await expectProviderError(
        subject.provider.writeItem(subject.context(), subject.readOnlyVaultId, {
          name: `${subject.namePrefix}ro-${crypto.randomUUID().slice(0, 8)}`,
          type: "api_key",
          websites: [],
          fields: [{ name: "value", kind: "concealed", value: "never-stored" }],
        }),
        subject.readOnlyWriteError ?? "provider_permission_denied",
      );
    });
  });
}
