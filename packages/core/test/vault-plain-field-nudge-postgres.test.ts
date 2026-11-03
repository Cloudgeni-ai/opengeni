// The save-time nudge for plain fields against PostgreSQL (docs/secrets.md,
// Field kinds): secret_save saves a token-shaped value in a field that would
// default to text as concealed and says so, keeps an explicit text kind with
// a note, and never refuses the save. Every value here is fake.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { SecretSaveInput, type SecretPrincipal } from "@opengeni/contracts";
import { createDb, ensureManagedAccessForUser, getVaultItem, type DbClient } from "@opengeni/db";
import { createVaultProviderRegistry } from "@opengeni/vaults";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createVaultService } from "../src/domain/vaults";

setDefaultTimeout(180_000);

const key = new Uint8Array(32).fill(9);
const TOKEN = `ghp_${"Ab1Cd2Ef3".repeat(4)}`;
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("vault-plain-field-nudge");
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

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "plain field nudge (PostgreSQL)",
  () => {
    test("a token in a field that defaults to text is saved concealed; explicit text is kept", async () => {
      if (!client) return;
      const db = client.db;
      const userId = `vault-plain-field-nudge-${crypto.randomUUID()}`;
      const access = await ensureManagedAccessForUser(db, {
        userId,
        email: `${userId}@example.test`,
        name: "Nudge",
      });
      const grant = access.workspaceGrants[0]!;
      const subjectId = `user:${userId}`;
      const principal: SecretPrincipal = {
        kind: "human",
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId,
        verifiedHuman: true,
        viaApiKey: false,
      };
      const service = createVaultService({
        db,
        encryptionKey: key,
        providers: createVaultProviderRegistry({}),
      });
      const saved = await service.saveForAgent(
        principal,
        SecretSaveInput.parse({
          item: "Nudged login",
          saveTo: "user",
          username: "deploy-bot",
          fields: [
            { name: "password", generate: { length: 20 } },
            // `account` defaults to text; this value is a token.
            { name: "account", value: TOKEN },
            { name: "note", kind: "text", value: TOKEN },
          ],
          mode: "create",
        }),
      );
      expect(saved.fieldNotes).toEqual([
        {
          field: "account",
          kind: "concealed",
          reason: "format",
          message:
            'Looks like a GitHub token. Saved as concealed; save it with kind "text" if it is not a secret.',
        },
        {
          field: "note",
          kind: "text",
          reason: "format",
          message:
            'Looks like a GitHub token. Kept as text; save it with kind "concealed" if it is a secret.',
        },
      ]);
      expect(JSON.stringify(saved)).not.toContain(TOKEN);
      const item = await getVaultItem(
        db,
        {
          kind: "subject",
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId,
        },
        { itemId: saved.item.id },
      );
      const kinds = Object.fromEntries(item.fields.map((field) => [field.name, field.kind]));
      expect(kinds).toEqual({
        username: "text",
        password: "concealed",
        account: "concealed",
        note: "text",
      });

      // A plain value that does not look secret gets no note.
      const plain = await service.saveForAgent(
        principal,
        SecretSaveInput.parse({
          item: "Plain login",
          saveTo: "user",
          username: "deploy-bot",
          fields: [{ name: "account", value: "acme-prod" }],
          mode: "create",
        }),
      );
      expect(plain.fieldNotes).toBeUndefined();
    });
  },
);
