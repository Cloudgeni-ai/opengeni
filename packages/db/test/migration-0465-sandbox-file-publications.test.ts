import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { createDb, withSessionRlsActorContext } from "../src/database";
import {
  listArtifactCatalogCandidates,
  recordSandboxFilePublication,
} from "../src/artifact-catalog";
import { createSession } from "../src";
import { ArtifactCatalogListQuery } from "@opengeni/contracts";

const migration = new URL("../drizzle/0465_sandbox_file_publications.sql", import.meta.url);

test("publication schema is a rolling, private, immutable receipt relation with exact file authority", async () => {
  const source = await readFile(migration, "utf8");
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source).toContain("CREATE TABLE opengeni_private.sandbox_file_publications");
  expect(source).toContain("PRIMARY KEY (account_id, workspace_id, file_id)");
  expect(source).toContain("REFERENCES files(account_id, workspace_id, id) ON DELETE CASCADE");
  expect(source).toContain("ON DELETE SET NULL (source_session_id)");
  expect(source).toContain("FORCE ROW LEVEL SECURITY");
  expect(source).toContain("opengeni_private.workspace_rls_visible(account_id, workspace_id)");
  expect(source).toContain("CREATE POLICY visible_file");
  expect(source).toContain("ON CONFLICT DO NOTHING");
  expect(source).toContain("v_limit NOT BETWEEN 1 AND 201");
  expect(source).toContain("p_account IS DISTINCT FROM opengeni_private.current_account_id()");
  expect(source).toContain("p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()");
  expect(source).toContain("private_owner_subject_ids");
  expect(source).not.toContain("SET search_path FROM CURRENT");
  expect(
    source.match(
      /ALTER FUNCTION opengeni_private\.(?:record_sandbox_file_publication|list_sandbox_file_publications)\([^)]*\) SET search_path = pg_catalog, %I, pg_temp/g,
    ),
  ).toHaveLength(2);
  for (const mime of [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/svg+xml",
  ])
    expect(source).toContain(`'${mime}'`);
  expect(source).toContain('(c.kind COLLATE "C",c.file_id::text COLLATE "C")');
  expect(source).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE)\b/);
  expect(source).not.toMatch(
    /session_events|session_history_items|object_key|sandbox_path|UPDATE files/,
  );
});

// This is intentionally reported as skipped when the real PostgreSQL fixture
// cannot be started; the SQL/static tests above are not a substitute for it.
const postgresTest =
  process.env.CI || process.env.OPENGENI_REQUIRE_REAL_DB === "1" || Bun.which("docker")
    ? test
    : test.skip;
postgresTest(
  "owner migration enforces publication dedup, private files, tenant scope and native revisions",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("catalog-publications");
    if (!owned) throw new Error("PostgreSQL publication verification requires the Docker fixture");
    let client: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(owned.ownerUrl);
      // Role administration is not migration-owner authority. Keep the owner
      // restricted and preserve the harness's shared application password.
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      client = createDb(appUrl.toString());
      const scope = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
      await owned.admin`INSERT INTO managed_accounts(id,name) VALUES(${scope.accountId},'Catalog')`;
      await owned.admin`INSERT INTO workspaces(id,account_id,name,settings) VALUES(${scope.workspaceId},${scope.accountId},'Catalog','{}')`;
      await owned.admin`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${scope.workspaceId},${scope.accountId})`;
      const session = await createSession(client.db, {
        ...scope,
        initialMessage: "Catalog origin",
        model: "test-model",
        resources: [],
        metadata: {},
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: "user:catalog" },
        createdByContext: {},
      });
      const inputId = crypto.randomUUID(),
        firstId = crypto.randomUUID(),
        revisedId = crypto.randomUUID(),
        privateId = crypto.randomUUID();
      for (const id of [inputId, firstId, revisedId, privateId]) {
        await owned.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,sha256,bucket,object_key,private_owner_subject_ids)
        VALUES(${id},${scope.accountId},${scope.workspaceId},'ready','report.pdf','report.pdf','application/pdf',10,${"a".repeat(64)},'fixture',${id},${id === privateId ? ["user:catalog"] : null})`;
      }
      const publish = (fileId: string) =>
        recordSandboxFilePublication(client!.db, { ...scope, fileId, sourceSessionId: session.id });
      await publish(firstId);
      await publish(firstId);
      await publish(revisedId);
      await expect(publish(privateId)).rejects.toThrow();
      await withSessionRlsActorContext(
        { subjectId: "user:catalog", privateFileOwnerSubjectId: "user:catalog" },
        () => publish(privateId),
      );
      const query = () =>
        listArtifactCatalogCandidates(client!.db, scope, {
          query: ArtifactCatalogListQuery.parse({ sort: "title" }),
          kinds: ["file"],
          snapshotAt: new Date(Date.now() + 1000).toISOString(),
          limit: 100,
        });
      expect((await query()).map((row) => row.id).sort()).toEqual([firstId, revisedId].sort());
      expect(
        (
          await withSessionRlsActorContext(
            { subjectId: "user:catalog", privateFileOwnerSubjectId: "user:catalog" },
            query,
          )
        )
          .map((row) => row.id)
          .sort(),
      ).toEqual([firstId, revisedId, privateId].sort());
      const rows =
        await owned.admin`SELECT file_id FROM opengeni_private.sandbox_file_publications`;
      expect(rows).toHaveLength(3);
      expect(rows.some((row) => row.file_id === inputId)).toBe(false);
      const privileges =
        await owned.admin`SELECT has_table_privilege('opengeni_app','opengeni_private.sandbox_file_publications','SELECT') AS read, has_table_privilege('opengeni_app','opengeni_private.sandbox_file_publications','INSERT') AS write`;
      expect(privileges[0]).toMatchObject({ read: false, write: false });
      const raw = postgres(appUrl.toString(), { max: 1 });
      try {
        await expect(
          raw`SELECT opengeni_private.record_sandbox_file_publication(${scope.accountId},${scope.workspaceId},${firstId},${session.id})`,
        ).rejects.toThrow();
        const configs =
          await owned.admin`SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='opengeni_private' AND p.proname IN ('record_sandbox_file_publication','list_sandbox_file_publications')`;
        expect(configs).toHaveLength(2);
        for (const config of configs)
          expect(config.proconfig).toContain("search_path=pg_catalog, public, pg_temp");
        await raw.begin(async (tx) => {
          await tx`SELECT set_config('opengeni.account_id',${scope.accountId},true),set_config('opengeni.workspace_id',${scope.workspaceId},true),set_config('opengeni.subject_id','user:catalog',true)`;
          // An unfenced SECURITY DEFINER would resolve these attacker-owned
          // temp views and execute their helper under migration-owner authority.
          await tx`CREATE FUNCTION pg_temp.publication_shadow_probe() RETURNS boolean LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'publication-temp-shadow-executed'; END$$`;
          await tx`CREATE TEMP VIEW files AS SELECT f.* FROM public.files f WHERE pg_temp.publication_shadow_probe()`;
          await tx`CREATE TEMP VIEW sessions AS SELECT s.* FROM public.sessions s WHERE pg_temp.publication_shadow_probe()`;
          await tx`SET LOCAL search_path = pg_temp, public`;
          await tx`SELECT opengeni_private.record_sandbox_file_publication(${scope.accountId},${scope.workspaceId},${firstId},${session.id})`;
          const page =
            await tx`SELECT * FROM opengeni_private.list_sandbox_file_publications(${scope.accountId},${scope.workspaceId},${tx.json({ sort: "title", kinds: ["file"], snapshotAt: new Date(Date.now() + 1000).toISOString(), limit: 100 })}::jsonb)`;
          expect(page.map((row) => row.file_id).sort()).toEqual([firstId, revisedId].sort());
        });
      } finally {
        await raw.end();
      }
    } finally {
      await client?.close();
      await owned.release();
    }
  },
  180_000,
);
