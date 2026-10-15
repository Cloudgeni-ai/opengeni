// Connected vaults tell the truth about what was checked (external vaults
// §8–§10), against PostgreSQL: every search page names the connected sources
// and whether they are current; an outage is never an empty healthy vault or
// a missing-secret ask card; a deliberate refresh re-lists and advances the
// durable value-cache epoch but never bypasses a provider rate limit; an
// inventory that cannot be mirrored as listed (an item beyond the mirror
// limits, or pages without a snapshot) keeps the previous mirror; a write
// the vault does not allow is refused before any value is resolved or any
// provider mutation; and an unconfirmed or not-yet-listed write is never
// presented as safe to repeat.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  isSecretReferenceError,
  parseSecretReference,
  SecretSaveInput,
  SecretSearchInput,
  SecretSearchOutput,
  VAULT_LIMITS,
  VaultSummary,
  type SecretPrincipal,
  type SecretReferenceError,
  type VaultProviderFreshness,
  type VaultProviderOperations,
} from "@opengeni/contracts";
import {
  createConnection,
  createDb,
  createVault,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  getVault,
  getVaultItem,
  linkProviderVault,
  setVaultSyncStatus,
  upsertVaultItem,
  type DbClient,
  type VaultDbContext,
  type VaultError,
} from "@opengeni/db";
import {
  createProviderCallBudget,
  createVaultProviderRegistry,
  VaultProviderError,
  type ProviderItemMeta,
  type ProviderVault,
  type VaultProvider,
} from "@opengeni/vaults";
import {
  createFakeVaultProvider,
  type FakeProviderSeed,
} from "@opengeni/vaults/testing/fake-provider";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createSecretResolver, createVaultService, isVaultError } from "../src/domain/vaults";
import {
  LINKED_VAULT_MISS_MAX_AGE_MS,
  LINKED_VAULT_SEARCH_MAX_AGE_MS,
  refreshLinkedVaults,
  syncLinkedProviderVault,
} from "../src/domain/vaults/provider-sync";

setDefaultTimeout(180_000);

const key = new Uint8Array(32).fill(7);
const use = { surface: "browser", toolName: "browser_act" } as const;
// Built at runtime so tooling never treats them as live references.
const reference = (path: string) => parseSecretReference(["{{secret", `${path}}}`].join(":"));

/** A provider that creates logins only, with no field removal, archive or one-time passwords. */
const LOGIN_ONLY: VaultProviderOperations = {
  createItemTypes: ["login"],
  updateItem: true,
  removeField: false,
  archiveItem: false,
  archiveKind: "none",
  deleteItem: false,
  restoreItem: false,
  readFiles: true,
  writeFiles: false,
  createTotp: false,
  updateTotp: false,
  createVault: false,
  restoreFieldHistory: false,
};

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("vault-provider-freshness");
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

async function refusal(promise: Promise<unknown>): Promise<VaultError> {
  try {
    await promise;
  } catch (error) {
    if (isVaultError(error)) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

function sourceOf(output: SecretSearchOutput, vaultId: string) {
  return output.sources?.find((source) => source.vaultId === vaultId)?.freshness;
}

const names = (output: SecretSearchOutput) => output.items.map((result) => result.item.name);

type Controls = {
  /** Operations the provider reports; null derives them from its legacy flags. */
  operations: VaultProviderOperations | null;
  /** Provider vaults this credential may only read. */
  readOnlyVaults: Set<string>;
  /** The bridge's own upstream observation, reported on every vault listing. */
  freshness: VaultProviderFreshness | null;
  /** Holds vault listings until resolved. */
  gate: Promise<void> | null;
  /** Thrown by writeItem, as if the request was lost after it was sent. */
  writeThrows: unknown;
  /** After a write lands, the provider rate limits every later call. */
  rateLimitAfterWrite: boolean;
  epochs: Array<string | null | undefined>;
  forced: boolean[];
};

async function world(options: { operations?: VaultProviderOperations } = {}) {
  const db = client!.db;
  const userId = `vault-provider-freshness-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Freshness",
  });
  const grant = access.workspaceGrants[0]!;
  const actor = { grant, accountAdmin: false };
  const workspaceId = grant.workspaceId;
  const subjectId = `user:${userId}`;
  const context: VaultDbContext = {
    kind: "subject",
    accountId: grant.accountId,
    workspaceId,
    subjectId,
  };
  const principal: SecretPrincipal = {
    kind: "human",
    accountId: grant.accountId,
    workspaceId,
    subjectId,
    verifiedHuman: true,
    viaApiKey: false,
  };
  const seed: FakeProviderSeed = {
    failWith: null,
    vaults: [
      {
        externalVaultId: "company",
        name: "Company",
        items: [
          {
            name: "Company card",
            type: "api_key",
            fields: [{ name: "value", value: "company-secret" }],
          },
        ],
      },
      {
        externalVaultId: "ops",
        name: "Ops",
        items: [
          { name: "Ops token", type: "api_key", fields: [{ name: "value", value: "ops-secret" }] },
        ],
      },
      { externalVaultId: "partners", name: "Partners", readOnly: true },
    ],
  };
  const fake = createFakeVaultProvider(seed);
  const controls: Controls = {
    operations: options.operations ?? null,
    readOnlyVaults: new Set(["partners"]),
    freshness: null,
    gate: null,
    writeThrows: null,
    rateLimitAfterWrite: false,
    epochs: [],
    forced: [],
  };
  const host: VaultProvider & { calls: typeof fake.calls } = {
    ...fake,
    capabilities: () => ({
      ...fake.capabilities(),
      ...(controls.operations ? { operations: controls.operations } : {}),
    }),
    async listVaults(ctx) {
      controls.forced.push(ctx.forceRefresh === true);
      if (controls.gate) await controls.gate;
      const vaults = await fake.listVaults(ctx);
      if (controls.freshness) ctx.onFreshness?.(controls.freshness);
      return vaults.map(
        (vault): ProviderVault =>
          controls.readOnlyVaults.has(vault.externalVaultId)
            ? { ...vault, writeAccess: "read_only" }
            : vault,
      );
    },
    async readFields(ctx, externalVaultId, externalItemId, externalFieldIds) {
      controls.epochs.push(ctx.cacheEpoch);
      return await fake.readFields(ctx, externalVaultId, externalItemId, externalFieldIds);
    },
    async writeItem(ctx, externalVaultId, input) {
      if (controls.writeThrows !== null) {
        fake.calls.push({ op: "writeItem", connectionId: ctx.connectionId, externalVaultId });
        throw controls.writeThrows;
      }
      const written = await fake.writeItem(ctx, externalVaultId, input);
      if (controls.rateLimitAfterWrite) seed.failWith = "provider_rate_limited";
      return written;
    },
  };
  const providers = createVaultProviderRegistry({ host: async () => host });
  const service = createVaultService({ db, encryptionKey: key, providers });
  const link = async (name: string, providerVaultRef: string, mode: "read_only" | "read_write") => {
    const vault = await linkProviderVault(db, context, {
      ownerKind: "workspace",
      name,
      source: "host",
      providerVaultRef,
      mode,
    });
    await syncLinkedProviderVault({ db, context, vaultId: vault.id, providers, force: true });
    return vault;
  };
  const company = await link("Company", "company", "read_write");
  const ops = await link("Ops", "ops", "read_only");
  const team = await createVault(db, context, { name: "Team", ownerKind: "workspace" });
  const hosted = async (
    name: string,
    type: "api_key" | "login",
    fields: Array<{ name: string; kind: "text" | "concealed" | "totp"; value: string }>,
  ) =>
    await upsertVaultItem(db, context, {
      vaultId: team.id,
      name,
      type,
      fields: fields.map((field) => ({
        name: field.name,
        kind: field.kind,
        valueEncrypted: encryptEnvironmentValue(Buffer.from(key), field.value),
        valueSize: Buffer.byteLength(field.value),
      })),
    });
  const teamToken = await hosted("Team token", "api_key", [
    { name: "value", kind: "concealed", value: "team-secret" },
  ]);
  return {
    db,
    context,
    subjectId,
    principal,
    actor,
    workspaceId,
    seed,
    controls,
    host,
    providers,
    service,
    link,
    hosted,
    company,
    ops,
    team,
    teamToken,
    async age(vault: { id: string }, ms: number) {
      await shared!.admin`
        update vaults set last_synced_at = now() - make_interval(secs => ${ms / 1000})
        where id = ${vault.id}`;
    },
    reload: async (vault: { id: string }) => await getVault(db, context, { vaultId: vault.id }),
    calls: (op: string) => host.calls.filter((call) => call.op === op).length,
    resolver: () =>
      createSecretResolver({ db, encryptionKey: key, providers }, principal, {
        capabilityEnabled: true,
      }),
    search: async (input: Record<string, unknown>) =>
      SecretSearchOutput.parse(
        await service.searchForAgent(principal, SecretSearchInput.parse(input)),
      ),
    async item(vault: { id: string }, name: string) {
      const page = await service.listItems(actor, workspaceId, vault.id, {});
      const summary = page.items.find((candidate) => candidate.name === name);
      if (!summary) throw new Error(`${name} is not listed`);
      return await getVaultItem(db, context, { itemId: summary.id });
    },
    async clearRateLimit(vault: { id: string }) {
      seed.failWith = null;
      controls.rateLimitAfterWrite = false;
      await setVaultSyncStatus(db, context, {
        vaultId: vault.id,
        status: "ok",
        rateLimitedUntil: null,
      });
      await syncLinkedProviderVault({ db, context, vaultId: vault.id, providers, force: true });
    },
  };
}

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "connected vault freshness, discovery and writes",
  () => {
    test("every search page names the connected sources, and an outage is never a healthy empty vault", async () => {
      if (!client) return;
      const w = await world();
      // The bridge reports when it last synchronized with its own upstream.
      const upstream = new Date(Date.now() - 60 * 60_000).toISOString();
      w.controls.freshness = {
        state: "current",
        lastCheckedAt: null,
        sourceSyncedAt: upstream,
        source: "cache",
        errorCode: null,
        retryAt: null,
      };
      await w.age(w.company, LINKED_VAULT_SEARCH_MAX_AGE_MS + 1_000);
      const epoch = (await w.reload(w.company)).providerCacheEpoch;
      const lists = w.calls("listVaults");
      const itemLists = w.calls("listItems");

      const first = await w.search({ limit: 1 });
      // Only the stale mirror was checked: unchanged, so no item listing.
      expect(w.calls("listVaults")).toBe(lists + 1);
      expect(w.calls("listItems")).toBe(itemLists);
      expect(w.controls.forced.at(-1)).toBe(false);
      expect(names(first)).toEqual(["Company card"]);
      expect(first.complete).toBe(true);
      expect(first.sources).toHaveLength(2);
      expect(sourceOf(first, w.company.id)).toMatchObject({
        state: "current",
        source: "cache",
        sourceSyncedAt: upstream,
        errorCode: null,
        retryAt: null,
      });
      // Opengeni's own check time never stands in for the provider's.
      expect(sourceOf(first, w.company.id)!.lastCheckedAt).not.toBe(upstream);
      expect(sourceOf(first, w.ops.id)).toMatchObject({
        state: "current",
        source: "unknown",
        sourceSyncedAt: null,
      });
      const listed = (id: string) => first.vaults!.find((vault) => vault.id === id)!;
      expect(listed(w.company.id).freshness).toMatchObject({ state: "current" });
      expect(listed(w.team.id).freshness).toBeUndefined();
      // An unchanged check records its time and the provider's observation, not a new epoch.
      const checked = await w.reload(w.company);
      expect(checked.providerFreshness).toEqual({ source: "cache", sourceSyncedAt: upstream });
      expect(checked.providerCacheEpoch).toBe(epoch);
      expect(Date.parse(checked.lastSyncedAt!)).toBeGreaterThan(Date.now() - 60_000);

      const second = await w.search({ limit: 1, cursor: first.nextCursor });
      expect(names(second)).toEqual(["Ops token"]);
      expect(second.vaults).toBeUndefined();
      expect(second.complete).toBe(true);
      expect(second.sources).toHaveLength(2);

      // The provider goes down while the Company mirror is stale.
      w.seed.failWith = "provider_unavailable";
      await w.age(w.company, LINKED_VAULT_SEARCH_MAX_AGE_MS + 1_000);
      const down = await w.search({ limit: 1 });
      expect(w.calls("listVaults")).toBe(lists + 2);
      // The kept mirror is still searchable, but the result says it was not checked.
      expect(names(down)).toEqual(["Company card"]);
      expect(down.complete).toBe(false);
      expect(sourceOf(down, w.company.id)).toMatchObject({
        state: "unavailable",
        errorCode: "provider_unavailable",
        retryAt: null,
        source: "cache",
        sourceSyncedAt: upstream,
      });
      expect(sourceOf(down, w.ops.id)!.state).toBe("current");
      const downNext = await w.search({ limit: 1, cursor: down.nextCursor });
      expect(downNext.complete).toBe(false);
      expect(sourceOf(downNext, w.company.id)!.state).toBe("unavailable");
      // A failed check is retried once per period, not on every page.
      expect(w.calls("listVaults")).toBe(lists + 2);

      // Searches scoped to a healthy or a hosted vault are not marked incomplete by it.
      const opsOnly = await w.search({ vault: "Ops" });
      expect(opsOnly.complete).toBe(true);
      expect(opsOnly.sources!.map((source) => source.vaultId)).toEqual([w.ops.id]);
      const hostedOnly = await w.search({ vault: "Team" });
      expect(hostedOnly).toMatchObject({ complete: true, sources: [] });
      expect(names(hostedOnly)).toEqual(["Team token"]);
    });

    test("a deliberate refresh re-lists and advances the value-cache epoch, never past a rate limit", async () => {
      if (!client) return;
      const w = await world();
      const epochOf = async (vault: { id: string }) =>
        BigInt((await w.reload(vault)).providerCacheEpoch!);
      const before = await epochOf(w.company);
      const itemLists = w.calls("listItems");

      const page = await w.search({ limit: 1, refresh: true });
      // Both fresh connected vaults were re-listed, bypassing provider caches.
      expect(w.calls("listItems")).toBe(itemLists + 2);
      expect(w.controls.forced.slice(-2)).toEqual([true, true]);
      expect(page.complete).toBe(true);
      const epoch = await epochOf(w.company);
      expect(epoch).toBe(before + 1n);
      // A later page of the same search does not refresh again.
      await w.search({ limit: 1, refresh: true, cursor: page.nextCursor });
      expect(w.calls("listItems")).toBe(itemLists + 2);

      // Every value read carries the durable epoch, so a refresh anywhere
      // invalidates provider value caches in every process.
      const read = async () =>
        [
          ...(await w.resolver().resolve([reference("Company/Company card/value")], use)).values(),
        ][0]!.material;
      expect(await read()).toEqual({ type: "text", value: "company-secret" });
      expect(w.controls.epochs.at(-1)).toBe(String(epoch));
      const card = await w.item(w.company, "Company card");
      await w.service.revealField(w.actor, w.workspaceId, card.fields[0]!.id, {});
      expect(w.controls.epochs.at(-1)).toBe(String(epoch));
      await w.service.readForAgent(w.principal, { reference: "Company/Company card/value" }, [
        "secrets:read",
      ]);
      expect(w.controls.epochs.at(-1)).toBe(String(epoch));
      await syncLinkedProviderVault({
        db: w.db,
        context: w.context,
        vaultId: w.company.id,
        providers: w.providers,
        force: true,
      });
      expect(await read()).toEqual({ type: "text", value: "company-secret" });
      expect(w.controls.epochs.at(-1)).toBe(String(epoch + 1n));

      // Under an active rate limit neither a search refresh nor Sync now calls the provider.
      const until = new Date(Date.now() + 10 * 60_000);
      await setVaultSyncStatus(w.db, w.context, {
        vaultId: w.company.id,
        status: "rate_limited",
        errorCode: "provider_rate_limited",
        errorMessage: "slow down",
        rateLimitedUntil: until.toISOString(),
      });
      const calls = w.host.calls.length;
      const limited = await w.search({ vault: "Company", refresh: true });
      expect(names(limited)).toEqual(["Company card"]);
      expect(limited.complete).toBe(false);
      expect(limited.sources).toEqual([
        {
          vaultId: w.company.id,
          freshness: expect.objectContaining({
            state: "unavailable",
            errorCode: "provider_rate_limited",
            retryAt: until.toISOString(),
          }),
        },
      ]);
      expect(
        await syncLinkedProviderVault({
          db: w.db,
          context: w.context,
          vaultId: w.company.id,
          providers: w.providers,
          force: true,
        }),
      ).toEqual({ status: "skipped_rate_limited", rateLimitedUntil: until });
      expect(w.host.calls.length).toBe(calls);
    });

    test("a miss names the connected source that could not be checked instead of asking for the secret", async () => {
      if (!client) return;
      const w = await world();
      const rejection = async (...paths: string[]): Promise<SecretReferenceError> => {
        try {
          await w.resolver().resolve(paths.map(reference), use);
        } catch (error) {
          if (isSecretReferenceError(error)) return error;
          throw error;
        }
        throw new Error("expected the references to fail");
      };
      const value = async (path: string) =>
        [...(await w.resolver().resolve([reference(path)], use)).values()][0]!.material;

      // While every relevant source is current, a miss asks for the secret.
      const missing = await rejection("Company/Brand new/value");
      expect(missing.failures).toEqual([expect.objectContaining({ code: "not_found" })]);
      expect(missing.askCard).not.toBeNull();

      // The provider goes down; the next miss refreshes the stale mirror and cannot check it.
      w.seed.failWith = "provider_unavailable";
      await w.age(w.company, LINKED_VAULT_MISS_MAX_AGE_MS + 1_000);
      const lists = w.calls("listVaults");
      const down = await rejection("Company/Brand new/value");
      expect(w.calls("listVaults")).toBe(lists + 1);
      expect(down.failures).toEqual([expect.objectContaining({ code: "provider_unavailable" })]);
      expect(down.failures[0]!.message).toContain("Company");
      expect(down.askCard).toBeNull();
      // A bare name could be in any connected vault.
      const bare = await rejection("Brand new");
      expect(bare.failures[0]!.code).toBe("provider_unavailable");
      expect(bare.askCard).toBeNull();
      // A hosted vault named explicitly is not blocked by the outage, and its own misses still ask.
      expect(await value("Team/Team token/value")).toEqual({ type: "text", value: "team-secret" });
      const mixed = await rejection("Team/Missing token/value", "Company/Brand new/value");
      expect(mixed.failures.map((failure) => failure.code)).toEqual([
        "not_found",
        "provider_unavailable",
      ]);
      expect(mixed.askCard!.questions).toHaveLength(1);
      expect(mixed.askCard!.questions[0]!.label).toBe("Missing token");

      // The provider is back. A healthy connected vault named explicitly is
      // unaffected by Company, which stays unavailable until its next check.
      w.seed.failWith = null;
      expect(await value("Ops/Ops token/value")).toEqual({ type: "text", value: "ops-secret" });
      const opsMiss = await rejection("Ops/Missing token/value");
      expect(opsMiss.failures[0]!.code).toBe("not_found");
      expect(opsMiss.askCard).not.toBeNull();

      // A connection that needs reconnecting and a provider rate limit keep their own codes.
      await setVaultSyncStatus(w.db, w.context, {
        vaultId: w.company.id,
        status: "auth_expired",
        errorCode: "provider_auth_expired",
        errorMessage: "reconnect",
        rateLimitedUntil: null,
      });
      const expired = await rejection("Company/Brand new/value");
      expect(expired.failures[0]!.code).toBe("provider_auth_expired");
      expect(expired.failures[0]!.message).toContain("reconnected");
      expect(expired.askCard).toBeNull();
      const until = new Date(Date.now() + 10 * 60_000);
      await setVaultSyncStatus(w.db, w.context, {
        vaultId: w.company.id,
        status: "rate_limited",
        errorCode: "provider_rate_limited",
        errorMessage: "slow down",
        rateLimitedUntil: until.toISOString(),
      });
      const calls = w.host.calls.length;
      const limited = await rejection("Company/Brand new/value");
      expect(limited.failures[0]!.code).toBe("provider_rate_limited");
      expect(limited.failures[0]!.message).toContain(until.toISOString());
      expect(limited.askCard).toBeNull();
      expect(w.host.calls.length).toBe(calls);
    });

    test("writes and moves a vault does not allow are refused before any value or provider mutation", async () => {
      if (!client) return;
      const w = await world({ operations: LOGIN_ONLY });
      const partners = await w.link("Partners", "partners", "read_write");
      const summaries = (await w.service.list(w.actor, w.workspaceId)).map((summary) =>
        VaultSummary.parse(summary),
      );
      const summaryOf = (id: string) => summaries.find((summary) => summary.id === id)!;
      expect(summaryOf(w.company.id)).toMatchObject({
        canWrite: true,
        providerOperations: LOGIN_ONLY,
        freshness: { state: "current", source: "unknown" },
      });
      // A read-only link allows no writes, whatever the provider could do.
      expect(summaryOf(w.ops.id).canWrite).toBe(false);
      expect(summaryOf(w.ops.id).providerOperations).toMatchObject({
        createItemTypes: [],
        updateItem: false,
        archiveItem: false,
      });
      // A read-write link to a vault the provider shares read-only is read-only too.
      expect(summaryOf(partners.id).canWrite).toBe(false);
      expect(summaryOf(partners.id).providerOperations).toMatchObject({
        createItemTypes: [],
        updateItem: false,
      });
      expect(summaryOf(w.team.id)).toMatchObject({ canWrite: true });
      expect(summaryOf(w.team.id).providerOperations).toBeUndefined();
      expect(summaryOf(w.team.id).freshness).toBeUndefined();

      const save = (input: Record<string, unknown>) =>
        w.service.saveForAgent(w.principal, SecretSaveInput.parse({ mode: "create", ...input }));
      const apiKey = await refusal(
        save({
          item: "New key",
          vault: "Company",
          type: "api_key",
          fields: [{ name: "value", generate: { length: 24 } }],
        }),
      );
      expect(apiKey.code).toBe("vault_read_only");
      expect(apiKey.details).toMatchObject({
        operation: "createItem",
        itemType: "api_key",
        allowedItemTypes: ["login"],
      });
      const totp = await refusal(
        save({
          item: "Two factor",
          vault: "Company",
          type: "login",
          fields: [{ name: "one-time password", kind: "totp", value: "JBSWY3DPEHPK3PXP" }],
        }),
      );
      expect(totp.details).toMatchObject({ operation: "createTotp" });
      const intoPartners = await refusal(
        save({
          item: "Anything",
          vault: "Partners",
          type: "login",
          fields: [{ name: "password", value: "pw" }],
        }),
      );
      expect(intoPartners.details).toMatchObject({ operation: "createItem", allowedItemTypes: [] });
      const card = await w.item(w.company, "Company card");
      const removal = await refusal(
        w.service.updateItem(w.actor, w.workspaceId, card.id, {
          expectedGeneration: card.generation,
          fields: [{ fieldId: card.fields[0]!.id, name: card.fields[0]!.name, remove: true }],
        }),
      );
      expect(removal.details).toMatchObject({ operation: "removeField" });
      const archive = await refusal(
        w.service.archiveForAgent(w.principal, { reference: "Company/Company card" }),
      );
      expect(archive.details).toMatchObject({ operation: "archiveItem" });

      // Moves check the target and, for a move, a recoverable archive of the original first.
      const twoFactor = await w.hosted("Two factor", "login", [
        { name: "password", kind: "concealed", value: "pw-two-factor" },
        { name: "one-time password", kind: "totp", value: "JBSWY3DPEHPK3PXP" },
      ]);
      const totpInto = await refusal(
        w.service.moveForAgent(w.principal, {
          reference: "Team/Two factor",
          toVault: "Company",
          mode: "move",
        }),
      );
      expect(totpInto.details).toMatchObject({ operation: "createTotp" });
      const keyInto = await refusal(
        w.service.moveForAgent(w.principal, {
          reference: "Team/Team token",
          toVault: "Company",
          mode: "copy",
        }),
      );
      expect(keyInto.details).toMatchObject({ operation: "createItem", itemType: "api_key" });
      const reads = w.calls("readFields");
      const out = await refusal(
        w.service.moveForAgent(w.principal, {
          reference: "Company/Company card",
          toVault: "Team",
          mode: "move",
        }),
      );
      expect(out.details).toMatchObject({ operation: "archiveItem" });
      expect(w.calls("readFields")).toBe(reads);
      expect(w.calls("writeItem")).toBe(0);
      expect(w.calls("archiveItem")).toBe(0);
      expect((await getVaultItem(w.db, w.context, { itemId: twoFactor.id })).archivedAt).toBeNull();
      expect(
        (await getVaultItem(w.db, w.context, { itemId: w.teamToken.id })).archivedAt,
      ).toBeNull();

      // What the vault does allow still works: a copy out, and a login without a one-time password in.
      const copied = await w.service.moveForAgent(w.principal, {
        reference: "Company/Company card",
        toVault: "Team",
        mode: "copy",
      });
      expect(copied.item.vaultId).toBe(w.team.id);
      const saved = await save({
        item: "New login",
        vault: "Company",
        type: "login",
        username: "me@example.test",
        fields: [{ name: "password", value: "pw-correct-horse" }],
      });
      expect(saved.item.vaultId).toBe(w.company.id);
      expect(w.calls("writeItem")).toBe(1);
    });

    test("an unconfirmed write is never retried, and a confirmed one not yet listed is reported as saved", async () => {
      if (!client) return;
      const w = await world();
      const save = (item: string) =>
        w.service.saveForAgent(
          w.principal,
          SecretSaveInput.parse({
            item,
            vault: "Company",
            type: "login",
            fields: [{ name: "password", value: `pw-${item}` }],
            mode: "create",
          }),
        );

      w.controls.writeThrows = new TypeError("socket closed after sending the request");
      const dropped = await refusal(save("Unsure"));
      expect(dropped.code).toBe("provider_outcome_unknown");
      expect(dropped.message).not.toContain("socket");
      expect(dropped.message).toContain("check the vault");
      expect(w.calls("writeItem")).toBe(1);
      w.controls.writeThrows = new VaultProviderError(
        "provider_outcome_unknown",
        "the bridge timed out after forwarding the write",
      );
      const unknown = await refusal(save("Unsure"));
      expect(unknown.code).toBe("provider_outcome_unknown");
      expect(w.calls("writeItem")).toBe(2);
      // An unknown target write in a move leaves the original where it was.
      const unsureMove = await refusal(
        w.service.moveForAgent(w.principal, {
          reference: "Team/Team token",
          toVault: "Company",
          mode: "move",
        }),
      );
      expect(unsureMove.code).toBe("provider_outcome_unknown");
      expect(w.calls("writeItem")).toBe(3);
      expect(
        (await getVaultItem(w.db, w.context, { itemId: w.teamToken.id })).archivedAt,
      ).toBeNull();

      // The write lands, then the provider rate limits the refresh that would list it.
      w.controls.writeThrows = null;
      w.controls.rateLimitAfterWrite = true;
      const later = await refusal(save("Saved later"));
      expect(later.code).toBe("provider_inventory_incomplete");
      expect(later.details).toMatchObject({
        saved: true,
        vaultId: w.company.id,
        itemName: "Saved later",
        sync: "failed",
      });
      expect(later.message).toContain("Do not save it again");
      expect(w.calls("writeItem")).toBe(4);
      expect((await w.reload(w.company)).syncStatus).toBe("rate_limited");
      // Once the limit lifts, the next sync lists it.
      await w.clearRateLimit(w.company);
      expect(names(await w.search({ query: "Saved later" }))).toEqual(["Saved later"]);

      // A move whose copy is confirmed but not listed yet still archives the
      // original, and says both, so it is not moved again.
      w.controls.rateLimitAfterWrite = true;
      const moved = await refusal(
        w.service.moveForAgent(w.principal, {
          reference: "Team/Team token",
          toVault: "Company",
          mode: "move",
        }),
      );
      expect(moved.code).toBe("provider_inventory_incomplete");
      expect(moved.details).toMatchObject({
        saved: true,
        sourceArchived: true,
        vaultId: w.company.id,
      });
      expect(
        (await getVaultItem(w.db, w.context, { itemId: w.teamToken.id })).archivedAt,
      ).not.toBeNull();
      expect(w.calls("writeItem")).toBe(5);

      // A move out of a vault that archives recoverably copies the value, then
      // archives the original in the provider.
      await w.clearRateLimit(w.company);
      const out = await w.service.moveForAgent(w.principal, {
        reference: "Company/Company card",
        toVault: "Team",
        mode: "move",
      });
      expect(out.item.vaultId).toBe(w.team.id);
      expect(w.calls("archiveItem")).toBe(1);
      const direct = { connectionId: null, budget: createProviderCallBudget(10) };
      expect((await w.host.listItems(direct, "company")).map((item) => item.name)).not.toContain(
        "Company card",
      );
      const copiedValue = await w.service.readForAgent(
        w.principal,
        { reference: "Team/Company card/value" },
        ["secrets:read"],
      );
      expect(copiedValue.value).toBe("company-secret");
    });

    test("restore, permanent deletion and field history are never sent to a provider", async () => {
      if (!client) return;
      const w = await world();
      const card = await w.item(w.company, "Company card");
      const field = card.fields[0]!;
      const refused = [
        ["deleteItem", () => w.service.deleteItemPermanently(w.actor, w.workspaceId, card.id)],
        ["restoreItem", () => w.service.restoreItem(w.actor, w.workspaceId, card.id)],
        [
          "restoreFieldHistory",
          () => w.service.restoreFieldVersion(w.actor, w.workspaceId, card.id, field.id, 1),
        ],
        [
          "restoreFieldHistory",
          () =>
            w.service.updateItem(w.actor, w.workspaceId, card.id, {
              expectedGeneration: card.generation,
              fields: [{ fieldId: field.id, name: field.name, restoreVersion: 1 }],
            }),
        ],
      ] as const;
      for (const [operation, call] of refused) {
        const error = await refusal(call());
        expect(error.code).toBe("vault_read_only");
        expect(error.details).toMatchObject({ operation, vaultId: w.company.id });
      }
      expect(w.calls("writeItem") + w.calls("archiveItem")).toBe(0);
      expect((await w.item(w.company, "Company card")).archivedAt).toBeNull();
    });

    test("concurrent refreshes share one provider call only within the same principal", async () => {
      if (!client) return;
      const w = await world();
      await w.age(w.company, LINKED_VAULT_SEARCH_MAX_AGE_MS + 1_000);
      const stale = await w.reload(w.company);
      let release!: () => void;
      w.controls.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lists = w.calls("listVaults");
      const asAgent: VaultDbContext = { kind: "principal", principal: w.principal };
      const refresh = (context: VaultDbContext, waitMs?: number) =>
        refreshLinkedVaults({
          db: w.db,
          context,
          vaults: [stale],
          providers: w.providers,
          ...(waitMs !== undefined ? { waitMs } : {}),
        });

      // Two agent searches and a person opening the vault, at once.
      const started = await Promise.all([
        refresh(asAgent, 50),
        refresh(asAgent, 50),
        refresh(w.context, 50),
      ]);
      for (const report of started) {
        expect(report.pending).toEqual([stale.id]);
        expect(report.outcomes).toEqual([{ vaultId: stale.id, state: "pending", result: null }]);
      }
      release();
      const finished = await Promise.all([refresh(asAgent), refresh(w.context)]);
      for (const report of finished) {
        expect(report.outcomes).toEqual([
          {
            vaultId: stale.id,
            state: "done",
            result: { status: "unchanged", contentVersion: "1" },
          },
        ]);
      }
      // One provider call per principal, not one per caller.
      expect(w.calls("listVaults")).toBe(lists + 2);
      w.controls.gate = null;
    });

    test("an inventory that cannot be mirrored as listed keeps the previous mirror, for host and external vaults", async () => {
      if (!client) return;
      const w = await world();
      // A remote bridge (`external`) vault over a workspace connection, beside the host vault.
      const connection = await createConnection(w.db, {
        accountId: w.actor.grant.accountId,
        workspaceId: w.workspaceId,
        subjectId: null,
        providerDomain: "vault:external",
        kind: "api_key",
        status: "active",
        credentialEncrypted: encryptEnvironmentValue(
          Buffer.from(key),
          JSON.stringify({ provider: "external" }),
        ),
        grantedScopes: [],
        expiresAt: null,
        metadata: {
          credentialRole: "external_vault_provider",
          vaultProvider: {
            version: 1,
            provider: "external",
            ownership: "workspace",
            accountId: null,
            accountName: "Bridge",
            label: null,
            verifiedAt: new Date().toISOString(),
            operations: LOGIN_ONLY,
          },
        },
        createdBySubjectId: w.subjectId,
      });
      const remote = createFakeVaultProvider({
        vaults: [
          {
            externalVaultId: "bridge",
            name: "Bridge",
            items: [
              {
                name: "Bridge token",
                type: "api_key",
                fields: [{ name: "value", value: "bridge-secret" }],
              },
              { name: "Deploy key", type: "api_key", fields: [{ name: "value", value: "deploy" }] },
            ],
          },
        ],
      });
      const providers = createVaultProviderRegistry({
        host: async () => w.host,
        external: async () => remote,
      });
      const bridge = await linkProviderVault(w.db, w.context, {
        ownerKind: "workspace",
        name: "Bridge",
        source: "external",
        providerConnectionId: connection.id,
        providerVaultRef: "bridge",
        mode: "read_only",
      });
      const sync = async (vault: { id: string }) =>
        await syncLinkedProviderVault({
          db: w.db,
          context: w.context,
          vaultId: vault.id,
          providers,
          force: true,
        });
      expect(await sync(bridge)).toMatchObject({ status: "synced", itemCount: 2 });
      const mirrored = async (vault: { id: string }) =>
        (await w.service.listItems(w.actor, w.workspaceId, vault.id, {})).items
          .map((item) => item.name)
          .sort();
      const epochOf = async (vault: { id: string }) =>
        BigInt((await w.reload(vault)).providerCacheEpoch!);
      const oversized = (patch: Partial<ProviderItemMeta>): ProviderItemMeta => ({
        externalItemId: "oversized",
        name: "Payroll export",
        type: "login",
        websites: [],
        fields: [],
        version: "1",
        updatedAt: null,
        ...patch,
      });
      const filler = (index: number): ProviderItemMeta => ({
        ...oversized({}),
        externalItemId: `filler-${index}`,
        name: `Filler ${index}`,
      });

      for (const [vault, provider, externalVaultId, before] of [
        [w.company, w.host, "company", ["Company card"]],
        [bridge, remote, "bridge", ["Bridge token", "Deploy key"]],
      ] as const) {
        expect(await mirrored(vault)).toEqual([...before]);
        const epoch = await epochOf(vault);
        const expectKept = async () => {
          expect(await mirrored(vault)).toEqual([...before]);
          expect(await epochOf(vault)).toBe(epoch);
          const row = await w.reload(vault);
          expect(row.syncStatus).toBe("error");
          expect(row.syncErrorCode).toBe("provider_inventory_incomplete");
          expect(row.syncErrorMessage).not.toContain("Payroll");
        };

        // An item beyond the mirror limits is refused whole, never cut down.
        const listItems = provider.listItems;
        for (const big of [
          oversized({
            fields: Array.from({ length: VAULT_LIMITS.fieldsPerItem + 1 }, (_, index) => ({
              externalFieldId: `field-${index}`,
              name: `field ${index}`,
              kind: "concealed" as const,
            })),
          }),
          oversized({
            websites: Array.from(
              { length: VAULT_LIMITS.websitesPerItem + 1 },
              (_, index) => `https://site-${index}.example`,
            ),
          }),
          oversized({ websites: [`https://${"a".repeat(VAULT_LIMITS.websiteMaxChars)}`] }),
        ]) {
          provider.listItems = async (ctx, id) => [...(await listItems(ctx, id)), big];
          expect(await sync(vault)).toMatchObject({
            status: "failed",
            code: "provider_inventory_incomplete",
          });
          await expectKept();
        }
        provider.listItems = listItems;

        // Review regression: offset pages without a snapshot. A filler is
        // deleted after the first page, every later item moves up one place,
        // and an item that still exists is never listed.
        const existing = await listItems(
          { connectionId: null, budget: createProviderCallBudget(5) },
          externalVaultId,
        );
        const upstream = [...Array.from({ length: 100 }, (_, index) => filler(index)), ...existing];
        provider.listItemPage = async (_ctx, _id, page) => {
          const offset = page.cursor ? Number(page.cursor) : 0;
          const items = upstream.slice(offset, offset + page.limit);
          const nextCursor =
            offset + page.limit < upstream.length ? String(offset + page.limit) : null;
          if (offset === 0) upstream.splice(0, 1);
          return { items, nextCursor, snapshot: null };
        };
        expect(await sync(vault)).toMatchObject({
          status: "failed",
          code: "provider_inventory_incomplete",
        });
        expect(upstream.map((item) => item.name)).toContain(existing[0]!.name);
        await expectKept();
        delete provider.listItemPage;

        // A consistent listing replaces the mirror again.
        expect(await sync(vault)).toMatchObject({ status: "synced" });
        expect(await mirrored(vault)).toEqual([...before]);
        expect(await epochOf(vault)).toBe(epoch + 1n);
        expect((await w.reload(vault)).syncStatus).toBe("ok");
      }
    });
  },
);
