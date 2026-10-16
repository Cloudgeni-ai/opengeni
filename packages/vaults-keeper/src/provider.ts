import {
  type ProviderCallBudget,
  type ProviderFieldValue,
  type ProviderItemMeta,
  type ProviderVault,
  type SecretMaterial,
  VAULT_LIMITS,
  type VaultProvider,
  type VaultProviderCapabilities,
  type VaultProviderContext,
  VaultProviderError,
  type VaultProviderOperations,
} from "./contract";
import {
  KEEPER_DEFAULT_ALLOWED_HOSTS,
  type KeeperConfigValues,
  assertAllowedHost,
  memoryKeeperStorage,
  parseKeeperConfiguration,
  serializeKeeperConfiguration,
} from "./config";
import { type MutationTracker, mapKeeperError, mapKeeperMutationError } from "./errors";
import {
  FILE_FIELD_PREFIX,
  type MappedKeeperField,
  type MappedKeeperRecord,
  applyPatch,
  buildCreateData,
  fileSize,
  mapRecord,
  totpParamsFor,
} from "./mapping";
import { safeSecretName } from "./naming";
import { restrictToOperations } from "./operations";
import {
  type CapturedConsole,
  KEEPER_REQUEST_TIMEOUT_MS,
  type KeeperFetch,
  type KeeperFileFetcher,
  type KeeperQueryFunction,
  type KeeperRecord,
  type KeeperSdk,
  type KeeperSdkLoader,
  type SecretManagerOptions,
  createKeeperFetchTransport,
  createKeeperFileFetcher,
  createKeeperSdkLoader,
} from "./sdk";

export const KEEPER_VALUE_CACHE_MS = VAULT_LIMITS.providerValueCacheMs;

/** What KSM 17.6.0 can do for an application (see README for the evidence). */
export const KEEPER_OPERATIONS: VaultProviderOperations = {
  createItemTypes: ["login", "note"],
  updateItem: true,
  removeField: true,
  archiveItem: false,
  archiveKind: "none",
  deleteItem: false,
  restoreItem: false,
  readFiles: true,
  writeFiles: false,
  createTotp: true,
  updateTotp: true,
  createVault: false,
  restoreFieldHistory: false,
};

/**
 * Persists a changed configuration; the parent stores it encrypted with
 * compare-and-swap. `configuration` is canonical JSON of a string record
 * (binary entries are base64). `previous` is null for the first save after
 * binding a one-time token.
 */
export type PersistKeeperConfiguration = (
  configuration: string,
  context: { previous: string | null; reason: "bind" | "rotation" },
) => Promise<void>;

export interface KeeperRuntimeOptions {
  /** Hosts the configuration may name (default: Keeper's seven region hosts). */
  allowedHosts?: readonly string[];
  /** Per-request deadline handed to the SDK (default 15 s). */
  requestTimeoutMs?: number;
  /**
   * The fetch both default transports use (KSM API and file downloads).
   * Servers pass a DNS-pinned fetch; the per-call abort signal and deadline
   * are still applied. Ignored where `queryFunction` or `fetchFile` is given.
   */
  fetch?: KeeperFetch;
  /** SDK request function (tests); defaults to a bounded, no-redirect fetch transport. */
  queryFunction?: KeeperQueryFunction;
  /** Encrypted file download (tests); defaults to a bounded HTTPS fetch. */
  fetchFile?: KeeperFileFetcher;
  /** SDK loader (tests or bundlers that ship the SDK source themselves). */
  sdk?: KeeperSdkLoader;
  now?: () => number;
}

export interface KeeperVaultProviderOptions extends KeeperRuntimeOptions {
  /** Operations verified at setup; the adapter narrows to them and never widens. */
  operations?: VaultProviderOperations;
  /**
   * The bound KSM configuration from bootstrap or Keeper tooling: JSON, base64
   * JSON, or the parsed string record.
   */
  configuration: string | Readonly<Record<string, string>>;
  /** Awaited whenever the SDK changes the configuration (server key rotation). */
  persistConfiguration: PersistKeeperConfiguration;
  valueCacheMs?: number;
}

export type KeeperVaultProvider = VaultProvider & {
  readonly id: "keeper";
  /** The configuration as last persisted or pending persistence. */
  currentConfiguration(): string;
  close(): Promise<void>;
};

/** Keeper record and folder UIDs are 16-byte web-safe base64 (22 chars). */
const KEEPER_UID = /^[A-Za-z0-9_-]{16,64}$/;
function assertUids(...uids: string[]) {
  for (const uid of uids) {
    if (!KEEPER_UID.test(uid)) {
      throw new VaultProviderError("provider_not_found", "No such Keeper shared folder or record");
    }
  }
}

export interface KeeperOperation {
  sdk: KeeperSdk;
  options: SecretManagerOptions;
  console: CapturedConsole;
  tracker: MutationTracker & { mutating: boolean };
}

/**
 * Runs one operation in a fresh SDK instance over an in-memory copy of the
 * configuration, with the adapter's host allowlist, deadline and throttle
 * policy. Shared by the provider and bootstrap.
 */
export async function runKeeperOperation<T>(input: {
  runtime: KeeperRuntimeOptions;
  loader: KeeperSdkLoader;
  config: KeeperConfigValues;
  signal?: AbortSignal;
  work: (op: KeeperOperation, storage: ReturnType<typeof memoryKeeperStorage>) => Promise<T>;
  beforeNetwork?: (storage: ReturnType<typeof memoryKeeperStorage>) => void;
  /** Bootstrap sets the host inside `work`; every request is still checked. */
  hostInConfig?: boolean;
}): Promise<{ result: T; storage: ReturnType<typeof memoryKeeperStorage> }> {
  const allowed = (input.runtime.allowedHosts ?? KEEPER_DEFAULT_ALLOWED_HOSTS).map((host) =>
    host.toLowerCase(),
  );
  const { sdk, console } = input.loader.instance();
  const storage = memoryKeeperStorage(input.config);
  const transport =
    input.runtime.queryFunction ??
    createKeeperFetchTransport({
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.runtime.fetch ? { fetch: input.runtime.fetch } : {}),
    });
  const tracker = { sent: 0, lastStatus: null as number | null, mutating: false };
  const queryFunction: KeeperQueryFunction = async (
    url,
    transmissionKey,
    payload,
    allow,
    timeoutMs,
  ) => {
    input.signal?.throwIfAborted();
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.pathname.startsWith("/api/rest/sm/v1/")) {
      throw new VaultProviderError("provider_unavailable", "Refused an unexpected Keeper request");
    }
    assertAllowedHost(parsed.hostname, allowed);
    if (tracker.mutating) {
      tracker.sent += 1;
      tracker.lastStatus = null;
    }
    const response = await transport(url, transmissionKey, payload, false, timeoutMs);
    if (tracker.mutating) tracker.lastStatus = response.statusCode;
    return response;
  };
  const options: SecretManagerOptions = {
    storage,
    queryFunction,
    requestTimeoutMs: input.runtime.requestTimeoutMs ?? KEEPER_REQUEST_TIMEOUT_MS,
    // Never sleep inside a request: surface the server's back-off to the caller.
    throttleSleep: (ms) =>
      Promise.reject(
        new VaultProviderError(
          "provider_rate_limited",
          "Keeper is rate limiting this application",
          ms,
        ),
      ),
    onDecryptionError: () => {
      throw new VaultProviderError(
        "provider_inventory_incomplete",
        "Keeper returned a folder Opengeni could not decrypt",
      );
    },
  };
  input.beforeNetwork?.(storage);
  if (input.hostInConfig !== false) assertAllowedHost(storage.values.get("hostname"), allowed);
  const result = await input.work({ sdk, options, console, tracker }, storage);
  return { result, storage };
}

type CachedRecords = { at: number; records: Promise<KeeperRecord[]> };
type CachedRecord = { at: number; record: Promise<MappedKeeperRecord> };

function cacheFor<V>(map: WeakMap<ProviderCallBudget, Map<string, V>>, budget: ProviderCallBudget) {
  let cache = map.get(budget);
  if (!cache) {
    cache = new Map();
    map.set(budget, cache);
  }
  return cache;
}

export function createKeeperVaultProvider(
  options: KeeperVaultProviderOptions,
): KeeperVaultProvider {
  let config = parseKeeperConfiguration(options.configuration);
  let persisted = serializeKeeperConfiguration(config);
  let pending: string | null = null;
  const loader = options.sdk ?? createKeeperSdkLoader();
  const now = options.now ?? Date.now;
  const valueCacheMs = options.valueCacheMs ?? KEEPER_VALUE_CACHE_MS;
  const fetchFile = options.fetchFile ?? createKeeperFileFetcher(options.fetch);
  let queue: Promise<unknown> = Promise.resolve();
  // Per provider instance (one bound application) and per attempt budget.
  // Core shares one budget across every provider in an attempt, so a
  // module-level cache keyed only by budget would let one connection reuse
  // another's records for the same folder and record uids.
  const attemptListCaches = new WeakMap<ProviderCallBudget, Map<string, CachedRecords>>();
  const attemptRecordCaches = new WeakMap<ProviderCallBudget, Map<string, CachedRecord>>();

  async function flushPending() {
    if (pending === null) return;
    const next = pending;
    try {
      await options.persistConfiguration(next, { previous: persisted, reason: "rotation" });
    } catch {
      throw new VaultProviderError(
        "provider_unavailable",
        "Opengeni could not save the updated Keeper configuration",
      );
    }
    persisted = next;
    if (pending === next) pending = null;
  }

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** One budgeted, serialized operation in its own SDK instance. */
  function operation<T>(
    ctx: VaultProviderContext,
    op: "list" | "read" | "write",
    subject: string,
    work: (keeper: KeeperOperation) => Promise<T>,
  ): Promise<T> {
    ctx.signal?.throwIfAborted();
    ctx.budget.take(op);
    return serialized(async () => {
      ctx.signal?.throwIfAborted();
      await flushPending();
      let outcome: { result: T; storage: ReturnType<typeof memoryKeeperStorage> } | null = null;
      let failure: unknown = null;
      let storageRef: ReturnType<typeof memoryKeeperStorage> | null = null;
      let tracker: KeeperOperation["tracker"] | null = null;
      try {
        outcome = await runKeeperOperation({
          runtime: options,
          loader,
          config,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          beforeNetwork: (storage) => {
            storageRef = storage;
          },
          work: (keeper) => {
            tracker = keeper.tracker;
            return work(keeper);
          },
        });
      } catch (error) {
        failure = error;
      }
      // Keep any configuration the SDK changed (for example a rotated server key id), even on failure.
      const storage = outcome?.storage ?? storageRef;
      let persistError: VaultProviderError | null = null;
      if (storage?.changed()) {
        config = new Map(storage.values);
        pending = serializeKeeperConfiguration(config);
        try {
          await flushPending();
        } catch (error) {
          persistError = error as VaultProviderError;
        }
      }
      if (failure !== null) {
        const usedTracker = tracker as KeeperOperation["tracker"] | null;
        if (op === "write" && usedTracker && (usedTracker.sent > 0 || usedTracker.mutating)) {
          throw mapKeeperMutationError(failure, subject, usedTracker);
        }
        if (op !== "write" && failure instanceof Error && failure.name === "AbortError") {
          ctx.signal?.throwIfAborted();
        }
        throw mapKeeperError(failure, subject);
      }
      // A completed write stays successful; its configuration is retried on the next call.
      if (persistError && op !== "write") throw persistError;
      return outcome!.result;
    });
  }

  function reportFresh(ctx: VaultProviderContext) {
    const at = new Date(now()).toISOString();
    ctx.onFreshness?.({
      state: "current",
      lastCheckedAt: at,
      sourceSyncedAt: at,
      source: "live",
      errorCode: null,
      retryAt: null,
    });
  }

  function incomplete(): never {
    throw new VaultProviderError(
      "provider_inventory_incomplete",
      "Keeper returned records Opengeni could not decrypt; the listing is incomplete",
    );
  }

  /** All records visible to the application, cached per attempt. */
  function allRecords(ctx: VaultProviderContext): Promise<KeeperRecord[]> {
    const cache = cacheFor(attemptListCaches, ctx.budget);
    const key = ctx.cacheEpoch ?? "";
    const cached = cache.get(key);
    if (cached && !ctx.forceRefresh && now() - cached.at < valueCacheMs) return cached.records;
    const records = operation(
      ctx,
      "list",
      "list records",
      async ({ sdk, options: sdkOptions, console }) => {
        const secrets = await sdk.getSecrets2(sdkOptions);
        if (console.skippedSomething) incomplete();
        return secrets.records;
      },
    );
    const entry = { at: now(), records };
    cache.set(key, entry);
    records.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    return records;
  }

  async function fetchRecord(
    keeper: KeeperOperation,
    externalVaultId: string,
    externalItemId: string,
  ): Promise<KeeperRecord> {
    const secrets = await keeper.sdk.getSecrets2(keeper.options, {
      recordsFilter: [externalItemId],
    });
    const record = secrets.records.find((candidate) => candidate.recordUid === externalItemId);
    if (!record) {
      if (keeper.console.skippedSomething) {
        throw new VaultProviderError(
          "provider_unavailable",
          "Opengeni could not decrypt this Keeper record",
        );
      }
      throw new VaultProviderError("provider_not_found", "No such Keeper record");
    }
    // A record is addressed through its shared folder; never read across folders.
    if (record.folderUid !== externalVaultId) {
      throw new VaultProviderError(
        "provider_not_found",
        "No such Keeper record in this shared folder",
      );
    }
    return record;
  }

  function materialFor(mapped: MappedKeeperRecord, field: MappedKeeperField): SecretMaterial {
    if (field.kind === "totp") {
      const params = totpParamsFor(field.value);
      if (!params) {
        throw new VaultProviderError(
          "provider_unavailable",
          `The one-time code in Keeper record "${mapped.meta.name}" is not a valid TOTP seed`,
        );
      }
      return { type: "totp", params };
    }
    return { type: "text", value: field.value };
  }

  async function readFile(keeper: KeeperOperation, field: MappedKeeperField, signal?: AbortSignal) {
    if (field.source.kind !== "file") throw new Error("not a file field");
    const file = field.source.file;
    const limit = VAULT_LIMITS.fileValueMaxBytes;
    const size = fileSize(file);
    if (size === null || size > limit) {
      throw new VaultProviderError(
        "provider_unavailable",
        `"${field.name}" is larger than Opengeni reads from Keeper`,
      );
    }
    if (!file.url)
      throw new VaultProviderError("provider_unavailable", "Keeper returned no download URL");
    const encrypted = await fetchFile(file.url, {
      ...(signal ? { signal } : {}),
      // AES-GCM adds a 12-byte nonce and a 16-byte tag.
      maxBytes: limit + 28,
      timeoutMs: options.requestTimeoutMs ?? KEEPER_REQUEST_TIMEOUT_MS,
    });
    // The file key was unwrapped into this instance's cache when the record was fetched.
    const plain = await keeper.sdk.platform.decrypt(encrypted, file.fileUid);
    if (plain.byteLength > limit) {
      throw new VaultProviderError(
        "provider_unavailable",
        `"${field.name}" is larger than Opengeni reads from Keeper`,
      );
    }
    return new Uint8Array(plain);
  }

  const provider: KeeperVaultProvider = {
    id: "keeper",

    capabilities(): VaultProviderCapabilities {
      return {
        write: true,
        createVault: false,
        totp: true,
        // Legacy flag means file writes; reads are declared in operations.readFiles.
        files: false,
        groupGrants: false,
        passkeys: false,
        operations: {
          ...KEEPER_OPERATIONS,
          createItemTypes: [...KEEPER_OPERATIONS.createItemTypes],
        },
      };
    },

    async validate(ctx) {
      const name = await operation(
        ctx,
        "list",
        "validate",
        async ({ sdk, options: sdkOptions }) => {
          const secrets = await sdk.getSecrets2(sdkOptions);
          const title = secrets.appData?.title;
          return typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : null;
        },
      );
      return { accountName: name };
    },

    async listVaults(ctx): Promise<ProviderVault[]> {
      const folders = await operation(
        ctx,
        "list",
        "list shared folders",
        async ({ sdk, options: sdkOptions, console }) => {
          const result = await sdk.getFolders(sdkOptions);
          if (console.skippedSomething) incomplete();
          return result;
        },
      );
      reportFresh(ctx);
      return folders
        .filter((folder) => !folder.parentUid)
        .map((folder) => ({
          externalVaultId: folder.folderUid,
          name: safeSecretName(folder.name ?? "", folder.folderUid),
          contentVersion: null,
          itemCount: null,
          // KSM does not tell an application whether a shared folder is editable.
          writeAccess: "unknown" as const,
        }));
    },

    async listItems(ctx, externalVaultId): Promise<ProviderItemMeta[]> {
      assertUids(externalVaultId);
      const records = await allRecords(ctx);
      const metas = records
        .filter((record) => record.folderUid === externalVaultId)
        .map((record) => mapRecord(record).meta);
      if (metas.length > VAULT_LIMITS.itemsPerVault) {
        throw new VaultProviderError(
          "provider_inventory_incomplete",
          "The Keeper shared folder has more records than Opengeni mirrors at once",
        );
      }
      for (const meta of metas) assertMirrorable(meta);
      reportFresh(ctx);
      return metas;
    },

    async readFields(ctx, externalVaultId, externalItemId, externalFieldIds) {
      assertUids(externalVaultId, externalItemId);
      const wantsFile = externalFieldIds.some((id) => id.startsWith("@file:"));
      const cache = cacheFor(attemptRecordCaches, ctx.budget);
      const key = `${ctx.cacheEpoch ?? ""}|${externalVaultId}/${externalItemId}`;
      const cached = cache.get(key);
      if (!wantsFile && cached && !ctx.forceRefresh && now() - cached.at < valueCacheMs) {
        const mapped = await cached.record;
        return externalFieldIds.map((externalFieldId) => {
          const field = mapped.fields.find(
            (candidate) => candidate.externalFieldId === externalFieldId,
          );
          if (!field)
            throw new VaultProviderError(
              "provider_not_found",
              `Keeper record has no field ${externalFieldId}`,
            );
          return { externalFieldId, material: materialFor(mapped, field) };
        });
      }
      let resolveMapped!: (value: MappedKeeperRecord) => void;
      let rejectMapped!: (error: unknown) => void;
      const mappedPromise = new Promise<MappedKeeperRecord>((resolve, reject) => {
        resolveMapped = resolve;
        rejectMapped = reject;
      });
      mappedPromise.catch(() => {});
      const entry = { at: now(), record: mappedPromise };
      cache.set(key, entry);
      try {
        return await operation(ctx, "read", "read record", async (keeper) => {
          const record = await fetchRecord(keeper, externalVaultId, externalItemId);
          const mapped = mapRecord(record);
          // Files are read on demand and never cached.
          resolveMapped({
            ...mapped,
            fields: mapped.fields.filter((field) => field.kind !== "file"),
          });
          const values: ProviderFieldValue[] = [];
          for (const externalFieldId of externalFieldIds) {
            const field = mapped.fields.find(
              (candidate) => candidate.externalFieldId === externalFieldId,
            );
            if (!field) {
              throw new VaultProviderError(
                "provider_not_found",
                `Keeper record "${mapped.meta.name}" has no field ${externalFieldId}`,
              );
            }
            values.push({
              externalFieldId,
              material:
                field.kind === "file"
                  ? { type: "bytes", value: await readFile(keeper, field, ctx.signal) }
                  : materialFor(mapped, field),
            });
          }
          return values;
        });
      } catch (error) {
        rejectMapped(error);
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      }
    },

    async writeItem(ctx, externalVaultId, item): Promise<ProviderItemMeta> {
      assertUids(externalVaultId);
      const meta = await writeRecord(ctx, externalVaultId, item);
      // Drop this attempt's cached listings and values; the record changed.
      attemptRecordCaches.get(ctx.budget)?.clear();
      attemptListCaches.get(ctx.budget)?.clear();
      return meta;
    },

    async archiveItem() {
      throw new VaultProviderError(
        "provider_unavailable",
        "Keeper Secrets Manager applications cannot archive or trash records; remove it in Keeper",
      );
    },

    currentConfiguration: () => serializeKeeperConfiguration(config),
    close: async () => {
      await queue.catch(() => {});
    },
  };

  function writeRecord(
    ctx: VaultProviderContext,
    externalVaultId: string,
    item: Parameters<VaultProvider["writeItem"]>[2],
  ): Promise<ProviderItemMeta> {
    if (item.externalItemId === undefined) {
      const data = buildCreateData(item);
      return operation(ctx, "write", "create record", async (keeper) => {
        const folders = await keeper.sdk.getFolders(keeper.options);
        const folder = folders.find((candidate) => candidate.folderUid === externalVaultId);
        if (!folder || folder.parentUid) {
          throw new VaultProviderError("provider_not_found", "No such Keeper shared folder");
        }
        keeper.tracker.mutating = true;
        const recordUid = await keeper.sdk.createSecret2(
          keeper.options,
          { folderUid: externalVaultId },
          data,
        );
        keeper.tracker.mutating = false;
        try {
          return mapRecord(await fetchRecord(keeper, externalVaultId, recordUid)).meta;
        } catch {
          const meta = mapRecord({
            recordUid,
            folderUid: externalVaultId,
            data,
            revision: Number.NaN,
          }).meta;
          return { ...meta, version: null };
        }
      });
    }
    const recordUid = item.externalItemId;
    assertUids(recordUid);
    return operation(ctx, "write", "update record", async (keeper) => {
      const record = await fetchRecord(keeper, externalVaultId, recordUid);
      if (
        item.expectedVersion !== undefined &&
        item.expectedVersion !== null &&
        String(record.revision) !== item.expectedVersion
      ) {
        throw new VaultProviderError(
          "provider_conflict",
          "The Keeper record changed since it was read; read it again before writing",
        );
      }
      applyPatch(record, item);
      keeper.tracker.mutating = true;
      await keeper.sdk.updateSecret2(keeper.options, record);
      keeper.tracker.mutating = false;
      try {
        return mapRecord(await fetchRecord(keeper, externalVaultId, recordUid)).meta;
      } catch {
        return { ...mapRecord(record).meta, version: null };
      }
    });
  }

  return restrictToOperations(provider, options.operations, FILE_FIELD_PREFIX);
}

/**
 * Opengeni mirrors at most `fieldsPerItem` fields and `websitesPerItem`
 * websites of up to `websiteMaxChars` each. A larger record would be cut down
 * and then look complete, so the listing is reported incomplete instead.
 */
function assertMirrorable(meta: ProviderItemMeta): void {
  if (
    meta.fields.length > VAULT_LIMITS.fieldsPerItem ||
    meta.websites.length > VAULT_LIMITS.websitesPerItem ||
    meta.websites.some((website) => website.length > VAULT_LIMITS.websiteMaxChars)
  ) {
    throw new VaultProviderError(
      "provider_inventory_incomplete",
      `A Keeper record has more than ${VAULT_LIMITS.fieldsPerItem} fields or ${VAULT_LIMITS.websitesPerItem} websites (or a website over ${VAULT_LIMITS.websiteMaxChars} characters), more than Opengeni mirrors`,
    );
  }
}
