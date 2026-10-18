import { parseVerifiedAttemptToolCatalog, verifyAttemptToolCatalog } from "@opengeni/codemode";
import type { AttemptToolCatalog } from "@opengeni/contracts";
import { and, eq } from "drizzle-orm";
import type { Database } from "./database";
import { withRlsContext } from "./database";
import * as schema from "./schema";
import {
  encodeAttemptToolCatalogContent,
  hydrateStoredAttemptToolCatalog,
  writeSessionContentBlobs,
} from "./session-content-blobs";

export class AttemptToolCatalogAuthorityError extends Error {
  readonly code = "attempt_tool_catalog_authority_mismatch";

  constructor() {
    super("Attempt tool catalog does not match the exact durable execution attempt");
    this.name = "AttemptToolCatalogAuthorityError";
  }
}

export class AttemptToolCatalogConflictError extends Error {
  readonly code = "attempt_tool_catalog_conflict";

  constructor() {
    super("Execution attempt already has a different immutable tool catalog");
    this.name = "AttemptToolCatalogConflictError";
  }
}

export async function persistAttemptToolCatalog(
  db: Database,
  input: AttemptToolCatalog,
): Promise<AttemptToolCatalog> {
  const catalog = parseVerifiedAttemptToolCatalog(input);
  return await withRlsContext(
    db,
    { accountId: catalog.accountId, workspaceId: catalog.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [attempt] = await tx
          .select({
            accountId: schema.sessionTurnAttempts.accountId,
            workspaceId: schema.sessionTurnAttempts.workspaceId,
            sessionId: schema.sessionTurnAttempts.sessionId,
            turnId: schema.sessionTurnAttempts.turnId,
            executionGeneration: schema.sessionTurnAttempts.executionGeneration,
          })
          .from(schema.sessionTurnAttempts)
          .where(
            and(
              eq(schema.sessionTurnAttempts.workspaceId, catalog.workspaceId),
              eq(schema.sessionTurnAttempts.id, catalog.attemptId),
            ),
          )
          .limit(1);
        if (
          !attempt ||
          attempt.accountId !== catalog.accountId ||
          attempt.sessionId !== catalog.sessionId ||
          attempt.turnId !== catalog.turnId ||
          attempt.executionGeneration !== catalog.executionGeneration
        ) {
          throw new AttemptToolCatalogAuthorityError();
        }

        const encoded = encodeAttemptToolCatalogContent(catalog);
        await writeSessionContentBlobs(
          tx,
          {
            accountId: catalog.accountId,
            workspaceId: catalog.workspaceId,
            sessionId: catalog.sessionId,
          },
          encoded.blobs,
        );
        await tx
          .insert(schema.sessionAttemptToolCatalogs)
          .values({
            attemptId: catalog.attemptId,
            accountId: catalog.accountId,
            workspaceId: catalog.workspaceId,
            sessionId: catalog.sessionId,
            turnId: catalog.turnId,
            executionGeneration: catalog.executionGeneration,
            catalogVersion: catalog.version,
            generation: catalog.generation,
            digest: catalog.digest,
            catalog: encoded.stored,
            contentRefs: encoded.refs,
            createdAt: new Date(catalog.createdAt),
          })
          .onConflictDoNothing({ target: schema.sessionAttemptToolCatalogs.attemptId });

        const stored = await attemptToolCatalogByAttemptTx(
          tx,
          catalog.workspaceId,
          catalog.attemptId,
        );
        if (!stored) throw new Error("Failed to persist attempt tool catalog");
        if (stored.digest !== catalog.digest || stored.generation !== catalog.generation) {
          throw new AttemptToolCatalogConflictError();
        }
        return parseVerifiedAttemptToolCatalog(await hydrateStoredAttemptToolCatalog(tx, stored));
      }),
  );
}

export async function getAttemptToolCatalog(
  db: Database,
  input: { accountId: string; workspaceId: string; attemptId: string },
): Promise<AttemptToolCatalog | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await loadVerifiedAttemptToolCatalogTx(scopedDb, input),
  );
}

/**
 * A stored attempt catalog is immutable: its row is insert-only and its digest
 * covers every field, so (workspace, attempt, digest) names one exact catalog.
 * Loading it reads every entry's content blob (hundreds of entries, megabytes
 * of JSON) and re-verifies the digest, which each Codemode call and capability
 * projection used to pay on the API event loop. Verified catalogs are kept
 * frozen per process, least recently used first out, bounded by serialized
 * size. A hit still reads the row's digest under the caller's RLS scope, so a
 * missing, invisible or different row is never served from memory.
 */
const VERIFIED_CATALOG_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const verifiedCatalogs = new Map<string, { catalog: AttemptToolCatalog; byteLength: number }>();
let verifiedCatalogBytes = 0;

/**
 * Reads the verified catalog of one attempt, optionally only when it has the
 * exact digest. Same result as hydrating and verifying the stored row.
 */
export async function loadVerifiedAttemptToolCatalogTx(
  tx: Pick<Database, "select">,
  input: { workspaceId: string; attemptId: string; digest?: string },
): Promise<AttemptToolCatalog | null> {
  const [head] = await tx
    .select({ digest: schema.sessionAttemptToolCatalogs.digest })
    .from(schema.sessionAttemptToolCatalogs)
    .where(attemptCatalogFilter(input))
    .limit(1);
  if (!head) return null;
  const key = `${input.workspaceId}\u0000${input.attemptId}\u0000${head.digest}`;
  const cached = verifiedCatalogs.get(key);
  if (cached) {
    verifiedCatalogs.delete(key);
    verifiedCatalogs.set(key, cached);
    return cached.catalog;
  }
  const stored = await attemptToolCatalogByAttemptTx(tx, input.workspaceId, input.attemptId, {
    digest: head.digest,
  });
  if (!stored) return null;
  const { catalog, byteLength } = verifyAttemptToolCatalog(
    await hydrateStoredAttemptToolCatalog(tx, stored),
  );
  if (
    catalog.digest === head.digest &&
    catalog.workspaceId === input.workspaceId &&
    catalog.attemptId === input.attemptId &&
    byteLength <= VERIFIED_CATALOG_CACHE_MAX_BYTES
  ) {
    deepFreeze(catalog);
    verifiedCatalogs.set(key, { catalog, byteLength });
    verifiedCatalogBytes += byteLength;
    for (const [oldestKey, oldest] of verifiedCatalogs) {
      if (verifiedCatalogBytes <= VERIFIED_CATALOG_CACHE_MAX_BYTES) break;
      verifiedCatalogs.delete(oldestKey);
      verifiedCatalogBytes -= oldest.byteLength;
    }
  }
  return catalog;
}

function attemptCatalogFilter(input: { workspaceId: string; attemptId: string; digest?: string }) {
  return and(
    eq(schema.sessionAttemptToolCatalogs.workspaceId, input.workspaceId),
    eq(schema.sessionAttemptToolCatalogs.attemptId, input.attemptId),
    ...(input.digest === undefined
      ? []
      : [eq(schema.sessionAttemptToolCatalogs.digest, input.digest)]),
  );
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

async function attemptToolCatalogByAttemptTx(
  tx: Pick<Database, "select">,
  workspaceId: string,
  attemptId: string,
  options: { digest?: string } = {},
) {
  const [row] = await tx
    .select({
      generation: schema.sessionAttemptToolCatalogs.generation,
      digest: schema.sessionAttemptToolCatalogs.digest,
      catalog: schema.sessionAttemptToolCatalogs.catalog,
      contentRefs: schema.sessionAttemptToolCatalogs.contentRefs,
    })
    .from(schema.sessionAttemptToolCatalogs)
    .where(attemptCatalogFilter({ workspaceId, attemptId, ...options }))
    .limit(1);
  return row ?? null;
}
