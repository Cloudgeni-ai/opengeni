// The real secret resolver against PostgreSQL: one roundtrip, all-or-nothing,
// tiers, aliases after a rename, ambiguity, TOTP material at resolve time,
// file bytes, and a `vault.secret.used` audit row only on success.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  isSecretReferenceError,
  parseSecretReference,
  totpCodeSync,
  type SecretPrincipal,
} from "@opengeni/contracts";
import {
  createDb,
  createVault,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  upsertVaultItem,
  type DbClient,
  type VaultDbContext,
  type VaultRow,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createSecretResolver } from "../src/domain/vaults";

setDefaultTimeout(180_000);

const key = new Uint8Array(32).fill(9);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("vaults-secret-resolver");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Real PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const use = { surface: "shell", toolName: "exec_command" } as const;

async function world() {
  const db = client!.db;
  const userId = `vaults-resolver-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Resolver",
  });
  const grant = access.workspaceGrants[0]!;
  const subjectId = `user:${userId}`;
  const context: VaultDbContext = {
    kind: "subject",
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
  };
  const principal: SecretPrincipal = {
    kind: "human",
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
    verifiedHuman: true,
    viaApiKey: false,
  };
  const write = async (
    vault: VaultRow,
    name: string,
    fields: Array<{ name: string; kind: "text" | "concealed" | "totp" | "file"; value: string }>,
    type: "api_key" | "login" | "file" = "api_key",
  ) =>
    await upsertVaultItem(db, context, {
      vaultId: vault.id,
      name,
      type,
      fields: fields.map((field) => ({
        name: field.name,
        kind: field.kind,
        valueEncrypted: encryptEnvironmentValue(Buffer.from(key), field.value),
        valueSize: Buffer.byteLength(field.value),
      })),
    });
  return { db, context, principal, grant, subjectId, write };
}

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "createSecretResolver (PostgreSQL)",
  () => {
    test("resolves by tier, alias and ID; TOTP and files; all-or-nothing; audited once", async () => {
      if (!client) return;
      const w = await world();
      const mine = await createVault(w.db, w.context, { name: "Mine", ownerKind: "user" });
      const team = await createVault(w.db, w.context, { name: "Team", ownerKind: "workspace" });
      const other = await createVault(w.db, w.context, { name: "Other", ownerKind: "workspace" });
      // Same name in the Only-me tier and the workspace tier: Only me wins.
      await w.write(mine, "OPENAI_API_KEY", [
        { name: "value", kind: "concealed", value: "sk-mine" },
      ]);
      await w.write(team, "OPENAI_API_KEY", [
        { name: "value", kind: "concealed", value: "sk-team" },
      ]);
      // Same name twice in one tier: ambiguous unless the vault is named.
      await w.write(team, "DUP", [{ name: "value", kind: "concealed", value: "dup-team" }]);
      await w.write(other, "DUP", [{ name: "value", kind: "concealed", value: "dup-other" }]);
      const login = await w.write(
        team,
        "GitHub",
        [
          { name: "username", kind: "text", value: "octo" },
          { name: "password", kind: "concealed", value: "hunter2" },
          { name: "one-time password", kind: "totp", value: "JBSWY3DPEHPK3PXP" },
        ],
        "login",
      );
      const file = await w.write(
        team,
        "Cert",
        [{ name: "file", kind: "file", value: Buffer.from([0, 1, 2, 255]).toString("base64") }],
        "file",
      );
      // Rename keeps the old name as an alias.
      const renamed = await w.write(team, "OLD_NAME", [
        { name: "value", kind: "concealed", value: "aliased" },
      ]);
      await upsertVaultItem(w.db, w.context, { itemId: renamed.id, name: "NEW_NAME" });

      const resolver = createSecretResolver({ db: w.db, encryptionKey: key }, w.principal, {
        capabilityEnabled: true,
      });
      const refs = [
        "{{secret:OPENAI_API_KEY}}",
        "{{secret:Team/OPENAI_API_KEY}}",
        "{{secret:Other/DUP}}",
        "{{secret:GitHub/password}}",
        "{{secret:GitHub/otp}}",
        "{{secretfile:Cert}}",
        "{{secret:OLD_NAME}}",
        `{{secret:id:${login.id}/username}}`,
      ].map(parseSecretReference);
      const resolved = await resolver.resolve(refs, use);
      const material = (raw: string) =>
        resolved.get([...resolved.keys()].find((k) => resolved.get(k)!.reference.raw === raw)!)!
          .material;
      expect(material("{{secret:OPENAI_API_KEY}}")).toEqual({ type: "text", value: "sk-mine" });
      expect(material("{{secret:Team/OPENAI_API_KEY}}")).toEqual({
        type: "text",
        value: "sk-team",
      });
      expect(material("{{secret:Other/DUP}}")).toEqual({ type: "text", value: "dup-other" });
      expect(material("{{secret:GitHub/password}}")).toEqual({ type: "text", value: "hunter2" });
      expect(material("{{secret:OLD_NAME}}")).toEqual({ type: "text", value: "aliased" });
      expect(material(`{{secret:id:${login.id}/username}}`)).toEqual({
        type: "text",
        value: "octo",
      });
      const otp = material("{{secret:GitHub/otp}}");
      expect(otp.type).toBe("totp");
      if (otp.type === "totp") {
        // The code is computed from the setup key at dispatch; nothing time-based is stored.
        expect(totpCodeSync(otp.params, 59_000)).toMatch(/^\d{6}$/);
      }
      const bytes = material("{{secretfile:Cert}}");
      expect(bytes.type).toBe("bytes");
      if (bytes.type === "bytes") expect([...bytes.value]).toEqual([0, 1, 2, 255]);
      expect(resolved.size).toBe(refs.length);

      const used = async () =>
        (
          await shared!.admin<{ count: number }[]>`
            select count(*)::int as count from audit_events
            where account_id = ${w.grant.accountId}::uuid and action = 'vault.secret.used'`
        )[0]!.count;
      expect(await used()).toBe(1);

      // All-or-nothing: one bad reference fails the whole call, with every
      // failure listed, and nothing is audited.
      let failure: unknown;
      try {
        await resolver.resolve(
          [
            "{{secret:OPENAI_API_KEY}}",
            "{{secret:DUP}}",
            "{{secret:MISSING_KEY}}",
            "{{secret:GitHub/nope}}",
          ].map(parseSecretReference),
          use,
        );
      } catch (error) {
        failure = error;
      }
      expect(isSecretReferenceError(failure)).toBe(true);
      if (isSecretReferenceError(failure)) {
        expect(failure.failures.map((entry) => [entry.raw, entry.code])).toEqual([
          ["{{secret:DUP}}", "ambiguous"],
          ["{{secret:MISSING_KEY}}", "not_found"],
          ["{{secret:GitHub/nope}}", "not_found"],
        ]);
        // A missing value with an acting human offers an ask card.
        expect(failure.askCard).not.toBeNull();
      }
      expect(await used()).toBe(1);

      // Turned-off capability refuses every reference without a lookup.
      const off = createSecretResolver({ db: w.db, encryptionKey: key }, w.principal, {
        capabilityEnabled: false,
      });
      expect(off.enabled).toBe(false);
      let denied: unknown;
      try {
        await off.resolve([parseSecretReference("{{secret:OPENAI_API_KEY}}")], use);
      } catch (error) {
        denied = error;
      }
      expect(isSecretReferenceError(denied) && denied.failures[0]!.code).toBe("denied");
      expect(file.id).toBeTruthy();
    });
  },
);
