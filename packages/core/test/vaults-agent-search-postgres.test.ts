// Agent secret search against PostgreSQL: it lists everything with no
// filters, pages through every reachable vault with an opaque cursor, finds a
// website match beyond the first page of a large vault, lists the reachable
// vaults on the first page, and refuses a cursor from another search.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { SecretPrincipal, SecretSearchInput, SecretSearchOutput } from "@opengeni/contracts";
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
import { createVaultProviderRegistry } from "@opengeni/vaults";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createVaultService, isVaultError } from "../src/domain/vaults";

setDefaultTimeout(180_000);

const key = new Uint8Array(32).fill(5);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("vaults-agent-search");
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

async function world() {
  const db = client!.db;
  const userId = `vaults-agent-search-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Searcher",
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
  const write = async (vault: VaultRow, name: string, websites: string[] = []) =>
    await upsertVaultItem(db, context, {
      vaultId: vault.id,
      name,
      type: websites.length > 0 ? "login" : "api_key",
      websites,
      fields: [
        {
          name: websites.length > 0 ? "password" : "value",
          kind: "concealed",
          valueEncrypted: encryptEnvironmentValue(Buffer.from(key), `value-${name}`),
          valueSize: 8,
        },
      ],
    });
  const service = createVaultService({
    db,
    encryptionKey: key,
    providers: createVaultProviderRegistry({}),
  });
  const search = (input: Partial<SecretSearchInput>) =>
    service.searchForAgent(principal, { limit: 20, ...input });
  return { db, context, write, search };
}

async function allPages(
  search: (input: Partial<SecretSearchInput>) => Promise<SecretSearchOutput>,
  input: Partial<SecretSearchInput>,
) {
  const pages: SecretSearchOutput[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await search({ ...input, ...(cursor !== undefined ? { cursor } : {}) });
    pages.push(page);
    expect(page.truncated).toBe(page.nextCursor !== null);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("search never finished");
}

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "agent secret search (PostgreSQL)",
  () => {
    test("pages through every item in every reachable vault without gaps or repeats", async () => {
      if (!client) return;
      const w = await world();
      const mine = await createVault(w.db, w.context, { name: "Mine", ownerKind: "user" });
      const team = await createVault(w.db, w.context, { name: "Team", ownerKind: "workspace" });
      for (let index = 0; index < 3; index++) await w.write(mine, `MINE_${index}`);
      for (let index = 0; index < 60; index++)
        await w.write(team, `ITEM_${String(index).padStart(3, "0")}`);
      // Sorts after the first 60, so a scan of only the first page misses it.
      await w.write(team, "ZZ Example", ["https://login.example.com"]);

      const pages = await allPages(w.search, { limit: 25 });
      const names = pages.flatMap((page) => page.items.map((entry) => entry.item.name));
      expect(names).toHaveLength(64);
      expect(new Set(names).size).toBe(64);
      // Only me comes first, then the workspace vault, each by name.
      expect(names.slice(0, 4)).toEqual(["MINE_0", "MINE_1", "MINE_2", "ITEM_000"]);
      expect(names.at(-1)).toBe("ZZ Example");
      expect(pages.map((page) => page.items.length)).toEqual([25, 25, 14]);
      for (const entry of pages.flatMap((page) => page.items))
        expect(JSON.stringify(entry)).not.toContain("value-");

      // The first page lists every reachable vault with its item count.
      expect(pages[0]!.vaults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: mine.id, name: "Mine", ownerKind: "user", itemCount: 3 }),
          expect.objectContaining({ id: team.id, name: "Team", itemCount: 61 }),
        ]),
      );
      expect(pages[1]!.vaults).toBeUndefined();

      // One vault at a time, at the maximum page size.
      const teamPages = await allPages(w.search, { vault: "Team", limit: 50 });
      expect(teamPages.map((page) => page.items.length)).toEqual([50, 11]);
    });

    test("finds a website match beyond the first page of a large vault", async () => {
      if (!client) return;
      const w = await world();
      const team = await createVault(w.db, w.context, { name: "Team", ownerKind: "workspace" });
      for (let index = 0; index < 60; index++)
        await w.write(team, `ITEM_${String(index).padStart(3, "0")}`);
      await w.write(team, "ZZ Example", ["https://login.example.com"]);

      const found = await w.search({ website: "example.com" });
      expect(found.items.map((entry) => entry.item.name)).toEqual(["ZZ Example"]);
      expect(found.items[0]!.references).toBeDefined();
      expect(found.nextCursor).toBeNull();
    });

    test("refuses a cursor from another search or one it did not issue", async () => {
      if (!client) return;
      const w = await world();
      const team = await createVault(w.db, w.context, { name: "Team", ownerKind: "workspace" });
      for (let index = 0; index < 4; index++) await w.write(team, `KEY_${index}`);
      const first = await w.search({ limit: 2 });
      expect(first.nextCursor).not.toBeNull();

      for (const input of [
        { limit: 2, query: "KEY", cursor: first.nextCursor! },
        { limit: 2, cursor: "not-a-cursor" },
      ]) {
        const error = await w.search(input).catch((caught: unknown) => caught);
        expect(isVaultError(error)).toBe(true);
        expect((error as { code: string }).code).toBe("secret_search_cursor_invalid");
      }

      const second = await w.search({ limit: 2, cursor: first.nextCursor! });
      expect(second.items.map((entry) => entry.item.name)).toEqual(["KEY_2", "KEY_3"]);
      expect(second.nextCursor).toBeNull();
    });
  },
);
