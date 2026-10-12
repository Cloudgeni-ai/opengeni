/**
 * The narrow slice of `@1password/sdk` this adapter uses, typed structurally so
 * tests can inject an in-memory double and so the SDK (a ~14 MB WASM core) is
 * only ever loaded through `loadOnePasswordSdk()`'s dynamic import.
 */
export type SdkFieldType =
  | "Text"
  | "Concealed"
  | "CreditCardType"
  | "CreditCardNumber"
  | "Phone"
  | "Url"
  | "Totp"
  | "Email"
  | "Reference"
  | "SshKey"
  | "Menu"
  | "MonthYear"
  | "Address"
  | "Date"
  | "Unsupported";

export interface SdkItemField {
  id: string;
  title: string;
  sectionId?: string;
  fieldType: SdkFieldType | (string & {});
  value: string;
  details?: { type: string; content?: { code?: string; errorMessage?: string } | unknown };
}
export interface SdkWebsite {
  url: string;
  label: string;
  autofillBehavior: string;
}
export interface SdkFileAttributes {
  name: string;
  id: string;
  size: number;
}
export interface SdkItem {
  id: string;
  title: string;
  category: string;
  vaultId: string;
  fields: SdkItemField[];
  sections: Array<{ id: string; title: string }>;
  notes: string;
  tags: string[];
  websites: SdkWebsite[];
  version: number;
  files: Array<{ attributes: SdkFileAttributes; sectionId: string; fieldId: string }>;
  document?: SdkFileAttributes;
  createdAt: Date;
  updatedAt: Date;
}
export interface SdkItemOverview {
  id: string;
  title: string;
  category: string;
  vaultId: string;
  websites: SdkWebsite[];
  updatedAt: Date;
  state: string;
}
export interface SdkItemCreateParams {
  category: string;
  vaultId: string;
  title: string;
  fields?: SdkItemField[];
  sections?: Array<{ id: string; title: string }>;
  notes?: string;
  tags?: string[];
  websites?: SdkWebsite[];
}
export interface SdkVaultOverview {
  id: string;
  title: string;
  description: string;
  vaultType: string;
  activeItemCount: number;
  contentVersion: number;
}
export type SdkItemListFilter = {
  type: "ByState";
  content: { active: boolean; archived: boolean };
};
export interface SdkGetAllResponse {
  individualResponses: Array<{ content?: SdkItem; error?: { type: string; message?: string } }>;
}

export interface OnePasswordSdkClient {
  vaults: {
    list(params?: { decryptDetails?: boolean }): Promise<SdkVaultOverview[]>;
    create(params: {
      title: string;
      description?: string;
      allowAdminsAccess?: boolean;
    }): Promise<SdkVaultOverview>;
    delete(vaultId: string): Promise<void>;
    grantGroupPermissions(
      vaultId: string,
      groups: Array<{ groupId: string; permissions: number }>,
    ): Promise<void>;
  };
  items: {
    list(vaultId: string, ...filters: SdkItemListFilter[]): Promise<SdkItemOverview[]>;
    get(vaultId: string, itemId: string): Promise<SdkItem>;
    getAll(vaultId: string, itemIds: string[]): Promise<SdkGetAllResponse>;
    create(params: SdkItemCreateParams): Promise<SdkItem>;
    put(item: SdkItem): Promise<SdkItem>;
    archive(vaultId: string, itemId: string): Promise<void>;
    delete(vaultId: string, itemId: string): Promise<void>;
    files: {
      read(vaultId: string, itemId: string, attributes: SdkFileAttributes): Promise<Uint8Array>;
    };
  };
}

export interface OnePasswordSdk {
  createClient(config: {
    auth: string;
    integrationName: string;
    integrationVersion: string;
  }): Promise<OnePasswordSdkClient>;
  RateLimitExceededError?: abstract new (...args: never[]) => Error;
  AuthExpiredError?: abstract new (...args: never[]) => Error;
}

export const ONEPASSWORD_SDK_VERSION = "0.5.0";
export const ONEPASSWORD_INTEGRATION_NAME = "OpenGeni";

let sdkPromise: Promise<OnePasswordSdk> | null = null;

/** Lazily loads the pinned SDK (WASM) once per process. */
export function loadOnePasswordSdk(): Promise<OnePasswordSdk> {
  sdkPromise ??= import("@1password/sdk").then(
    (module) =>
      ({
        createClient: module.createClient as unknown as OnePasswordSdk["createClient"],
        RateLimitExceededError: module.RateLimitExceededError,
        AuthExpiredError: module.AuthExpiredError,
      }) satisfies OnePasswordSdk,
  );
  return sdkPromise;
}

/**
 * One signed-in client per token per process. Creating a client performs the
 * SRP sign-in (several requests), so reuse matters for the account quota.
 * The cache must hold the SDK `Client` object itself: the SDK releases the
 * WASM session when that object is garbage collected, so keeping only
 * `client.items` / `client.vaults` fails later calls with "invalid client id".
 */
export class OnePasswordClientCache {
  private readonly clients = new Map<string, Promise<OnePasswordSdkClient>>();

  get(key: string, create: () => Promise<OnePasswordSdkClient>): Promise<OnePasswordSdkClient> {
    let client = this.clients.get(key);
    if (!client) {
      client = create();
      this.clients.set(key, client);
      client.catch(() => {
        if (this.clients.get(key) === client) this.clients.delete(key);
      });
    }
    return client;
  }

  drop(key: string) {
    this.clients.delete(key);
  }

  /** True when a signed-in (or signing-in) client exists for `key`. */
  has(key: string): boolean {
    return this.clients.has(key);
  }

  clear() {
    this.clients.clear();
  }
}

export const sharedOnePasswordClientCache = new OnePasswordClientCache();
