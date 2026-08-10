import { parseVerifiedAttemptToolCatalog } from "@opengeni/codemode";
import type { AttemptToolCatalog } from "@opengeni/contracts";
import { and, eq } from "drizzle-orm";
import type { Database } from "./database";
import { withRlsContext } from "./database";
import * as schema from "./schema";

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
            catalog,
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
        return parseVerifiedAttemptToolCatalog(stored.catalog);
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
    async (scopedDb) => {
      const stored = await attemptToolCatalogByAttemptTx(
        scopedDb,
        input.workspaceId,
        input.attemptId,
      );
      return stored ? parseVerifiedAttemptToolCatalog(stored.catalog) : null;
    },
  );
}

async function attemptToolCatalogByAttemptTx(
  tx: Pick<Database, "select">,
  workspaceId: string,
  attemptId: string,
) {
  const [row] = await tx
    .select({
      generation: schema.sessionAttemptToolCatalogs.generation,
      digest: schema.sessionAttemptToolCatalogs.digest,
      catalog: schema.sessionAttemptToolCatalogs.catalog,
    })
    .from(schema.sessionAttemptToolCatalogs)
    .where(
      and(
        eq(schema.sessionAttemptToolCatalogs.workspaceId, workspaceId),
        eq(schema.sessionAttemptToolCatalogs.attemptId, attemptId),
      ),
    )
    .limit(1);
  return row ?? null;
}
