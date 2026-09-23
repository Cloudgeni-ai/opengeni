import { expect, test } from "bun:test";
import { ArtifactCatalogListQuery } from "@opengeni/contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  listArtifactCatalogCandidates,
  recordSandboxFilePublication,
} from "../src/artifact-catalog";
import type { Database } from "../src/database";

const scope = {
  accountId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000002",
};
const sessionId = "30000000-0000-4000-8000-000000000003";
const snapshotAt = "2026-08-01T00:00:00.000Z";

function databaseFixture() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    execute: async (sql: SQL) => {
      const query = new PgDialect().sqlToQuery(sql);
      queries.push(query);
      if (query.sql.includes("current_setting('opengeni.account_id'"))
        return { rows: [{ account_id: scope.accountId, workspace_id: scope.workspaceId }] };
      return { rows: [] };
    },
  };
  return { db: db as unknown as Database, queries };
}

test("catalog query adapts only existing output domains and parameterizes literal title search", async () => {
  const { db, queries } = databaseFixture();
  const query = ArtifactCatalogListQuery.parse({
    q: "%_'; DROP TABLE files;--",
    sourceSessionId: sessionId,
    kind: "site",
    sort: "title",
  });
  expect(
    await listArtifactCatalogCandidates(db, scope, {
      query,
      kinds: ["site", "document", "image", "file"],
      snapshotAt,
      limit: 101,
    }),
  ).toEqual([]);
  const statement = queries.at(-1)!;
  for (const domain of [
    "workspace_artifacts",
    "editable_artifacts",
    "generated_image_artifacts",
    "list_sandbox_file_publications",
  ])
    expect(statement.sql).toContain(domain);
  for (const absent of [
    "session_events",
    "session_history_items",
    "retained_screenshot_artifacts",
    "file_uploads",
    "object_key",
    "bucket",
    "sandbox_path",
  ])
    expect(statement.sql).not.toContain(absent);
  expect(statement.sql).toContain("strpos(lower(title), lower(");
  expect(statement.sql).not.toContain("DROP TABLE");
  expect(statement.params).toContain(query.q);
  expect(statement.params).toContain(scope.accountId);
  expect(statement.params).toContain(scope.workspaceId);
  expect(statement.params).toContain(sessionId);
});

test("catalog keysets retain microseconds and stable domain/native-ID ties for every sort", async () => {
  for (const sort of ["title", "newest", "updated"] as const) {
    const { db, queries } = databaseFixture();
    const after = {
      key: sort === "title" ? "report" : "2026-08-01T00:00:00.000001",
      kind: "site" as const,
      id: "40000000-0000-4000-8000-000000000004",
    };
    await listArtifactCatalogCandidates(db, scope, {
      query: ArtifactCatalogListQuery.parse({ sort }),
      kinds: ["site"],
      snapshotAt,
      after,
      limit: 100,
    });
    const statement = queries.at(-1)!;
    expect(statement.params).toContain(after.key);
    expect(statement.params).toContain(after.id);
    expect(statement.sql).toContain('kind COLLATE "C", id COLLATE "C"');
    expect(statement.sql).toContain(sort === "title" ? "ASC" : "DESC");
    if (sort !== "title") expect(statement.sql).toContain("HH24:MI:SS.US");
  }
});

test("Images filter includes explicit sandbox publications with origin independent from public kind", async () => {
  const { db, queries } = databaseFixture();
  await listArtifactCatalogCandidates(db, scope, {
    query: ArtifactCatalogListQuery.parse({ kind: "image" }),
    kinds: ["image"],
    snapshotAt,
    limit: 100,
  });
  const statement = queries.at(-1)!;
  expect(statement.sql).toContain("generated_image_artifacts");
  expect(statement.sql).toContain("list_sandbox_file_publications");
  expect(statement.sql).toContain("'sandbox_file'::text AS origin");
  expect(statement.sql).toContain("'generated_image'::text AS origin");
  const input = statement.params.find(
    (param) => typeof param === "string" && param.startsWith("{"),
  );
  expect(JSON.parse(input as string).kinds).toEqual(["image"]);
});

test("empty authority does not query and publication records only via the scoped capability", async () => {
  const { db, queries } = databaseFixture();
  expect(
    await listArtifactCatalogCandidates(db, scope, {
      query: ArtifactCatalogListQuery.parse({}),
      kinds: [],
      snapshotAt,
      limit: 1,
    }),
  ).toEqual([]);
  expect(queries).toHaveLength(0);
  await recordSandboxFilePublication(db, {
    ...scope,
    fileId: "40000000-0000-4000-8000-000000000004",
    sourceSessionId: sessionId,
  });
  expect(queries.at(-1)!.sql).toContain("select opengeni_private.record_sandbox_file_publication(");
  expect(queries.every(({ sql }) => !/\b(insert|update|delete)\b/i.test(sql))).toBe(true);
});
