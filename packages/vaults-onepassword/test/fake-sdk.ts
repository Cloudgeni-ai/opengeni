import type {
  OnePasswordSdk,
  OnePasswordSdkClient,
  SdkItem,
  SdkItemCreateParams,
  SdkVaultOverview,
} from "../src/sdk";

// Error shapes as the real SDK throws them (sdk/dist/errors.js + WASM messages).
export class RateLimitExceededError extends Error {
  constructor(message: string) {
    super();
    this.message = message;
  }
}
export class AuthExpiredError extends Error {
  constructor(message: string) {
    super();
    this.message = message;
  }
}
export const NOT_FOUND = "error resolving item: resource not found";
export const NO_PERMISSION = "you don't have the right permissions to access this resource";
export const STALE_VERSION = "error updating item: incorrect item version";
export const NOT_AUTHENTICATED = "you are not authenticated";

type FakeVault = SdkVaultOverview & { writable: boolean; items: Map<string, SdkItem>; archived: Set<string> };

export type FakeSdkCall = { op: string; vaultId?: string; itemId?: string };

let idCounter = 0;
const nextId = () => `fake${(++idCounter).toString(36).padStart(22, "0")}`;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createFakeOnePasswordSdk(seed: {
  vaults: Array<{ id?: string; title: string; writable: boolean; items?: Array<Partial<SdkItem> & { title: string; category: string }> }>;
}) {
  const vaults = new Map<string, FakeVault>();
  for (const vault of seed.vaults) {
    const id = vault.id ?? nextId();
    const fake: FakeVault = {
      id,
      title: vault.title,
      description: "",
      vaultType: "userCreated",
      activeItemCount: 0,
      contentVersion: 1,
      writable: vault.writable,
      items: new Map(),
      archived: new Set(),
    };
    for (const item of vault.items ?? []) {
      const itemId = item.id ?? nextId();
      fake.items.set(itemId, {
        fields: [],
        sections: [],
        notes: "",
        tags: [],
        websites: [],
        files: [],
        version: 1,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...item,
        id: itemId,
        vaultId: id,
      } as SdkItem);
    }
    fake.activeItemCount = fake.items.size;
    vaults.set(id, fake);
  }

  const calls: FakeSdkCall[] = [];
  const failures: Array<{ op: string | null; error: () => Error }> = [];
  let signIns = 0;

  function record(op: string, vaultId?: string, itemId?: string) {
    calls.push({ op, ...(vaultId ? { vaultId } : {}), ...(itemId ? { itemId } : {}) });
    const index = failures.findIndex((failure) => failure.op === null || failure.op === op);
    if (index >= 0) {
      const [failure] = failures.splice(index, 1);
      throw failure!.error();
    }
  }
  function vaultOf(vaultId: string): FakeVault {
    const vault = vaults.get(vaultId);
    if (!vault) throw new Error(NOT_FOUND);
    return vault;
  }
  function activeItem(vault: FakeVault, itemId: string): SdkItem {
    const item = vault.items.get(itemId);
    if (!item || vault.archived.has(itemId)) throw new Error(NOT_FOUND);
    return item;
  }
  function bump(vault: FakeVault) {
    vault.contentVersion += 1;
    vault.activeItemCount = [...vault.items.keys()].filter((id) => !vault.archived.has(id)).length;
  }

  const client: OnePasswordSdkClient = {
    vaults: {
      async list() {
        record("vaults.list");
        return [...vaults.values()].map(({ items: _i, archived: _a, writable: _w, ...overview }) =>
          clone(overview),
        );
      },
      async create(params) {
        record("vaults.create");
        const id = nextId();
        const vault: FakeVault = {
          id,
          title: params.title,
          description: params.description ?? "",
          vaultType: "userCreated",
          activeItemCount: 0,
          contentVersion: 1,
          writable: true,
          items: new Map(),
          archived: new Set(),
        };
        vaults.set(id, vault);
        const { items: _i, archived: _a, writable: _w, ...overview } = vault;
        return clone(overview);
      },
      async delete(vaultId) {
        record("vaults.delete", vaultId);
        vaultOf(vaultId);
        vaults.delete(vaultId);
      },
      async grantGroupPermissions(vaultId) {
        record("vaults.grantGroupPermissions", vaultId);
        vaultOf(vaultId);
      },
    },
    items: {
      async list(vaultId) {
        record("items.list", vaultId);
        const vault = vaultOf(vaultId);
        return [...vault.items.values()]
          .filter((item) => !vault.archived.has(item.id))
          .map((item) => ({
            id: item.id,
            title: item.title,
            category: item.category,
            vaultId,
            websites: clone(item.websites),
            updatedAt: item.updatedAt,
            state: "active",
          }));
      },
      async get(vaultId, itemId) {
        record("items.get", vaultId, itemId);
        return clone(activeItem(vaultOf(vaultId), itemId));
      },
      async getAll(vaultId, itemIds) {
        record("items.getAll", vaultId);
        const vault = vaultOf(vaultId);
        return {
          individualResponses: itemIds.map((id) => {
            const item = vault.items.get(id);
            return item && !vault.archived.has(id)
              ? { content: clone(item) }
              : { error: { type: "itemNotFound" } };
          }),
        };
      },
      async create(params: SdkItemCreateParams) {
        record("items.create", params.vaultId);
        const vault = vaultOf(params.vaultId);
        if (!vault.writable) throw new Error(NO_PERMISSION);
        for (const field of params.fields ?? []) {
          if (field.sectionId && !(params.sections ?? []).some((s) => s.id === field.sectionId)) {
            throw new Error("validation error: field references a missing section");
          }
        }
        const item: SdkItem = {
          id: nextId(),
          title: params.title,
          category: params.category,
          vaultId: params.vaultId,
          fields: clone(params.fields ?? []),
          sections: clone(params.sections ?? []),
          notes: params.notes ?? "",
          tags: params.tags ?? [],
          websites: clone(params.websites ?? []),
          version: 1,
          files: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        vault.items.set(item.id, item);
        bump(vault);
        return clone(item);
      },
      async put(item) {
        record("items.put", item.vaultId, item.id);
        const vault = vaultOf(item.vaultId);
        const current = activeItem(vault, item.id);
        if (!vault.writable) throw new Error(NO_PERMISSION);
        if (current.version !== item.version) throw new Error(STALE_VERSION);
        const saved: SdkItem = { ...clone(item), version: current.version + 1, updatedAt: new Date() };
        vault.items.set(item.id, saved);
        bump(vault);
        return clone(saved);
      },
      async archive(vaultId, itemId) {
        record("items.archive", vaultId, itemId);
        const vault = vaultOf(vaultId);
        activeItem(vault, itemId);
        if (!vault.writable) throw new Error(NO_PERMISSION);
        vault.archived.add(itemId);
        bump(vault);
      },
      async delete(vaultId, itemId) {
        record("items.delete", vaultId, itemId);
        const vault = vaultOf(vaultId);
        if (!vault.writable) throw new Error(NO_PERMISSION);
        if (!vault.items.delete(itemId)) throw new Error(NOT_FOUND);
        vault.archived.delete(itemId);
        bump(vault);
      },
      files: {
        async read(vaultId, itemId, attributes) {
          record("items.files.read", vaultId, itemId);
          activeItem(vaultOf(vaultId), itemId);
          return new TextEncoder().encode(`file:${attributes.name}`);
        },
      },
    },
  };

  const sdk: OnePasswordSdk = {
    async createClient(config) {
      signIns += 1;
      if (!config.auth.startsWith("ops_")) {
        throw new Error("invalid service account token, please make sure you provide a valid service account token as parameter");
      }
      return client;
    },
    RateLimitExceededError,
    AuthExpiredError,
  };

  return {
    sdk,
    client,
    vaults,
    calls,
    get signIns() {
      return signIns;
    },
    /** Makes the next matching SDK call (or any call when op is null) throw. */
    failNext(op: string | null, error: () => Error) {
      failures.push({ op, error });
    },
    /** Simulates a concurrent edit in 1Password (bumps the item version). */
    touch(vaultId: string, itemId: string) {
      const vault = vaultOf(vaultId);
      const item = activeItem(vault, itemId);
      vault.items.set(itemId, { ...item, version: item.version + 1, updatedAt: new Date() });
      bump(vault);
    },
  };
}

/** A syntactically valid (fake) service-account token for adapter tests. */
export function fakeServiceAccountToken(signInAddress = "https://my.1password.com/"): string {
  const body = {
    signInAddress,
    userAuth: { method: "SRPg-4096", alg: "PBES2g-HS256", iterations: 650000, salt: "x" },
    email: "test@example.invalid",
    srpX: "00",
    muk: { alg: "A256GCM", ext: true, k: "x", key_ops: ["encrypt", "decrypt"], kty: "oct", kid: "mp" },
    secretKey: "A3-XXXXXX",
    throttleSecret: { seed: "00", uuid: "x" },
    deviceUuid: "x",
  };
  return `ops_${Buffer.from(JSON.stringify(body)).toString("base64")}`;
}
