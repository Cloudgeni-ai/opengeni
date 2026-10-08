import { createHash } from "node:crypto";
import type { AttemptToolCatalog, ModelContextSnapshot } from "@opengeni/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "./database";
import * as schema from "./schema";

/**
 * Session-scoped content-addressed storage for large, highly repetitive JSON.
 *
 * Long sessions record a tool catalog and a model-request snapshot for every
 * attempt. Consecutive attempts repeat nearly all of that content, so storing
 * each copy inline makes those two tables the largest in the database. Writers
 * now externalize the repetitive parts into `session_content_blobs`, keyed by
 * the SHA-256 of their canonical JSON, and keep only digests in the owning row.
 * Readers hydrate both the encoded and the legacy inline form, so the stored
 * representation is an implementation detail: hydrated values are exactly the
 * values that were written.
 *
 * Blobs are owned by one session (never shared across sessions or workspaces),
 * so their lifecycle is the session's: they cascade with it and move with it
 * into a session archive.
 */

export const SESSION_CONTENT_REFS_VERSION = 1 as const;

export type AttemptToolCatalogContentRefs = {
  v: typeof SESSION_CONTENT_REFS_VERSION;
  entries: string[];
};

export type ModelContextSnapshotContentRefs = {
  v: typeof SESSION_CONTENT_REFS_VERSION;
  instructions: string;
  layers: string;
  tools: string;
  skills: string;
  /** Content-defined chunks of `providerRequest.body`; null when inline or absent. */
  body: string[] | null;
};

export type SessionContentScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
};

export class SessionContentBlobMissingError extends Error {
  readonly code = "session_content_blob_missing";

  constructor(readonly digest: string) {
    super("A session content blob referenced by a stored row is missing");
    this.name = "SessionContentBlobMissingError";
  }
}

/** Sort object keys recursively; arrays keep their order. Matches jsonb equality. */
export function canonicalJsonForContentDigest(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Content value is not JSON");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonForContentDigest(item ?? null)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonForContentDigest(item)}`)
    .join(",")}}`;
}

export function digestContentValue(value: unknown): string {
  return createHash("sha256").update(canonicalJsonForContentDigest(value), "utf8").digest("hex");
}

// Content-defined chunking over UTF-16 code units (gear rolling hash). Chunk
// boundaries depend only on nearby content, so a string that grows or changes
// near its end keeps the same leading chunks. The table and parameters affect
// only deduplication efficiency, never correctness: hydration concatenates.
const CHUNK_MIN_UNITS = 2_048;
const CHUNK_MAX_UNITS = 65_536;
const CHUNK_BOUNDARY_MASK = 0x1fff; // ~8 Ki code units on average past the minimum.
const GEAR = (() => {
  const table = new Uint32Array(256);
  let state = 0x9e3779b9;
  for (let index = 0; index < table.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    table[index] = state >>> 0;
  }
  return table;
})();

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Split text into content-defined chunks; never splits a surrogate pair. */
export function chunkTextByContent(text: string): string[] {
  if (text.length <= CHUNK_MIN_UNITS) return [text];
  const chunks: string[] = [];
  let start = 0;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    hash = ((hash << 1) + GEAR[(code ^ (code >>> 8)) & 0xff]!) >>> 0;
    const length = index + 1 - start;
    if (
      ((length >= CHUNK_MIN_UNITS && (hash & CHUNK_BOUNDARY_MASK) === 0) ||
        length >= CHUNK_MAX_UNITS) &&
      !isHighSurrogate(code)
    ) {
      chunks.push(text.slice(start, index + 1));
      start = index + 1;
      hash = 0;
    }
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

type EncodedValue<Stored, Refs> = {
  stored: Stored;
  refs: Refs;
  blobs: Map<string, unknown>;
};

function addBlob(blobs: Map<string, unknown>, value: unknown): string {
  const digest = digestContentValue(value);
  if (!blobs.has(digest)) blobs.set(digest, value);
  return digest;
}

/** Externalize every catalog entry; the stored catalog keeps all identity fields. */
export function encodeAttemptToolCatalogContent(
  catalog: AttemptToolCatalog,
): EncodedValue<AttemptToolCatalog, AttemptToolCatalogContentRefs> {
  const blobs = new Map<string, unknown>();
  const entries = catalog.entries.map((entry) => addBlob(blobs, entry));
  return {
    stored: { ...catalog, entries: [] },
    refs: { v: SESSION_CONTENT_REFS_VERSION, entries },
    blobs,
  };
}

/** Externalize the repeated instruction/tool/skill prefix and the raw request body. */
export function encodeModelContextSnapshotContent(
  snapshot: ModelContextSnapshot,
): EncodedValue<ModelContextSnapshot, ModelContextSnapshotContentRefs> {
  const blobs = new Map<string, unknown>();
  const body = snapshot.providerRequest?.body;
  const refs: ModelContextSnapshotContentRefs = {
    v: SESSION_CONTENT_REFS_VERSION,
    instructions: addBlob(blobs, snapshot.instructions),
    layers: addBlob(blobs, snapshot.layers),
    tools: addBlob(blobs, snapshot.tools),
    skills: addBlob(blobs, snapshot.skills),
    body:
      typeof body === "string"
        ? chunkTextByContent(body).map((chunk) => addBlob(blobs, chunk))
        : null,
  };
  const stored: ModelContextSnapshot = {
    ...snapshot,
    instructions: "",
    layers: [],
    tools: [],
    skills: [],
    ...(snapshot.providerRequest && refs.body !== null
      ? { providerRequest: { ...snapshot.providerRequest, body: null } }
      : {}),
  };
  return { stored, refs, blobs };
}

type BlobReader = Pick<Database, "select">;
type BlobWriter = Pick<Database, "select" | "insert">;
const BLOB_STATEMENT_BATCH = 500;

/** Insert the values this session does not already hold. Idempotent and race-safe. */
export async function writeSessionContentBlobs(
  tx: BlobWriter,
  scope: SessionContentScope,
  blobs: ReadonlyMap<string, unknown>,
): Promise<number> {
  const digests = [...blobs.keys()];
  let inserted = 0;
  for (let offset = 0; offset < digests.length; offset += BLOB_STATEMENT_BATCH) {
    const batch = digests.slice(offset, offset + BLOB_STATEMENT_BATCH);
    const present = await tx
      .select({ digest: schema.sessionContentBlobs.digest })
      .from(schema.sessionContentBlobs)
      .where(
        and(
          eq(schema.sessionContentBlobs.workspaceId, scope.workspaceId),
          eq(schema.sessionContentBlobs.sessionId, scope.sessionId),
          inArray(schema.sessionContentBlobs.digest, batch),
        ),
      );
    const known = new Set(present.map((row) => row.digest));
    const missing = batch.filter((digest) => !known.has(digest));
    if (missing.length === 0) continue;
    await tx
      .insert(schema.sessionContentBlobs)
      .values(
        missing.map((digest) => ({
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          digest,
          value: blobs.get(digest),
        })),
      )
      .onConflictDoNothing();
    inserted += missing.length;
  }
  return inserted;
}

/** Load exact referenced values; a missing blob is corruption, never an empty value. */
export async function readSessionContentBlobs(
  tx: BlobReader,
  scope: Pick<SessionContentScope, "workspaceId" | "sessionId">,
  digests: readonly string[],
): Promise<Map<string, unknown>> {
  const unique = [...new Set(digests)];
  const values = new Map<string, unknown>();
  for (let offset = 0; offset < unique.length; offset += BLOB_STATEMENT_BATCH) {
    const batch = unique.slice(offset, offset + BLOB_STATEMENT_BATCH);
    const rows = await tx
      .select({
        digest: schema.sessionContentBlobs.digest,
        value: schema.sessionContentBlobs.value,
      })
      .from(schema.sessionContentBlobs)
      .where(
        and(
          eq(schema.sessionContentBlobs.workspaceId, scope.workspaceId),
          eq(schema.sessionContentBlobs.sessionId, scope.sessionId),
          inArray(schema.sessionContentBlobs.digest, batch),
        ),
      );
    for (const row of rows) values.set(row.digest, row.value);
  }
  for (const digest of unique) {
    if (!values.has(digest)) throw new SessionContentBlobMissingError(digest);
  }
  return values;
}

function isCatalogRefs(value: unknown): value is AttemptToolCatalogContentRefs {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { v?: unknown }).v === SESSION_CONTENT_REFS_VERSION &&
    Array.isArray((value as { entries?: unknown }).entries)
  );
}

function isSnapshotRefs(value: unknown): value is ModelContextSnapshotContentRefs {
  const refs = value as Partial<ModelContextSnapshotContentRefs> | null;
  return (
    !!refs &&
    typeof refs === "object" &&
    refs.v === SESSION_CONTENT_REFS_VERSION &&
    typeof refs.instructions === "string" &&
    typeof refs.layers === "string" &&
    typeof refs.tools === "string" &&
    typeof refs.skills === "string" &&
    (refs.body === null || Array.isArray(refs.body))
  );
}

/** Return the exact catalog that was written, from either stored form. Unverified. */
export async function hydrateStoredAttemptToolCatalog(
  tx: BlobReader,
  row: { catalog: unknown; contentRefs: unknown },
): Promise<unknown> {
  if (row.contentRefs === null || row.contentRefs === undefined) return row.catalog;
  if (!isCatalogRefs(row.contentRefs)) throw new TypeError("Invalid tool catalog content refs");
  const catalog = row.catalog as { workspaceId?: unknown; sessionId?: unknown };
  if (typeof catalog.workspaceId !== "string" || typeof catalog.sessionId !== "string") {
    throw new TypeError("Stored tool catalog is missing its session identity");
  }
  const values = await readSessionContentBlobs(
    tx,
    { workspaceId: catalog.workspaceId, sessionId: catalog.sessionId },
    row.contentRefs.entries,
  );
  return {
    ...(row.catalog as Record<string, unknown>),
    entries: row.contentRefs.entries.map((digest) => values.get(digest)),
  };
}

/** Return the exact snapshot that was written, from either stored form. Unverified. */
export async function hydrateStoredModelContextSnapshot(
  tx: BlobReader,
  scope: Pick<SessionContentScope, "workspaceId" | "sessionId">,
  row: { snapshot: unknown; contentRefs: unknown },
): Promise<unknown> {
  if (row.contentRefs === null || row.contentRefs === undefined) return row.snapshot;
  if (!isSnapshotRefs(row.contentRefs)) throw new TypeError("Invalid snapshot content refs");
  const refs = row.contentRefs;
  const values = await readSessionContentBlobs(tx, scope, [
    refs.instructions,
    refs.layers,
    refs.tools,
    refs.skills,
    ...(refs.body ?? []),
  ]);
  const stored = row.snapshot as ModelContextSnapshot;
  return {
    ...stored,
    instructions: values.get(refs.instructions),
    layers: values.get(refs.layers),
    tools: values.get(refs.tools),
    skills: values.get(refs.skills),
    ...(stored.providerRequest && refs.body !== null
      ? {
          providerRequest: {
            ...stored.providerRequest,
            body: refs.body.map((digest) => values.get(digest) as string).join(""),
          },
        }
      : {}),
  };
}
