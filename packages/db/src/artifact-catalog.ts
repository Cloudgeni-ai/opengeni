import type { ArtifactCatalogKind, ArtifactCatalogListQuery } from "@opengeni/contracts";
import { sql, type SQL } from "drizzle-orm";
import { withRlsContext, type Database } from "./database";

export type ArtifactCatalogPosition = { key: string; kind: ArtifactCatalogKind; id: string };
/** Internal candidates are NOT an authorized public projection. */
export type ArtifactCatalogCandidate = {
  id: string;
  kind: ArtifactCatalogKind;
  /** Internal adapter identity; never exposed as public provenance. */
  origin: "site" | "editable_artifact" | "generated_image" | "sandbox_file";
  title: string;
  status: "active" | "archived";
  created_at: Date | string;
  updated_at: Date | string;
  source_session_id: string | null;
  version_id: string | null;
  sort_key: string;
};

/** Called only after immutable bytes have been retained by explicit publication. */
export async function recordSandboxFilePublication(
  db: Database,
  input: { accountId: string; workspaceId: string; fileId: string; sourceSessionId: string },
): Promise<void> {
  await withRlsContext(db, input, async (tx) => {
    await tx.execute(
      sql`select opengeni_private.record_sandbox_file_publication(${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.fileId}::uuid, ${input.sourceSessionId}::uuid)`,
    );
  });
}

/** Bounded keyset projection over existing domains; no universal content store.
 * The caller must still perform editable application and file access checks.
 */
export async function listArtifactCatalogCandidates(
  db: Database,
  scope: { accountId: string; workspaceId: string },
  input: {
    query: ArtifactCatalogListQuery;
    kinds: readonly ArtifactCatalogKind[];
    snapshotAt: string;
    after?: ArtifactCatalogPosition;
    limit: number;
  },
): Promise<ArtifactCatalogCandidate[]> {
  if (!input.kinds.length) return [];
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 201)
    throw new Error("Invalid catalog candidate limit");
  const { query } = input;
  const source = query.sourceSessionId;
  const branches: SQL[] = [];
  if (input.kinds.includes("site"))
    branches.push(sql`
    SELECT a.id::text, 'site'::text AS kind, a.title, a.status, a.created_at, a.updated_at,
      ${source ? sql`${source}::uuid` : sql`v.source_session_id`} AS source_session_id,
      a.current_version_id::text AS version_id, 'site'::text AS origin
    FROM workspace_artifacts a LEFT JOIN workspace_artifact_versions v
      ON v.workspace_id = a.workspace_id AND v.artifact_id = a.id AND v.id = a.current_version_id
    WHERE a.account_id = ${scope.accountId}::uuid AND a.workspace_id = ${scope.workspaceId}::uuid
      ${source ? sql`AND EXISTS (SELECT 1 FROM workspace_artifact_versions sv WHERE sv.workspace_id = a.workspace_id AND sv.artifact_id = a.id AND sv.source_session_id = ${source}::uuid)` : sql``}`);
  const editableKinds = input.kinds.filter((kind) =>
    ["document", "spreadsheet", "presentation"].includes(kind),
  );
  if (editableKinds.length)
    branches.push(sql`
    SELECT a.id, a.modality AS kind, a.title, a.lifecycle_state AS status, a.created_at, a.updated_at,
      ${source ? sql`${source}::uuid` : sql`NULL::uuid`} AS source_session_id, NULL::text AS version_id, 'editable_artifact'::text AS origin
    FROM editable_artifacts a WHERE a.account_id = ${scope.accountId}::uuid AND a.workspace_id = ${scope.workspaceId}::uuid
      AND a.modality IN (${sql.join(
        editableKinds.map((kind) => sql`${kind}`),
        sql`, `,
      )})
      ${source ? sql`AND EXISTS (SELECT 1 FROM editable_artifact_session_links l WHERE l.account_id = a.account_id AND l.workspace_id = a.workspace_id AND l.artifact_id = a.id AND l.session_id = ${source}::uuid)` : sql``}`);
  if (input.kinds.includes("image"))
    branches.push(sql`
    SELECT f.id::text, 'image'::text AS kind, f.filename AS title, 'active'::text AS status,
      g.created_at, g.updated_at, g.session_id AS source_session_id, NULL::text AS version_id, 'generated_image'::text AS origin
    FROM generated_image_artifacts g JOIN files f ON f.account_id = g.account_id AND f.workspace_id = g.workspace_id AND f.id = g.artifact_id
    WHERE g.account_id = ${scope.accountId}::uuid AND g.workspace_id = ${scope.workspaceId}::uuid AND g.status = 'ready' AND f.status = 'ready'
      ${source ? sql`AND g.session_id = ${source}::uuid` : sql``}`);
  const publishedKinds = input.kinds.filter((kind) => kind === "file" || kind === "image");
  if (publishedKinds.length)
    branches.push(sql`
    SELECT p.file_id::text AS id, p.kind, p.title, 'active'::text AS status,
      p.published_at AS created_at, p.published_at AS updated_at, p.source_session_id, NULL::text AS version_id, 'sandbox_file'::text AS origin
    FROM opengeni_private.list_sandbox_file_publications(${scope.accountId}::uuid, ${scope.workspaceId}::uuid,
      ${JSON.stringify({ sourceSessionId: source, q: query.q, kinds: publishedKinds, sort: query.sort, snapshotAt: input.snapshotAt, after: input.after, limit: input.limit })}::jsonb) p`);
  if (!branches.length) return [];
  const sort =
    query.sort === "title"
      ? sql`lower(title)`
      : query.sort === "newest"
        ? sql`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`
        : sql`to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
  const descending = query.sort !== "title";
  const position = input.after;
  const keyset = !position
    ? sql`true`
    : sql`(
    sort_key COLLATE "C" ${descending ? sql`<` : sql`>`} ${position.key} COLLATE "C"
    OR (sort_key = ${position.key} AND (kind COLLATE "C", id COLLATE "C") > (${position.kind}, ${position.id})))`;
  return withRlsContext(
    db,
    scope,
    async (tx) => {
      const result = await tx.execute(sql`
      WITH candidates AS (${sql.join(branches, sql` UNION ALL `)}),
      ordered AS (SELECT *, ${sort} AS sort_key FROM candidates
        WHERE status = ${query.status} AND created_at <= ${input.snapshotAt}::timestamptz
          ${query.q ? sql`AND strpos(lower(title), lower(${query.q})) > 0` : sql``})
      SELECT * FROM ordered WHERE ${keyset}
      ORDER BY sort_key COLLATE "C" ${descending ? sql`DESC` : sql`ASC`}, kind COLLATE "C", id COLLATE "C"
      LIMIT ${input.limit}`);
      return (
        Array.isArray(result) ? result : (result as { rows: ArtifactCatalogCandidate[] }).rows
      ) as ArtifactCatalogCandidate[];
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
