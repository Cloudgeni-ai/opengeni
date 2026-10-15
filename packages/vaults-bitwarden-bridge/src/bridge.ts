/**
 * Bitwarden Password Manager bridge: `opengeni.vault.v1` handlers over a
 * customer-run, already-unlocked `bw serve` on a private Unix socket.
 *
 * The customer keeps the master password, the unlocked session and the CLI
 * app data. The bridge never logs in, unlocks, or runs arbitrary commands; it
 * reports `provider_locked` / `provider_auth_expired` and the operator fixes
 * that locally. One bridge process serves one Bitwarden account and one fixed
 * inventory scope (configured vaults), independent of the acting subject.
 */
import {
  createExternalVaultReceiver,
  ExternalVaultReceiverError,
  type ExternalVaultReceiver,
  type ExternalVaultReceiverStore,
  type VaultProviderWireErrorCode,
  type VaultProviderWireFreshness,
  type VaultProviderWireItemMeta,
  type VaultProviderWireResult,
  type VaultProviderWireVault,
} from "@opengeni/sdk/external-vault-receiver";
import {
  BitwardenPrivatePathError,
  BitwardenServeError,
  isBitwardenGuid,
  type BitwardenItem,
  type BitwardenServeClient,
  type BitwardenStatus,
} from "./bw-serve";
import {
  ProjectionError,
  createBody,
  itemRevision,
  mergeUpdate,
  projectItem,
  readValues,
} from "./projection";

export type BitwardenBridgeVaultScope =
  | { kind: "personal"; name?: string; mode: "read_only" | "read_write" }
  | {
      kind: "collection";
      collectionId: string;
      organizationId: string;
      name?: string;
      mode: "read_only" | "read_write";
    };

export interface BitwardenBridgeConfig {
  /** The Opengeni connection id this bridge answers for. */
  connectionId: string;
  /** Current signing secret first; a previous one only during rotation. */
  signingSecrets: string[];
  /** Native Opengeni bindings. Requests for anything else are refused. */
  opengeni: {
    accountId: string;
    /** Workspace that owns the connection in Opengeni. */
    connectionWorkspaceId: string;
    /** Calling workspaces allowed to use it. Default: only the owner workspace. */
    workspaceIds?: string[];
    /** Acting subjects allowed to read values or write. Default "any" (including none). */
    subjectIds?: string[] | "any";
  };
  /** The fixed inventory scope. Items outside it are never listed, read or changed. */
  vaults: BitwardenBridgeVaultScope[];
  /** Display name for the connection; defaults to the Bitwarden account email. */
  accountLabel?: string;
  /** Reads resync upstream when the last bridge sync is older than this. Default 5 minutes. */
  readSyncTtlMs?: number;
  /** Listings, refreshes and writes reuse a sync newer than this. Default 15 seconds. */
  minSyncIntervalMs?: number;
  /** Default true: serve values from the local CLI cache when upstream sync fails, marked stale. */
  allowStaleReads?: boolean;
  snapshotTtlMs?: number;
  maxSnapshots?: number;
}

export const BITWARDEN_BRIDGE_PERSONAL_VAULT_ID = "personal";

export function bitwardenVaultId(scope: BitwardenBridgeVaultScope): string {
  return scope.kind === "personal"
    ? BITWARDEN_BRIDGE_PERSONAL_VAULT_ID
    : `collection:${scope.collectionId.toLowerCase()}`;
}

export function validateBitwardenBridgeConfig(config: BitwardenBridgeConfig): void {
  const fail = (message: string): never => {
    throw new Error(`invalid Bitwarden bridge config: ${message}`);
  };
  if (!isBitwardenGuid(config.connectionId)) fail("connectionId must be a UUID");
  if (
    !Array.isArray(config.signingSecrets) ||
    config.signingSecrets.length < 1 ||
    config.signingSecrets.length > 2 ||
    config.signingSecrets.some((secret) => typeof secret !== "string" || secret.length < 32)
  ) {
    fail("signingSecrets needs one or two secrets of at least 32 characters");
  }
  if (!config.opengeni?.accountId || !config.opengeni.connectionWorkspaceId) {
    fail("opengeni.accountId and opengeni.connectionWorkspaceId are required");
  }
  if (!Array.isArray(config.vaults) || config.vaults.length < 1 || config.vaults.length > 200) {
    fail("vaults needs 1 to 200 entries");
  }
  const ids = new Set<string>();
  for (const scope of config.vaults) {
    if (scope.mode !== "read_only" && scope.mode !== "read_write") fail("vault mode is required");
    if (
      scope.kind === "collection" &&
      (!isBitwardenGuid(scope.collectionId) || !isBitwardenGuid(scope.organizationId))
    ) {
      fail("collection vaults need collectionId and organizationId UUIDs");
    }
    if (scope.kind !== "personal" && scope.kind !== "collection") fail("unknown vault kind");
    const id = bitwardenVaultId(scope);
    if (ids.has(id)) fail(`duplicate vault ${id}`);
    ids.add(id);
  }
}

const WRITE_OPERATIONS = {
  createItemTypes: ["login", "note"],
  updateItem: true,
  removeField: true,
  archiveItem: true,
  // Ordinary delete moves to Trash (recoverable for 30 days), not Premium archive.
  archiveKind: "trash",
  deleteItem: false,
  restoreItem: false,
  readFiles: false,
  writeFiles: false,
  createTotp: true,
  updateTotp: true,
  createVault: false,
  restoreFieldHistory: false,
} as const satisfies VaultProviderWireResult<"describe">["operations"];

const READ_OPERATIONS = {
  ...WRITE_OPERATIONS,
  createItemTypes: [],
  updateItem: false,
  removeField: false,
  archiveItem: false,
  archiveKind: "none",
  createTotp: false,
  updateTotp: false,
} as const satisfies VaultProviderWireResult<"describe">["operations"];

function operationsFor(writable: boolean) {
  const source = writable ? WRITE_OPERATIONS : READ_OPERATIONS;
  return { ...source, createItemTypes: [...source.createItemTypes] };
}

type Snapshot<T> = { id: string; key: string; items: T[]; expiresAt: number };

export interface BitwardenBridgeOptions {
  config: BitwardenBridgeConfig;
  client: BitwardenServeClient;
  /** Use durable storage (see createFileExternalVaultReceiverStore). */
  store: ExternalVaultReceiverStore;
  now?: () => number;
  onError?: Parameters<typeof createExternalVaultReceiver>[0]["onError"];
}

export interface BitwardenBridge extends ExternalVaultReceiver {
  /** Local health for the operator: never exposed over the signed protocol. */
  health(): Promise<{ status: BitwardenStatus["status"] | "unreachable"; lastSync: string | null }>;
}

export function createBitwardenBridge(options: BitwardenBridgeOptions): BitwardenBridge {
  const { config, client } = options;
  validateBitwardenBridgeConfig(config);
  const now = options.now ?? (() => Date.now());
  const readTtl = config.readSyncTtlMs ?? 300_000;
  const minSyncInterval = config.minSyncIntervalMs ?? 15_000;
  const snapshotTtl = config.snapshotTtlMs ?? 600_000;
  const maxSnapshots = config.maxSnapshots ?? 16;
  const allowStaleReads = config.allowStaleReads ?? true;
  const workspaceIds = new Set(
    config.opengeni.workspaceIds ?? [config.opengeni.connectionWorkspaceId],
  );
  const subjects = config.opengeni.subjectIds ?? "any";
  const scopes = new Map(config.vaults.map((scope) => [bitwardenVaultId(scope), scope]));
  const writable = config.vaults.some((scope) => scope.mode === "read_write");

  // One bw serve per account; serialize its calls so sync never races a write.
  let queue: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (waiting >= 64) {
      return Promise.reject(
        new ExternalVaultReceiverError("provider_rate_limited", { retryAfterMs: 1_000 }),
      );
    }
    waiting += 1;
    const next = queue.then(
      () => run(),
      () => run(),
    );
    queue = next.then(
      () => {
        waiting -= 1;
      },
      () => {
        waiting -= 1;
      },
    );
    return next;
  }

  let lastSyncAt = Number.NEGATIVE_INFINITY;
  const snapshots = new Map<string, Snapshot<unknown>>();

  function freshness(
    status: BitwardenStatus | null,
    state: VaultProviderWireFreshness["state"],
    source: VaultProviderWireFreshness["source"],
    errorCode: VaultProviderWireErrorCode | null = null,
  ): VaultProviderWireFreshness {
    return { state, sourceSyncedAt: status?.lastSync ?? null, source, errorCode, retryAt: null };
  }

  function mapError(
    error: unknown,
    mutation: boolean,
    status: BitwardenStatus | null = null,
  ): never {
    if (error instanceof ExternalVaultReceiverError) throw error;
    if (error instanceof ProjectionError) {
      throw new ExternalVaultReceiverError(
        error.reason === "not_found"
          ? "provider_not_found"
          : error.reason === "conflict"
            ? "provider_conflict"
            : "provider_permission_denied",
      );
    }
    if (error instanceof BitwardenPrivatePathError) {
      // Nothing was sent: the socket or its directory is no longer private.
      throw new ExternalVaultReceiverError("provider_unavailable", {
        freshness: freshness(status, "unavailable", "unknown", "provider_unavailable"),
      });
    }
    if (error instanceof BitwardenServeError) {
      const codes: Record<string, VaultProviderWireErrorCode> = {
        locked: "provider_locked",
        unauthenticated: "provider_auth_expired",
        not_found: "provider_not_found",
        permission_denied: "provider_permission_denied",
        conflict: "provider_conflict",
      };
      const code = codes[error.failure];
      if (mutation && !error.definite)
        throw new ExternalVaultReceiverError("provider_outcome_unknown");
      throw new ExternalVaultReceiverError(code ?? "provider_unavailable", {
        freshness: freshness(status, "unavailable", "unknown", code ?? "provider_unavailable"),
      });
    }
    throw new ExternalVaultReceiverError(
      mutation ? "provider_outcome_unknown" : "provider_unavailable",
    );
  }

  async function unlockedStatus(): Promise<BitwardenStatus> {
    let status: BitwardenStatus;
    try {
      status = await client.status();
    } catch (error) {
      return mapError(error, false);
    }
    if (status.status === "unlocked") return status;
    const code: VaultProviderWireErrorCode =
      status.status === "locked" ? "provider_locked" : "provider_auth_expired";
    throw new ExternalVaultReceiverError(code, {
      freshness: freshness(status, "unavailable", "unknown", code),
    });
  }

  /** Sync upstream unless a bridge sync is newer than `maxAgeMs`. */
  async function synced(maxAgeMs: number): Promise<{
    status: BitwardenStatus;
    freshness: VaultProviderWireFreshness;
    ok: boolean;
  }> {
    const before = await unlockedStatus();
    if (now() - lastSyncAt < maxAgeMs) {
      return { status: before, freshness: freshness(before, "current", "cache"), ok: true };
    }
    try {
      await client.sync();
    } catch (error) {
      if (
        !(error instanceof BitwardenServeError) ||
        error.failure === "locked" ||
        error.failure === "unauthenticated"
      ) {
        mapError(error, false, before);
      }
      // Offline or upstream failure: the CLI cache remains, but it is stale.
      return {
        status: before,
        freshness: freshness(before, "stale", "cache", "provider_unavailable"),
        ok: false,
      };
    }
    lastSyncAt = now();
    const after = await unlockedStatus();
    return { status: after, freshness: freshness(after, "current", "live"), ok: true };
  }

  function scopeFor(externalVaultId: string): BitwardenBridgeVaultScope {
    const scope = scopes.get(externalVaultId);
    if (!scope) throw new ExternalVaultReceiverError("provider_not_found");
    return scope;
  }

  function inScope(item: BitwardenItem, scope: BitwardenBridgeVaultScope): boolean {
    if (item.deletedDate != null || item.archivedDate != null) return false;
    if (scope.kind === "personal") return item.organizationId == null;
    const organizationId =
      typeof item.organizationId === "string" ? item.organizationId.toLowerCase() : null;
    const collections = Array.isArray(item.collectionIds)
      ? item.collectionIds.map((id) => (typeof id === "string" ? id.toLowerCase() : id))
      : [];
    return (
      organizationId === scope.organizationId.toLowerCase() &&
      collections.includes(scope.collectionId.toLowerCase())
    );
  }

  function requireWritable(scope: BitwardenBridgeVaultScope) {
    if (scope.mode !== "read_write")
      throw new ExternalVaultReceiverError("provider_permission_denied");
  }

  function invalidate(externalVaultId: string) {
    for (const [id, snapshot] of snapshots) {
      if (snapshot.key === `items:${externalVaultId}`) snapshots.delete(id);
    }
  }

  /** Serve a page from a bounded, expiring snapshot; a new listing builds one. */
  async function page<T>(
    key: string,
    request: { limit: number; cursor?: string | undefined; snapshot?: string | undefined },
    build: () => Promise<T[]>,
  ): Promise<{ items: T[]; nextCursor: string | null; snapshot: string }> {
    const slice = (snapshot: Snapshot<T>, offset: number) => {
      const items = snapshot.items.slice(offset, offset + request.limit);
      const next = offset + items.length;
      return {
        items,
        nextCursor: next < snapshot.items.length ? `${snapshot.id}.${next}` : null,
        snapshot: snapshot.id,
      };
    };
    for (const [id, snapshot] of snapshots) if (snapshot.expiresAt <= now()) snapshots.delete(id);
    if (request.cursor !== undefined) {
      const match = /^([0-9a-f-]{36})\.(\d{1,6})$/.exec(request.cursor);
      const snapshot = match ? (snapshots.get(match[1]!) as Snapshot<T> | undefined) : undefined;
      if (!match || !snapshot || snapshot.key !== key || request.snapshot !== snapshot.id) {
        // Expired or foreign cursor: the caller keeps its previous inventory.
        throw new ExternalVaultReceiverError("provider_inventory_incomplete");
      }
      const offset = Number(match[2]);
      if (offset > snapshot.items.length) {
        throw new ExternalVaultReceiverError("provider_inventory_incomplete");
      }
      return slice(snapshot, offset);
    }
    const snapshot: Snapshot<T> = {
      id: crypto.randomUUID(),
      key,
      items: await build(),
      expiresAt: now() + snapshotTtl,
    };
    snapshots.set(snapshot.id, snapshot as Snapshot<unknown>);
    while (snapshots.size > maxSnapshots) snapshots.delete(snapshots.keys().next().value!);
    return slice(snapshot, 0);
  }

  const receiver = createExternalVaultReceiver<BitwardenBridgeConfig, { subjectId: string | null }>(
    {
      async resolveConnection(connectionId) {
        if (connectionId !== config.connectionId.toLowerCase()) return null;
        return {
          provider: "bitwarden",
          signingSecrets: config.signingSecrets,
          accountId: config.opengeni.accountId,
          connectionWorkspaceId: config.opengeni.connectionWorkspaceId,
          context: config,
        };
      },
      async authorize({ authority, operation }) {
        if (!workspaceIds.has(authority.workspaceId)) return null;
        const valueOperation =
          operation.op === "read_fields" ||
          operation.op === "write_item" ||
          operation.op === "archive_item";
        if (
          valueOperation &&
          subjects !== "any" &&
          (authority.subjectId === null || !subjects.includes(authority.subjectId))
        ) {
          return null;
        }
        return { subjectId: authority.subjectId };
      },
      store: options.store,
      now,
      ...(options.onError ? { onError: options.onError } : {}),
      handlers: {
        describe: () =>
          exclusive(async () => {
            const status = await unlockedStatus();
            if (!status.userId) throw new ExternalVaultReceiverError("provider_unavailable");
            return {
              result: {
                accountId: `bitwarden:${status.userId}`,
                accountName: config.accountLabel ?? status.userEmail,
                operations: operationsFor(writable),
                capabilities: { totp: true, files: false },
                inventoryScope: "connection" as const,
              },
              freshness: freshness(status, "current", "cache"),
            };
          }),

        refresh: () =>
          exclusive(async () => {
            const sync = await synced(minSyncInterval);
            if (!sync.ok) {
              throw new ExternalVaultReceiverError("provider_unavailable", {
                freshness: sync.freshness,
              });
            }
            for (const id of [...snapshots.keys()]) snapshots.delete(id);
            return { result: { refreshed: true as const }, freshness: sync.freshness };
          }),

        listVaults: (_ctx, input) =>
          exclusive(async () => {
            let fresh: VaultProviderWireFreshness | null = null;
            const result = await page<VaultProviderWireVault>("vaults", input.page, () =>
              (async () => {
                const sync = await synced(minSyncInterval);
                fresh = sync.freshness;
                let collections: Awaited<ReturnType<BitwardenServeClient["listCollections"]>> = [];
                if (config.vaults.some((scope) => scope.kind === "collection")) {
                  try {
                    collections = await client.listCollections();
                  } catch (error) {
                    mapError(error, false, sync.status);
                  }
                }
                const byId = new Map(collections.map((collection) => [collection.id, collection]));
                return config.vaults.flatMap((scope): VaultProviderWireVault[] => {
                  const operations = operationsFor(scope.mode === "read_write");
                  if (scope.kind === "personal") {
                    return [
                      {
                        externalVaultId: BITWARDEN_BRIDGE_PERSONAL_VAULT_ID,
                        name: scope.name ?? "My vault",
                        contentVersion: null,
                        itemCount: null,
                        writeAccess: scope.mode,
                        operations,
                      },
                    ];
                  }
                  const collection = byId.get(scope.collectionId.toLowerCase());
                  // A revoked or missing collection is absent, not an empty vault.
                  if (
                    !collection ||
                    collection.organizationId !== scope.organizationId.toLowerCase()
                  ) {
                    return [];
                  }
                  return [
                    {
                      externalVaultId: bitwardenVaultId(scope),
                      name: (scope.name ?? collection.name).slice(0, 300) || "Collection",
                      contentVersion: null,
                      itemCount: null,
                      // The CLI does not expose this user's collection write grant.
                      writeAccess: scope.mode === "read_write" ? "unknown" : "read_only",
                      operations,
                    },
                  ];
                });
              })(),
            );
            return {
              result,
              freshness: fresh ?? freshness(await unlockedStatus(), "current", "cache"),
            };
          }),

        listItems: (_ctx, input) =>
          exclusive(async () => {
            const scope = scopeFor(input.externalVaultId);
            let fresh: VaultProviderWireFreshness | null = null;
            const result = await page<VaultProviderWireItemMeta>(
              `items:${input.externalVaultId}`,
              input.page,
              () =>
                (async () => {
                  const sync = await synced(minSyncInterval);
                  fresh = sync.freshness;
                  let raw: BitwardenItem[];
                  try {
                    raw = await client.listItems(
                      scope.kind === "personal"
                        ? { personal: true }
                        : { collectionId: scope.collectionId.toLowerCase() },
                    );
                  } catch (error) {
                    return mapError(error, false, sync.status);
                  }
                  // Project immediately: listing responses contain decrypted values.
                  const projected = raw.filter((item) => inScope(item, scope)).map(projectItem);
                  raw = [];
                  return projected.sort((a, b) =>
                    a.externalItemId < b.externalItemId
                      ? -1
                      : a.externalItemId > b.externalItemId
                        ? 1
                        : 0,
                  );
                })(),
            );
            return {
              result,
              freshness: fresh ?? freshness(await unlockedStatus(), "current", "cache"),
            };
          }),

        readFields: (_ctx, input) =>
          exclusive(async () => {
            const scope = scopeFor(input.externalVaultId);
            const sync = await synced(input.forceRefresh ? minSyncInterval : readTtl);
            if (!sync.ok && !allowStaleReads) {
              throw new ExternalVaultReceiverError("provider_unavailable", {
                freshness: sync.freshness,
              });
            }
            let item: BitwardenItem;
            try {
              item = await client.getItem(input.externalItemId);
            } catch (error) {
              return mapError(error, false, sync.status);
            }
            if (!inScope(item, scope)) throw new ExternalVaultReceiverError("provider_not_found");
            try {
              return {
                result: { fields: readValues(item, input.externalFieldIds) },
                freshness: sync.freshness,
              };
            } catch (error) {
              return mapError(error, false, sync.status);
            }
          }),

        writeItem: (_ctx, input) =>
          exclusive(async () => {
            const scope = scopeFor(input.externalVaultId);
            requireWritable(scope);
            // Writes always start from a fresh upstream sync.
            const sync = await synced(0);
            if (!sync.ok) {
              throw new ExternalVaultReceiverError("provider_unavailable", {
                freshness: sync.freshness,
              });
            }
            const write = input.item;
            let saved: BitwardenItem;
            if (write.externalItemId !== undefined) {
              let body: Record<string, unknown>;
              try {
                const current = await client.getItem(write.externalItemId);
                if (!inScope(current, scope)) throw new ProjectionError("not_found");
                if (
                  typeof write.expectedVersion === "string" &&
                  itemRevision(current) !== write.expectedVersion
                ) {
                  throw new ProjectionError("conflict");
                }
                body = mergeUpdate(current, write);
              } catch (error) {
                // Nothing was sent yet: every failure here is definite.
                return mapError(error, false, sync.status);
              }
              try {
                saved = await client.editItem(write.externalItemId, body);
              } catch (error) {
                return mapError(error, true, sync.status);
              }
            } else {
              let body: Record<string, unknown>;
              try {
                body = createBody(write, {
                  organizationId:
                    scope.kind === "collection" ? scope.organizationId.toLowerCase() : null,
                  collectionId:
                    scope.kind === "collection" ? scope.collectionId.toLowerCase() : null,
                });
              } catch (error) {
                return mapError(error, false, sync.status);
              }
              try {
                saved = await client.createItem(body);
              } catch (error) {
                return mapError(error, true, sync.status);
              }
            }
            invalidate(input.externalVaultId);
            // A saved item outside the configured scope cannot be confirmed as this write.
            if (!inScope(saved, scope))
              throw new ExternalVaultReceiverError("provider_outcome_unknown");
            return { result: { item: projectItem(saved) }, freshness: sync.freshness };
          }),

        archiveItem: (_ctx, input) =>
          exclusive(async () => {
            const scope = scopeFor(input.externalVaultId);
            requireWritable(scope);
            const sync = await synced(0);
            if (!sync.ok) {
              throw new ExternalVaultReceiverError("provider_unavailable", {
                freshness: sync.freshness,
              });
            }
            try {
              const current = await client.getItem(input.externalItemId);
              if (!inScope(current, scope)) throw new ProjectionError("not_found");
            } catch (error) {
              return mapError(error, false, sync.status);
            }
            try {
              await client.trashItem(input.externalItemId);
            } catch (error) {
              return mapError(error, true, sync.status);
            }
            invalidate(input.externalVaultId);
            return { result: { archived: true as const }, freshness: sync.freshness };
          }),
      },
    },
  );

  return {
    ...receiver,
    async health() {
      try {
        const status = await client.status();
        return { status: status.status, lastSync: status.lastSync };
      } catch {
        return { status: "unreachable", lastSync: null };
      }
    },
  };
}
