import { expect, test } from "bun:test";
import { ArtifactCatalogListQuery } from "@opengeni/contracts";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  createSession,
  listArtifactCatalogCandidates,
  nestedPostgresSqlState,
  recordSandboxFilePublication,
  updateArtifactPin,
  withRlsContext,
  withSessionRlsActorContext,
  type ArtifactCatalogCandidate,
  type ArtifactCatalogPosition,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  assertRuntimeDatabasePosture,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";
import { sql } from "drizzle-orm";

const postgresTest =
  process.env.CI ||
  process.env.OPENGENI_REQUIRE_REAL_DB === "1" ||
  process.env.OPENGENI_TEST_PG_URL ||
  process.env.OPENGENI_TEST_PG_NATIVE === "1" ||
  Bun.which("docker")
    ? test
    : test.skip;

postgresTest(
  "shared pins remain capability-only and globally ordered beyond both pagination limits under real FORCE-RLS",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("artifact-pins");
    if (!owned) throw new Error("Artifact pin verification requires PostgreSQL");
    let client: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      client = createDb(appUrl.toString());
      await assertRuntimeDatabasePosture(client.db, {
        rlsStrategy: "force",
        expectedRole: "opengeni_app",
        targetSchema: "public",
      });
      const postureOptions = {
        rlsStrategy: "force" as const,
        expectedRole: "opengeni_app",
        targetSchema: "public",
      };
      // Discover the server's complete table-privilege vocabulary so newer
      // privileges are covered without assuming one PostgreSQL version.
      const tablePrivileges = await owned.admin`
        SELECT DISTINCT acl.privilege_type AS privilege FROM pg_class c
          CROSS JOIN LATERAL aclexplode(acldefault('r', c.relowner)) acl
        WHERE c.oid='opengeni_private.artifact_catalog_pins'::regclass`;
      const privilegeFlags = {
        SELECT: "select",
        INSERT: "insert",
        UPDATE: "update",
        DELETE: "delete",
        TRUNCATE: "truncate",
        REFERENCES: "references",
        TRIGGER: "trigger",
      } as const;
      for (const { privilege } of tablePrivileges) {
        if (typeof privilege !== "string" || !/^[A-Z]+$/.test(privilege))
          throw new Error("Unexpected PostgreSQL privilege name");
        await owned.admin.unsafe(
          `GRANT ${privilege} ON TABLE opengeni_private.artifact_catalog_pins TO opengeni_app`,
        );
        try {
          const posture = await inspectRuntimeDatabasePosture(client.db, postureOptions);
          const pins = posture.privateTables.find(
            (table) => table.name === "artifact_catalog_pins",
          )!;
          const flag = privilegeFlags[privilege as keyof typeof privilegeFlags];
          expect(flag ? pins[flag] : pins.extraPrivileges?.includes(privilege)).toBe(true);
          expect(evaluateRuntimeDatabasePosture(posture, postureOptions)).toContain(
            "runtime role has forbidden direct artifact pin authority",
          );
        } finally {
          await owned.admin.unsafe(
            `REVOKE ${privilege} ON TABLE opengeni_private.artifact_catalog_pins FROM opengeni_app`,
          );
        }
      }
      for (const grantee of ["opengeni_app", "PUBLIC"] as const) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"] as const) {
          await owned.admin.unsafe(
            `GRANT ${privilege} (artifact_id) ON TABLE opengeni_private.artifact_catalog_pins TO ${grantee}`,
          );
          try {
            const posture = await inspectRuntimeDatabasePosture(client.db, postureOptions);
            const pins = posture.privateTables.find(
              (table) => table.name === "artifact_catalog_pins",
            )!;
            expect(pins[privilegeFlags[privilege]]).toBe(true);
            expect(evaluateRuntimeDatabasePosture(posture, postureOptions)).toContain(
              "runtime role has forbidden direct artifact pin authority",
            );
          } finally {
            await owned.admin.unsafe(
              `REVOKE ${privilege} (artifact_id) ON TABLE opengeni_private.artifact_catalog_pins FROM ${grantee}`,
            );
          }
        }
      }
      // Reprovisioning must repair both table and persistent column grants,
      // including effective authority inherited from PUBLIC.
      await owned.admin`GRANT ALL ON TABLE opengeni_private.artifact_catalog_pins TO opengeni_app, PUBLIC`;
      await owned.admin`GRANT SELECT (artifact_id), INSERT (artifact_id), UPDATE (artifact_id), REFERENCES (artifact_id)
        ON TABLE opengeni_private.artifact_catalog_pins TO opengeni_app, PUBLIC`;
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const repaired = await assertRuntimeDatabasePosture(client.db, postureOptions);
      expect(
        repaired.privateTables.find((table) => table.name === "artifact_catalog_pins"),
      ).toMatchObject({
        select: false,
        insert: false,
        update: false,
        delete: false,
        truncate: false,
        references: false,
        trigger: false,
      });
      const columnAcl = await owned.admin`SELECT count(*)::int AS count FROM pg_attribute a
        CROSS JOIN LATERAL aclexplode(a.attacl) acl
        WHERE a.attrelid='opengeni_private.artifact_catalog_pins'::regclass AND a.attnum>0 AND NOT a.attisdropped
          AND acl.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname='opengeni_app'))`;
      expect(columnAcl[0]!.count).toBe(0);
      const scope = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
      const foreignWorkspaceId = crypto.randomUUID();
      const owner = `user:${crypto.randomUUID()}`,
        viewer = `user:${crypto.randomUUID()}`;
      await owned.admin.begin(async (tx) => {
        await tx`INSERT INTO managed_accounts(id,name) VALUES(${scope.accountId},'Pin tests')`;
        await tx`INSERT INTO workspaces(id,account_id,name,settings) VALUES(${scope.workspaceId},${scope.accountId},'Pins','{}'),(${foreignWorkspaceId},${scope.accountId},'Foreign','{}')`;
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`INSERT INTO workspace_memberships(account_id,workspace_id,subject_id,role,permissions)
        VALUES(${scope.accountId},${scope.workspaceId},${owner},'member','["files:read","artifacts:read","artifacts:publish"]'),
          (${scope.accountId},${scope.workspaceId},${viewer},'member','["files:read","artifacts:read","artifacts:publish"]')`;
        await tx`SET LOCAL session_replication_role = origin`;
        await tx`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${scope.workspaceId},${scope.accountId}),(${foreignWorkspaceId},${scope.accountId})`;
      });
      const source = await createSession(client.db, {
        ...scope,
        initialMessage: "Pins",
        model: "test-model",
        resources: [],
        metadata: {},
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: owner },
        createdByContext: {},
      });
      const sharedId = crypto.randomUUID(),
        foreignSite = crypto.randomUUID(),
        privateFile = crypto.randomUUID();
      const files = Array.from({ length: 205 }, (_, i) => ({
        id: i === 204 ? sharedId : crypto.randomUUID(),
        account_id: scope.accountId,
        workspace_id: scope.workspaceId,
        status: "ready",
        filename: i === 204 ? "Z-pinned-file" : `A-${String(i).padStart(3, "0")}`,
        safe_filename: "fixture.txt",
        content_type: "text/plain",
        size_bytes: 10,
        sha256: "a".repeat(64),
        bucket: "fixture",
        object_key: `pin-file-${i}`,
      }));
      const imageId = crypto.randomUUID();
      await owned.admin.begin(async (tx) => {
        await tx`INSERT INTO files ${tx(files, "id", "account_id", "workspace_id", "status", "filename", "safe_filename", "content_type", "size_bytes", "sha256", "bucket", "object_key")}`;
        await tx`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,sha256,bucket,object_key,private_owner_subject_ids)
        VALUES(${privateFile},${scope.accountId},${scope.workspaceId},'ready','Private','private.txt','text/plain',10,${"b".repeat(64)},'fixture','private-pin',${[owner]}),
          (${imageId},${scope.accountId},${scope.workspaceId},'ready','Image','image.png','image/png',10,${"c".repeat(64)},'fixture','image-pin',NULL)`;
        await tx`INSERT INTO workspace_artifacts(id,account_id,workspace_id,slug,title,created_by_subject_id,created_at,updated_at)
        VALUES(${sharedId},${scope.accountId},${scope.workspaceId},'same-native-id','Z-pinned-site',${owner},'2020-01-01','2020-01-01'),
          (${foreignSite},${scope.accountId},${foreignWorkspaceId},'foreign','Foreign',${owner},'2020-01-01','2020-01-01')`;
        // Discovery-only fixture, matching the catalog provenance test: the
        // administrator seeds native metadata without genesis snapshots and
        // receipts. Runtime pin calls below retain the real FORCE-RLS posture.
        await tx`SET LOCAL session_replication_role = replica`;
        for (const [modality, artifactId, title] of [
          ["document", "1".repeat(32), "Document"],
          ["spreadsheet", "2".repeat(32), "Spreadsheet"],
          ["presentation", "3".repeat(32), "Presentation"],
        ] as const) {
          await tx`INSERT INTO editable_artifacts(account_id,workspace_id,id,modality,title,authorization_revision,causal_frontier,state_hash,created_by_subject_id)
            VALUES(${scope.accountId},${scope.workspaceId},${artifactId},${modality},${title},1,
              ${modality === "spreadsheet" ? tx.json([]) : null}::jsonb,${`sha256:${"a".repeat(64)}`},${owner})`;
        }
        await tx`SET LOCAL session_replication_role = origin`;
      });
      const ownerActor = { subjectId: owner, privateFileOwnerSubjectId: owner };
      const viewerActor = { subjectId: viewer, privateFileOwnerSubjectId: viewer };
      await withSessionRlsActorContext(ownerActor, async () => {
        for (const fileId of [...files.map(({ id }) => id), privateFile, imageId])
          await recordSandboxFilePublication(client!.db, {
            ...scope,
            fileId,
            sourceSessionId: source.id,
          });
        for (const [kind, artifactId] of [
          ["site", sharedId],
          ["file", sharedId],
          ["file", privateFile],
          ["image", imageId],
          ["document", "1".repeat(32)],
          ["spreadsheet", "2".repeat(32)],
          ["presentation", "3".repeat(32)],
        ] as const) {
          for (const pinned of [true, true, false, false, true])
            await updateArtifactPin(client!.db, scope, { kind, artifactId, pinned });
        }
        const pins =
          await owned.admin`SELECT kind,artifact_id FROM opengeni_private.artifact_catalog_pins WHERE workspace_id=${scope.workspaceId}`;
        expect(pins).toHaveLength(7);
        expect(
          pins
            .filter((pin) => pin.artifact_id === sharedId)
            .map((pin) => pin.kind)
            .sort(),
        ).toEqual(["file", "site"]);
        await updateArtifactPin(client!.db, scope, {
          kind: "site",
          artifactId: sharedId,
          pinned: false,
        });
        expect(
          (
            await owned.admin`SELECT kind FROM opengeni_private.artifact_catalog_pins WHERE workspace_id=${scope.workspaceId} AND artifact_id=${sharedId}`
          ).map((pin) => pin.kind),
        ).toEqual(["file"]);
        await updateArtifactPin(client!.db, scope, {
          kind: "site",
          artifactId: sharedId,
          pinned: true,
        });
        for (const target of [
          { kind: "site" as const, artifactId: crypto.randomUUID() },
          { kind: "site" as const, artifactId: foreignSite },
          { kind: "file" as const, artifactId: imageId },
          { kind: "image" as const, artifactId: sharedId },
          { kind: "spreadsheet" as const, artifactId: "1".repeat(32) },
        ]) {
          for (const pinned of [true, false]) {
            let denied: unknown;
            try {
              await updateArtifactPin(client!.db, scope, { ...target, pinned });
            } catch (error) {
              denied = error;
            }
            expect(nestedPostgresSqlState(denied)).toBe("42501");
          }
        }
        await expect(
          withRlsContext(client!.db, scope, (tx) =>
            tx.execute(sql`SELECT * FROM opengeni_private.artifact_catalog_pins`),
          ),
        ).rejects.toThrow();
        let mismatch: unknown;
        try {
          await withRlsContext(client!.db, scope, (tx) =>
            tx.execute(
              sql`SELECT opengeni_private.update_artifact_pin(${scope.accountId}::uuid,${foreignWorkspaceId}::uuid,'site',${foreignSite},true)`,
            ),
          );
        } catch (error) {
          mismatch = error;
        }
        expect(nestedPostgresSqlState(mismatch)).toBe("42501");
      });
      await withSessionRlsActorContext(viewerActor, async () => {
        for (const pinned of [true, false]) {
          let denied: unknown;
          try {
            await updateArtifactPin(client!.db, scope, {
              kind: "file",
              artifactId: privateFile,
              pinned,
            });
          } catch (error) {
            denied = error;
          }
          expect(nestedPostgresSqlState(denied)).toBe("42501");
        }
        const snapshotAt = new Date().toISOString();
        const traverse = async (sort: "title" | "updated" | "newest") => {
          const all: ArtifactCatalogCandidate[] = [];
          let after: ArtifactCatalogPosition | undefined;
          for (;;) {
            const page = await listArtifactCatalogCandidates(client!.db, scope, {
              query: ArtifactCatalogListQuery.parse({ sort }),
              kinds: ["file", "site", "image", "document", "spreadsheet", "presentation"],
              snapshotAt,
              ...(after ? { after } : {}),
              limit: 50,
            });
            all.push(...page);
            if (page.length < 50) break;
            const tail = page.at(-1)!;
            after = { key: tail.sort_key, kind: tail.kind, id: tail.id, pinned: tail.pinned };
            if (all.length > 220) throw new Error("Catalog keyset did not converge");
          }
          return all;
        };
        for (const sort of ["title", "updated", "newest"] as const) {
          const all = await traverse(sort);
          expect(all).toHaveLength(210);
          expect(new Set(all.map((row) => `${row.kind}:${row.id}`)).size).toBe(210);
          expect(all.slice(0, 6).every((row) => row.pinned)).toBe(true);
          expect(all.slice(6).every((row) => row.pinned === false)).toBe(true);
          expect(all.some(({ id }) => id === privateFile)).toBe(false);
          expect(
            all
              .slice(0, 6)
              .filter(({ id }) => id === sharedId)
              .map(({ kind }) => kind)
              .sort(),
          ).toEqual(["file", "site"]);
        }
        // Published branch LIMIT must not hide an old pin behind 204 unpinned files.
        const first = await listArtifactCatalogCandidates(client!.db, scope, {
          query: ArtifactCatalogListQuery.parse({ sort: "title" }),
          kinds: ["file"],
          snapshotAt,
          limit: 1,
        });
        expect(first[0]).toMatchObject({ id: sharedId, kind: "file", pinned: true });
        const next = await listArtifactCatalogCandidates(client!.db, scope, {
          query: ArtifactCatalogListQuery.parse({ sort: "title" }),
          kinds: ["file"],
          snapshotAt,
          after: { key: first[0]!.sort_key, kind: "file", id: sharedId, pinned: true },
          limit: 1,
        });
        expect(next[0]).toMatchObject({ title: "A-000", kind: "file", pinned: false });
        const sourceFiltered = await listArtifactCatalogCandidates(client!.db, scope, {
          query: ArtifactCatalogListQuery.parse({
            kind: "file",
            q: "A-",
            sourceSessionId: source.id,
          }),
          kinds: ["file"],
          snapshotAt,
          limit: 100,
        });
        expect(
          sourceFiltered.every((row) => row.pinned === false && row.title.startsWith("A-")),
        ).toBe(true);
        expect(sourceFiltered).toHaveLength(100);
      });
    } finally {
      await client?.close();
      await owned.release();
    }
  },
  180_000,
);
