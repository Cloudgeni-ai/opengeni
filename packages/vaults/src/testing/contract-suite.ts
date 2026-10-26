import { afterAll, describe, expect, test } from "bun:test";
import {
  generatePassword,
  totpCode,
  type VaultItemType,
  type VaultFieldKind,
} from "@opengeni/contracts";
import {
  createProviderCallBudget,
  VaultProviderError,
  type ProviderItemMeta,
  type VaultProvider,
  type VaultProviderContext,
  type VaultProviderErrorCode,
} from "../provider";
import { generateSshKeyPair } from "../ssh-keys";

export interface VaultProviderUnderTest {
  provider: VaultProvider;
  /** A writable external vault the suite may create, update and archive items in. */
  externalVaultId: string;
  connectionId?: string | null;
  /** A fresh context per step (fresh attempt budget). Defaults to a 50-call budget. */
  context?: () => VaultProviderContext;
  /** A vault the credential can read but not write; enables the read-only step. */
  readOnlyVaultId?: string | null;
  /** Error a write into `readOnlyVaultId` must raise. */
  readOnlyWriteError?: VaultProviderErrorCode;
  /**
   * An existing login in `externalVaultId` with username, password and TOTP
   * fields (live: "Test Login"); enables the live-read step.
   */
  fixtureItemName?: string | null;
  /** Prefix for throwaway items (default `ogtest-`); live harnesses sweep it. */
  namePrefix?: string;
  /** Called once after the suite; must remove the throwaway items it created. */
  cleanup?: () => Promise<void>;
}

const TOTP_SEED = "JBSWY3DPEHPK3PXP";
const TOTP_URI = `otpauth://totp/OpenGeni:ogtest?secret=${TOTP_SEED}&issuer=OpenGeni&period=30&digits=6`;

async function expectProviderError(
  promise: Promise<unknown>,
  code: VaultProviderErrorCode,
): Promise<VaultProviderError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(VaultProviderError);
  expect((error as VaultProviderError).code).toBe(code);
  return error as VaultProviderError;
}

function field(meta: ProviderItemMeta, name: string) {
  const found = meta.fields.find((candidate) => candidate.name.toLowerCase() === name);
  if (!found) throw new Error(`field ${name} missing from ${meta.name}`);
  return found;
}

type TypedFixture = {
  category: string | null;
  fields: Array<{ name: string; kind: VaultFieldKind; value: string }>;
};

/** A small item of each creatable type, with the standard fields every provider has. */
function typedFixture(type: VaultItemType): TypedFixture | null {
  switch (type) {
    case "api_key":
      return {
        category: "database",
        fields: [{ name: "value", kind: "concealed", value: generatePassword({ length: 24 }) }],
      };
    case "note":
      return { category: null, fields: [{ name: "note", kind: "concealed", value: "line 1" }] };
    case "card":
      return {
        category: null,
        fields: [
          { name: "cardholder name", kind: "text", value: "Ada Example" },
          { name: "number", kind: "concealed", value: "4111111111111111" },
          { name: "expiry month", kind: "text", value: "7" },
          { name: "expiry year", kind: "text", value: "2031" },
        ],
      };
    case "identity":
      return {
        category: null,
        fields: [
          { name: "first name", kind: "text", value: "Ada" },
          { name: "last name", kind: "text", value: "Example" },
          { name: "email", kind: "text", value: "ada@example.test" },
        ],
      };
    case "ssh_key": {
      const pair = generateSshKeyPair("ed25519");
      return {
        category: null,
        fields: [
          { name: "private key", kind: "concealed", value: pair.privateKey },
          { name: "public key", kind: "text", value: pair.publicKey },
          { name: "fingerprint", kind: "text", value: pair.fingerprint },
        ],
      };
    }
    default:
      // Logins have their own step; files and passkeys are not created this way.
      return null;
  }
}

/**
 * Behaviour every `VaultProvider` must share (design §10B.1.4, OP-1). Runs
 * against the fake in CI and against live 1Password behind
 * `OPENGENI_ONEPASSWORD_LIVE=1`. Steps share one subject and run in order; one
 * pass costs about 20 provider calls so it fits a FAMILY plan's daily quota.
 */
export function runVaultProviderContractSuite(
  name: string,
  make: () => Promise<VaultProviderUnderTest>,
): void {
  describe(`VaultProvider contract: ${name}`, () => {
    let subject!: VaultProviderUnderTest;
    let created: ProviderItemMeta | null = null;
    const password = generatePassword({ length: 24 });
    const nextPassword = generatePassword({ length: 24 });
    const ready = (async () => {
      subject = await make();
    })();
    const context = (): VaultProviderContext =>
      subject.context?.() ?? {
        connectionId: subject.connectionId ?? null,
        budget: createProviderCallBudget(50),
      };
    const prefix = () => subject.namePrefix ?? "ogtest-";

    afterAll(async () => {
      await ready;
      await subject.cleanup?.();
    });

    test("validates and lists the writable vault with change tokens", async () => {
      await ready;
      await subject.provider.validate(context());
      const vaults = await subject.provider.listVaults(context());
      const rw = vaults.find((vault) => vault.externalVaultId === subject.externalVaultId);
      expect(rw).toBeDefined();
      expect(typeof rw!.name).toBe("string");
      if (subject.readOnlyVaultId) {
        expect(vaults.some((vault) => vault.externalVaultId === subject.readOnlyVaultId)).toBe(
          true,
        );
      }
      // A provider that reports passkeys must be able to hand them out.
      if (subject.provider.capabilities().passkeys)
        expect(typeof subject.provider.readPasskeys).toBe("function");
    });

    test("mirrors item metadata without values and reads values live (including TOTP)", async () => {
      await ready;
      const items = await subject.provider.listItems(context(), subject.externalVaultId);
      for (const item of items) expect(JSON.stringify(item)).not.toContain('"value"');
      if (!subject.fixtureItemName) return;
      const fixture = items.find((item) => item.name === subject.fixtureItemName);
      expect(fixture).toBeDefined();
      const username = field(fixture!, "username");
      const pw = field(fixture!, "password");
      const otp = fixture!.fields.find((candidate) => candidate.kind === "totp");
      expect(pw.kind).toBe("concealed");
      expect(otp).toBeDefined();
      const values = await subject.provider.readFields(
        context(),
        subject.externalVaultId,
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
      if (!subject.provider.capabilities().write) return;
      const itemName = `${prefix()}${crypto.randomUUID().slice(0, 8)}`;
      created = await subject.provider.writeItem(context(), subject.externalVaultId, {
        name: itemName,
        type: "login",
        websites: ["https://login.example.test"],
        fields: [
          { name: "username", kind: "text", value: "ogtest@example.test" },
          { name: "password", kind: "concealed", value: password },
          ...(subject.provider.capabilities().totp
            ? [{ name: "one-time password", kind: "totp" as const, value: TOTP_URI }]
            : []),
        ],
      });
      expect(created.name).toBe(itemName);
      expect(created.type).toBe("login");
      expect(created.websites).toEqual(["https://login.example.test"]);
      expect(field(created, "username").kind).toBe("text");
      expect(field(created, "password").kind).toBe("concealed");
      const listed = await subject.provider.listItems(context(), subject.externalVaultId);
      expect(listed.some((item) => item.externalItemId === created!.externalItemId)).toBe(true);
      const wanted = [field(created, "password").externalFieldId];
      if (subject.provider.capabilities().totp) {
        expect(field(created, "one-time password").kind).toBe("totp");
        wanted.push(field(created, "one-time password").externalFieldId);
      }
      const values = await subject.provider.readFields(
        context(),
        subject.externalVaultId,
        created.externalItemId,
        wanted,
      );
      expect(values[0]!.material).toEqual({ type: "text", value: password });
      const otp = values[1]?.material;
      if (otp) {
        expect(otp.type).toBe("totp");
        if (otp.type === "totp") expect(otp.params.secretBase32).toBe(TOTP_SEED);
      }
    });

    test("updates by field patch with an expected version; a stale version is provider_conflict", async () => {
      await ready;
      if (!subject.provider.capabilities().write) return;
      if (!created) throw new Error("create step failed");
      const before = created;
      const updated = await subject.provider.writeItem(context(), subject.externalVaultId, {
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
      // Untouched fields survive a patch.
      expect(updated.fields.map((f) => f.name).sort()).toEqual(
        before.fields.map((f) => f.name).sort(),
      );
      await expectProviderError(
        subject.provider.writeItem(context(), subject.externalVaultId, {
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
        context(),
        subject.externalVaultId,
        updated.externalItemId,
        [field(updated, "password").externalFieldId],
      );
      expect(value!.material).toEqual({ type: "text", value: nextPassword });
      created = updated;
    });

    test("archives an item; it leaves the active items", async () => {
      await ready;
      if (!subject.provider.capabilities().write) return;
      if (!created) throw new Error("create step failed");
      const archivedId = created.externalItemId;
      await subject.provider.archiveItem(context(), subject.externalVaultId, archivedId);
      const items = await subject.provider.listItems(context(), subject.externalVaultId);
      // A provider may keep listing an archived item, marked with `archivedAt`.
      expect(items.some((item) => item.externalItemId === archivedId && !item.archivedAt)).toBe(
        false,
      );
    });

    test("maps a missing item to provider_not_found", async () => {
      await ready;
      await expectProviderError(
        subject.provider.readFields(context(), subject.externalVaultId, "missing-item", [
          "missing-field",
        ]),
        "provider_not_found",
      );
    });

    test("creates every item type it declares as that type, keeping its category", async () => {
      await ready;
      const types = subject.provider.capabilities().operations?.createItemTypes ?? [];
      for (const type of types) {
        const fixture = typedFixture(type);
        if (!fixture) continue;
        const meta = await subject.provider.writeItem(context(), subject.externalVaultId, {
          name: `${prefix()}${type}-${crypto.randomUUID().slice(0, 8)}`,
          type,
          ...(fixture.category ? { category: fixture.category } : {}),
          websites: [],
          fields: fixture.fields,
        });
        expect([type, meta.type, meta.category ?? null]).toEqual([type, type, fixture.category]);
        for (const expected of fixture.fields) {
          const written = field(meta, expected.name);
          const [value] = await subject.provider.readFields(
            context(),
            subject.externalVaultId,
            meta.externalItemId,
            [written.externalFieldId],
          );
          const material = value!.material;
          // A public key's comment is the provider's own; compare the key itself.
          const comparable = (text: string) =>
            expected.name === "public key"
              ? text.trim().split(/\s+/).slice(0, 2).join(" ")
              : text.trim();
          expect([
            type,
            expected.name,
            material.type === "text" ? comparable(material.value) : null,
          ]).toEqual([type, expected.name, comparable(expected.value)]);
        }
      }
    });

    test("reads from a read-only vault but refuses writes there", async () => {
      await ready;
      if (!subject.readOnlyVaultId) return;
      await subject.provider.listItems(context(), subject.readOnlyVaultId);
      await expectProviderError(
        subject.provider.writeItem(context(), subject.readOnlyVaultId, {
          name: `${prefix()}ro-${crypto.randomUUID().slice(0, 8)}`,
          type: "api_key",
          websites: [],
          fields: [{ name: "value", kind: "concealed", value: "never-stored" }],
        }),
        subject.readOnlyWriteError ?? "provider_permission_denied",
      );
    });
  });
}
