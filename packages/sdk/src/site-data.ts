/**
 * Site Data for Site HTML: persistent JSON collections and files that belong
 * to the published Site. Requests travel over the host's Site HTTP channel;
 * the host adds the viewer's credentials and pins the Site, and the API
 * enforces each collection's access mode. Stored records are untrusted input:
 * render them with textContent, never innerHTML.
 */

export type OpenGeniSiteDataErrorCode =
  | "validation"
  | "conflict"
  | "not_found"
  | "forbidden"
  | "quota_exceeded"
  | "rate_limited"
  | "site_data_unsupported"
  | "request_failed";

export class OpenGeniSiteDataError extends Error {
  constructor(
    readonly code: OpenGeniSiteDataErrorCode,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "OpenGeniSiteDataError";
  }
}

export type OpenGeniSiteDataRecord<T extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  key: string | null;
  data: T;
  /** Principal that owns the record, such as `user:<id>`. */
  owner: string;
  createdBy: string;
  updatedBy: string;
  version: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type OpenGeniSiteDataScalar = string | number | boolean | null;

export type OpenGeniSiteDataFilter = {
  /** Dotted data path (up to 4 levels) or $id, $key, $owner, $createdAt, $updatedAt, $version. */
  field: string;
  op: "eq" | "ne" | "in" | "gt" | "gte" | "lt" | "lte" | "contains" | "exists";
  value?: OpenGeniSiteDataScalar | OpenGeniSiteDataScalar[];
};

export type OpenGeniSiteDataListOptions = {
  where?: OpenGeniSiteDataFilter[];
  sort?: Array<{ field: string; direction?: "asc" | "desc" }>;
  /** 1 to 200; 50 by default. */
  limit?: number;
  cursor?: string | null;
  count?: boolean;
  /** `own` returns only the viewer's records. */
  scope?: "own" | "all";
};

export type OpenGeniSiteDataPage<T extends Record<string, unknown> = Record<string, unknown>> = {
  records: OpenGeniSiteDataRecord<T>[];
  nextCursor: string | null;
  count?: number;
};

/** A record by id, or by your own key. A plain string is treated as a key. */
export type OpenGeniSiteDataRef = string | { id: string } | { key: string };

export type OpenGeniSiteDataOperation =
  | { op: "insert"; collection: string; key?: string; data: Record<string, unknown> }
  | {
      op: "put";
      collection: string;
      key: string;
      data: Record<string, unknown>;
      expectedVersion?: number;
    }
  | ({
      op: "patch";
      collection: string;
      data: Record<string, unknown>;
      expectedVersion?: number;
    } & RefFields)
  | ({ op: "delete"; collection: string; expectedVersion?: number } & RefFields)
  | ({ op: "increment"; collection: string; field: string; by?: number } & RefFields);

type RefFields = { id: string; key?: never } | { key: string; id?: never };

export type OpenGeniSiteDataWriteResult =
  | { op: "insert" | "put" | "patch" | "increment"; record: OpenGeniSiteDataRecord }
  | { op: "delete"; deleted: { id: string } };

export type OpenGeniSiteDataCollection<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly name: string;
  list(options?: OpenGeniSiteDataListOptions): Promise<OpenGeniSiteDataPage<T>>;
  /** Resolves null when the record does not exist or is not visible to the viewer. */
  get(ref: OpenGeniSiteDataRef): Promise<OpenGeniSiteDataRecord<T> | null>;
  insert(data: T, options?: { key?: string }): Promise<OpenGeniSiteDataRecord<T>>;
  /** Create or replace the record with this key. */
  put(
    key: string,
    data: T,
    options?: { expectedVersion?: number },
  ): Promise<OpenGeniSiteDataRecord<T>>;
  /** Shallow-merge fields; expectedVersion turns concurrent edits into a conflict error. */
  patch(
    ref: OpenGeniSiteDataRef,
    data: Partial<T>,
    options?: { expectedVersion?: number },
  ): Promise<OpenGeniSiteDataRecord<T>>;
  delete(ref: OpenGeniSiteDataRef, options?: { expectedVersion?: number }): Promise<void>;
  /** Atomically add to a numeric field; a missing key is created. */
  increment(
    ref: OpenGeniSiteDataRef,
    field: string,
    by?: number,
  ): Promise<OpenGeniSiteDataRecord<T>>;
  count(where?: OpenGeniSiteDataFilter[], options?: { scope?: "own" | "all" }): Promise<number>;
};

export type OpenGeniSiteData = {
  collection<T extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
  ): OpenGeniSiteDataCollection<T>;
  /** Up to 100 operations across collections, applied together or not at all. */
  batch(operations: OpenGeniSiteDataOperation[]): Promise<OpenGeniSiteDataWriteResult[]>;
  count(collection: string, where?: OpenGeniSiteDataFilter[]): Promise<number>;
};

export type OpenGeniSiteFile = {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  /** shared: every viewer can open it. private: only the uploader and the Site's managers. */
  scope: "shared" | "private";
  owner: string;
  createdBy: string;
  createdAt: string;
};

export type OpenGeniSiteFiles = {
  upload(
    file: Blob | ArrayBuffer | Uint8Array,
    options?: { name?: string; contentType?: string; scope?: "shared" | "private" },
  ): Promise<OpenGeniSiteFile>;
  list(options?: { limit?: number; cursor?: string | null }): Promise<{
    files: OpenGeniSiteFile[];
    nextCursor: string | null;
  }>;
  /** A short-lived download URL for an img/src, link or fetch. */
  url(fileId: string): Promise<{ url: string; expiresAt: string; file: OpenGeniSiteFile }>;
  delete(fileId: string): Promise<void>;
};

/** Path prefix the host rewrites to its pinned Site; Site code never names a Site id. */
export const SITE_DATA_PATH_PREFIX = "/v1/workspaces/site-host/published-artifacts/current";

type SiteDataFetch = (path: string, init: RequestInit) => Promise<Response>;

/**
 * Build the typed Site Data facade over a Site HTTP fetch. `ready` resolves
 * once the host has said whether it serves Site Data.
 */
export function createOpenGeniSiteData(
  fetchSite: SiteDataFetch,
  ready: () => Promise<boolean>,
): { data: OpenGeniSiteData; files: OpenGeniSiteFiles } {
  const send = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    if (!(await ready()))
      throw new OpenGeniSiteDataError(
        "site_data_unsupported",
        "This Site host does not provide Site Data",
        0,
      );
    const response = await fetchSite(`${SITE_DATA_PATH_PREFIX}${path}`, init);
    const text = await response.text();
    let value: unknown = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      value = null;
    }
    if (response.ok) return value as T;
    throw siteDataErrorFromResponse(response.status, value);
  };
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const write = async (operations: OpenGeniSiteDataOperation[]) =>
    (await send<{ results: OpenGeniSiteDataWriteResult[] }>("/data/write", json({ operations })))
      .results;
  const one = async (operation: OpenGeniSiteDataOperation) => {
    const [result] = await write([operation]);
    if (!result || !("record" in result))
      throw new OpenGeniSiteDataError("request_failed", "Unexpected Site Data response", 200);
    return result.record;
  };
  const count = async (
    collection: string,
    where?: OpenGeniSiteDataFilter[],
    scope?: "own" | "all",
  ) =>
    (
      await send<OpenGeniSiteDataPage>(
        "/data/query",
        json({
          collection,
          limit: 1,
          count: true,
          ...(where ? { where } : {}),
          ...(scope ? { scope } : {}),
        }),
      )
    ).count ?? 0;

  const data: OpenGeniSiteData = {
    collection<T extends Record<string, unknown> = Record<string, unknown>>(name: string) {
      const collection: OpenGeniSiteDataCollection<T> = {
        name,
        list: async (options = {}) =>
          await send<OpenGeniSiteDataPage<T>>(
            "/data/query",
            json({ collection: name, ...options }),
          ),
        get: async (ref) => {
          try {
            return (
              await send<{ record: OpenGeniSiteDataRecord<T> }>(
                "/data/get",
                json({ collection: name, ...refFields(ref) }),
              )
            ).record;
          } catch (error) {
            if (error instanceof OpenGeniSiteDataError && error.code === "not_found") return null;
            throw error;
          }
        },
        insert: async (value, options = {}) =>
          (await one({
            op: "insert",
            collection: name,
            data: value,
            ...(options.key === undefined ? {} : { key: options.key }),
          })) as OpenGeniSiteDataRecord<T>,
        put: async (key, value, options = {}) =>
          (await one({
            op: "put",
            collection: name,
            key,
            data: value,
            ...options,
          })) as OpenGeniSiteDataRecord<T>,
        patch: async (ref, value, options = {}) =>
          (await one({
            op: "patch",
            collection: name,
            ...refFields(ref),
            data: value as Record<string, unknown>,
            ...options,
          })) as OpenGeniSiteDataRecord<T>,
        delete: async (ref, options = {}) => {
          await write([{ op: "delete", collection: name, ...refFields(ref), ...options }]);
        },
        increment: async (ref, field, by) =>
          (await one({
            op: "increment",
            collection: name,
            ...refFields(ref),
            field,
            ...(by === undefined ? {} : { by }),
          })) as OpenGeniSiteDataRecord<T>,
        count: async (where, options = {}) => await count(name, where, options.scope),
      };
      return collection;
    },
    batch: write,
    count: async (collection, where) => await count(collection, where),
  };

  const files: OpenGeniSiteFiles = {
    upload: async (file, options = {}) => {
      const blob =
        file instanceof Blob
          ? file
          : new Blob([file instanceof Uint8Array ? file.slice() : file], {
              type: options.contentType ?? "application/octet-stream",
            });
      const name =
        options.name ?? (typeof File !== "undefined" && file instanceof File ? file.name : "file");
      const query = new URLSearchParams({ name, scope: options.scope ?? "shared" });
      return await send<OpenGeniSiteFile>(`/files?${query}`, {
        method: "POST",
        headers: {
          "content-type": options.contentType ?? (blob.type || "application/octet-stream"),
        },
        body: await blob.arrayBuffer(),
      });
    },
    list: async (options = {}) => {
      const query = new URLSearchParams();
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      if (options.cursor) query.set("cursor", options.cursor);
      const suffix = query.size ? `?${query}` : "";
      return await send(`/files${suffix}`, { method: "GET" });
    },
    url: async (fileId) => await send(`/files/${encodeURIComponent(fileId)}`, { method: "GET" }),
    delete: async (fileId) => {
      await send(`/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
    },
  };
  return { data, files };
}

function refFields(ref: OpenGeniSiteDataRef): RefFields {
  if (typeof ref === "string") return { key: ref };
  if ("id" in ref) return { id: ref.id };
  return { key: ref.key };
}

const KNOWN_CODES = new Set<OpenGeniSiteDataErrorCode>([
  "validation",
  "conflict",
  "not_found",
  "forbidden",
  "quota_exceeded",
  "rate_limited",
]);

function siteDataErrorFromResponse(status: number, value: unknown): OpenGeniSiteDataError {
  const error =
    typeof value === "object" && value !== null && "error" in value
      ? (value as { error: unknown }).error
      : null;
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const details =
    typeof record.details === "object" && record.details !== null
      ? (record.details as Record<string, unknown>)
      : {};
  const detailCode = details.code as OpenGeniSiteDataErrorCode | undefined;
  const code: OpenGeniSiteDataErrorCode =
    detailCode && KNOWN_CODES.has(detailCode)
      ? detailCode
      : status === 404
        ? "not_found"
        : status === 403
          ? "forbidden"
          : status === 413
            ? "quota_exceeded"
            : status === 429
              ? "rate_limited"
              : "request_failed";
  const message =
    typeof record.message === "string" && record.message
      ? record.message
      : `Site Data request failed with HTTP ${status}`;
  return new OpenGeniSiteDataError(code, message, status, details);
}
