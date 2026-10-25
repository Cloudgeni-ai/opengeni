import { describe, expect, test } from "bun:test";
import {
  createProviderCallBudget,
  generateSshKeyPair,
  type VaultProviderContext,
} from "@opengeni/vaults";
import { runVaultProviderContractSuite } from "@opengeni/vaults/testing";
import {
  connectBitwarden,
  createBitwardenVaultProvider,
  PERSONAL_VAULT_ID,
  type BitwardenVaultProvider,
} from "../src/provider";

/**
 * The shared provider contract against a real Bitwarden or Vaultwarden
 * account, behind OPENGENI_BITWARDEN_LIVE=1. Use a dedicated test account:
 *
 *   OPENGENI_BITWARDEN_SERVER          https://vault.bitwarden.com, .eu or self-hosted
 *   OPENGENI_BITWARDEN_CLIENT_ID       user.<uuid> (Settings, Security, Keys, View API key)
 *   OPENGENI_BITWARDEN_CLIENT_SECRET
 *   OPENGENI_BITWARDEN_MASTER_PASSWORD used once to open the account, never stored
 *   OPENGENI_BITWARDEN_FIXTURE         a login in My vault with username, password and TOTP
 *                                      (default "Example login")
 *   OPENGENI_BITWARDEN_SSH_FIXTURE     optional: an SSH key item in My vault, checked to be listed
 *   OPENGENI_BITWARDEN_ALLOW_HTTP=1    optional: a local http:// server (a throwaway Vaultwarden)
 *
 * Throwaway items are named `ogtest-…` and end in the account's trash.
 * The round-trip test rewrites every writable item unchanged and checks that
 * nothing was lost, and the card test changes a card's security code and
 * puts it back.
 */
const live = process.env.OPENGENI_BITWARDEN_LIVE === "1";
const allowHttp = process.env.OPENGENI_BITWARDEN_ALLOW_HTTP === "1";
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the live Bitwarden tests`);
  return value;
};

let connected: Promise<BitwardenVaultProvider> | null = null;
function provider(): Promise<BitwardenVaultProvider> {
  connected ??= connectBitwarden(
    {
      serverUrl: env("OPENGENI_BITWARDEN_SERVER"),
      clientId: env("OPENGENI_BITWARDEN_CLIENT_ID"),
      clientSecret: env("OPENGENI_BITWARDEN_CLIENT_SECRET"),
      masterPassword: env("OPENGENI_BITWARDEN_MASTER_PASSWORD"),
    },
    { fetch: (input, init) => fetch(input, init), allowHttp },
  ).then(({ credentials }) =>
    createBitwardenVaultProvider({
      credentials,
      fetch: (input, init) => fetch(input, init),
      allowHttp,
    }),
  );
  return connected;
}

const context = (): VaultProviderContext => ({
  connectionId: "conn-live",
  budget: createProviderCallBudget(50),
});

async function valuesOf(
  bitwarden: BitwardenVaultProvider,
  vaultId: string,
  item: { externalItemId: string; fields: { externalFieldId: string; kind: string }[] },
) {
  const ids = item.fields
    .filter((field) => field.kind !== "file")
    .map((field) => field.externalFieldId);
  if (ids.length === 0) return [];
  return bitwarden.readFields(context(), vaultId, item.externalItemId, ids);
}

if (live) {
  runVaultProviderContractSuite("Bitwarden adapter (live account)", async () => ({
    provider: await provider(),
    externalVaultId: PERSONAL_VAULT_ID,
    fixtureItemName: process.env.OPENGENI_BITWARDEN_FIXTURE ?? "Example login",
    context,
  }));

  describe("Bitwarden adapter (live account): beyond the contract", () => {
    test("lists organization collections and reads every item type there is", async () => {
      const bitwarden = await provider();
      const vaults = await bitwarden.listVaults(context());
      expect(vaults[0]?.externalVaultId).toBe(PERSONAL_VAULT_ID);
      for (const vault of vaults) {
        const items = await bitwarden.listItems(context(), vault.externalVaultId);
        // The count is of active items; archived ones are listed too, marked archived.
        const active = items.filter((item) => !item.archivedAt);
        expect(active.length).toBe(vault.itemCount ?? active.length);
        for (const item of items) {
          const readable = item.fields.slice(0, 8).map((field) => field.externalFieldId);
          if (readable.length === 0) continue;
          const values = await bitwarden.readFields(
            context(),
            vault.externalVaultId,
            item.externalItemId,
            readable,
          );
          expect(values.map((value) => value.externalFieldId)).toEqual(readable);
        }
      }
    });

    test("rewriting any item unchanged keeps every field, value and attachment", async () => {
      const bitwarden = await provider();
      for (const vault of await bitwarden.listVaults(context())) {
        if (vault.writeAccess !== "read_write") continue;
        for (const item of await bitwarden.listItems(context(), vault.externalVaultId)) {
          const before = await valuesOf(bitwarden, vault.externalVaultId, item);
          const saved = await bitwarden.writeItem(context(), vault.externalVaultId, {
            externalItemId: item.externalItemId,
            name: item.name,
            type: item.type,
            category: item.category ?? null,
            websites: item.websites,
            fields: [],
          });
          expect(saved.type).toBe(item.type);
          expect(saved.category ?? null).toBe(item.category ?? null);
          expect(saved.fields).toEqual(item.fields);
          expect(saved.websites).toEqual(item.websites);
          expect(await valuesOf(bitwarden, vault.externalVaultId, saved)).toEqual(before);
        }
      }
    }, 120_000);

    test("changes a card's own field and puts it back", async () => {
      const bitwarden = await provider();
      const items = await bitwarden.listItems(context(), PERSONAL_VAULT_ID);
      const card = items.find((item) =>
        item.fields.some((field) => field.externalFieldId === "card.code"),
      );
      if (!card) return;
      const read = async () =>
        (
          await bitwarden.readFields(context(), PERSONAL_VAULT_ID, card.externalItemId, [
            "card.code",
          ])
        )[0]!.material;
      const original = await read();
      if (original.type !== "text") throw new Error("a card code is text");
      const write = (value: string) =>
        bitwarden.writeItem(context(), PERSONAL_VAULT_ID, {
          externalItemId: card.externalItemId,
          name: card.name,
          type: card.type,
          websites: [],
          fields: [
            { externalFieldId: "card.code", name: "security code", kind: "concealed", value },
          ],
        });
      try {
        await write("999");
        expect(await read()).toEqual({ type: "text", value: "999" });
      } finally {
        await write(original.value);
      }
      expect(await read()).toEqual(original);
    });

    test("lists SSH keys: every request declares a client version", async () => {
      const name = process.env.OPENGENI_BITWARDEN_SSH_FIXTURE;
      if (!name) return;
      const bitwarden = await provider();
      const items = await bitwarden.listItems(context(), PERSONAL_VAULT_ID);
      const key = items.find((item) => item.name === name);
      expect(key?.fields.map((field) => field.externalFieldId)).toContain("sshKey.privateKey");
      const [value] = await bitwarden.readFields(
        context(),
        PERSONAL_VAULT_ID,
        key!.externalItemId,
        ["sshKey.privateKey"],
      );
      expect(value!.material.type).toBe("text");
    });

    test("creates an SSH key and replaces its key pair", async () => {
      const bitwarden = await provider();
      const first = generateSshKeyPair("ed25519");
      // Opengeni derives the public key and fingerprint before the adapter writes.
      const keyFields = (pair: typeof first) => [
        { name: "private key", kind: "concealed" as const, value: pair.privateKey },
        { name: "public key", kind: "text" as const, value: pair.publicKey },
        { name: "fingerprint", kind: "text" as const, value: pair.fingerprint },
      ];
      const created = await bitwarden.writeItem(context(), PERSONAL_VAULT_ID, {
        name: `ogtest-ssh-${crypto.randomUUID().slice(0, 8)}`,
        type: "ssh_key",
        websites: [],
        fields: keyFields(first),
      });
      expect(created.type).toBe("ssh_key");
      const derived = async () =>
        (
          await bitwarden.readFields(context(), PERSONAL_VAULT_ID, created.externalItemId, [
            "sshKey.publicKey",
            "sshKey.keyFingerprint",
          ])
        ).map((value) => (value.material.type === "text" ? value.material.value : null));
      const [publicKey, fingerprint] = await derived();
      expect(publicKey?.split(" ").slice(0, 2)).toEqual(first.publicKey.split(" ").slice(0, 2));
      expect(fingerprint).toBe(first.fingerprint);
      const next = generateSshKeyPair("ed25519");
      await bitwarden.writeItem(context(), PERSONAL_VAULT_ID, {
        externalItemId: created.externalItemId,
        name: created.name,
        type: "ssh_key",
        websites: [],
        fields: keyFields(next).map((field, index) => ({
          ...field,
          externalFieldId: ["sshKey.privateKey", "sshKey.publicKey", "sshKey.keyFingerprint"][
            index
          ]!,
        })),
      });
      const [nextPublic, nextFingerprint] = await derived();
      expect(nextPublic?.split(" ").slice(0, 2)).toEqual(next.publicKey.split(" ").slice(0, 2));
      expect(nextFingerprint).toBe(next.fingerprint);
      const listed = (await bitwarden.listItems(context(), PERSONAL_VAULT_ID)).find(
        (item) => item.externalItemId === created.externalItemId,
      );
      expect(listed?.type).toBe("ssh_key");
      await bitwarden.archiveItem(context(), PERSONAL_VAULT_ID, created.externalItemId);
    }, 60_000);

    test("creates API keys and files that read back as their own types; adds, replaces and removes attachments", async () => {
      const bitwarden = await provider();
      const suffix = crypto.randomUUID().slice(0, 8);
      const apiKey = await bitwarden.writeItem(context(), PERSONAL_VAULT_ID, {
        name: `ogtest-api-${suffix}`,
        type: "api_key",
        category: "database",
        websites: [],
        fields: [{ name: "credential", kind: "concealed", value: "sk_live_test" }],
      });
      const listedApiKey = (await bitwarden.listItems(context(), PERSONAL_VAULT_ID)).find(
        (item) => item.externalItemId === apiKey.externalItemId,
      );
      expect(listedApiKey?.type).toBe("api_key");
      expect(listedApiKey?.category).toBe("database");
      const credential = apiKey.fields.find((field) => field.name === "credential")!;
      expect(
        (
          await bitwarden.readFields(context(), PERSONAL_VAULT_ID, apiKey.externalItemId, [
            credential.externalFieldId,
          ])
        )[0]!.material,
      ).toEqual({ type: "text", value: "sk_live_test" });

      const bytes = (text: string) => new TextEncoder().encode(text);
      const file = await bitwarden.writeItem(context(), PERSONAL_VAULT_ID, {
        name: `ogtest-file-${suffix}`,
        type: "file",
        websites: [],
        fields: [
          { name: "file", kind: "file", file: { name: "config.yaml", bytes: bytes("one") } },
        ],
      });
      expect(file.type).toBe("file");
      const first = file.fields.find((field) => field.kind === "file")!;
      const readFile = async (id: string) =>
        (await bitwarden.readFields(context(), PERSONAL_VAULT_ID, file.externalItemId, [id]))[0]!
          .material;
      expect(await readFile(first.externalFieldId)).toEqual({ type: "bytes", value: bytes("one") });
      const replaced = await bitwarden.writeItem(context(), PERSONAL_VAULT_ID, {
        externalItemId: file.externalItemId,
        name: file.name,
        type: "file",
        websites: [],
        fields: [
          {
            externalFieldId: first.externalFieldId,
            name: "file",
            kind: "file",
            file: { name: "file", bytes: bytes("two") },
          },
        ],
      });
      const second = replaced.fields.filter((field) => field.kind === "file");
      expect(second).toHaveLength(1);
      expect(await readFile(second[0]!.externalFieldId)).toEqual({
        type: "bytes",
        value: bytes("two"),
      });
      const removed = await bitwarden.writeItem(context(), PERSONAL_VAULT_ID, {
        externalItemId: file.externalItemId,
        name: file.name,
        type: "file",
        websites: [],
        fields: [
          { externalFieldId: second[0]!.externalFieldId, name: "file", kind: "file", remove: true },
        ],
      });
      expect(removed.fields.some((field) => field.kind === "file")).toBe(false);
      for (const item of [apiKey, file]) {
        await bitwarden.archiveItem(context(), PERSONAL_VAULT_ID, item.externalItemId);
      }
    }, 60_000);

    test("archives with Bitwarden's Archive where the server has it; updates keep it archived", async () => {
      const bitwarden = await provider();
      const [personal] = await bitwarden.listVaults(context());
      const archiveKind = personal!.operations?.archiveKind ?? "archive";
      const item = await bitwarden.writeItem(context(), PERSONAL_VAULT_ID, {
        name: `ogtest-archive-${crypto.randomUUID().slice(0, 8)}`,
        type: "login",
        websites: [],
        fields: [{ name: "password", kind: "concealed", value: "p" }],
      });
      await bitwarden.archiveItem(context(), PERSONAL_VAULT_ID, item.externalItemId);
      const listed = () =>
        bitwarden
          .listItems(context(), PERSONAL_VAULT_ID)
          .then((items) =>
            items.find((candidate) => candidate.externalItemId === item.externalItemId),
          );
      if (archiveKind === "trash") {
        expect(await listed()).toBeUndefined();
        return;
      }
      expect((await listed())?.archivedAt).toBeString();
      await bitwarden.writeItem(context(), PERSONAL_VAULT_ID, {
        externalItemId: item.externalItemId,
        name: item.name,
        type: "login",
        websites: [],
        fields: [
          { externalFieldId: "login.password", name: "password", kind: "concealed", value: "q" },
        ],
      });
      expect((await listed())?.archivedAt).toBeString();
    }, 60_000);
  });
}
