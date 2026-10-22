import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { createDb, withSessionRlsActorContext } from "../src/database";
import { getFilesForSubject, isFilePrivateToAnother, updateFileVisibility } from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";
import { assertRuntimeDatabasePosture } from "../src/runtime-posture";

const migration = new URL("../drizzle/0854_file_visibility.sql", import.meta.url);

test("file visibility migration is rolling and keeps the trigger as the only ownership gate", async () => {
  const source = await readFile(migration, "utf8");
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source).toContain("ALTER TABLE files ADD COLUMN owner_subject_id text;");
  expect(source).toContain("CREATE OR REPLACE FUNCTION knowledge_file_owner_immutable()");
  expect(source).toContain(
    "REVOKE ALL ON FUNCTION opengeni_private.file_private_to_another(uuid,uuid,uuid) FROM PUBLIC;",
  );
  expect(source).toContain("p_account IS DISTINCT FROM opengeni_private.current_account_id()");
  expect(source).toContain("p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()");
  // The lookup answers only yes or no: it never returns a name or an owner.
  expect(source).toContain("RETURNS boolean");
  expect(source).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE)\b/);
  // Rolling on a large, hot table: no row rewrite and no full scan under its lock.
  expect(source).not.toContain("NO FORCE ROW LEVEL SECURITY");
  expect(source).not.toMatch(/^\s*UPDATE\s+files\b/imu);
  expect(source).toMatch(/files_owner_is_private_owner CHECK \([^;]+\) NOT VALID;/u);
});

const postgresTest =
  process.env.CI ||
  process.env.OPENGENI_REQUIRE_REAL_DB === "1" ||
  process.env.OPENGENI_TEST_PG_URL ||
  process.env.OPENGENI_TEST_PG_NATIVE === "1" ||
  Bun.which("docker")
    ? test
    : test.skip;

postgresTest(
  "only a file's owner shares or limits it, under real FORCE-RLS, with an audit fact",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("file-visibility");
    if (!owned) throw new Error("File visibility verification requires PostgreSQL");
    let client: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      client = createDb(appUrl.toString());
      const db = client.db;
      // The private lookup is a registered, PUBLIC-revoked runtime capability.
      await assertRuntimeDatabasePosture(db, {
        rlsStrategy: "force",
        expectedRole: "opengeni_app",
        targetSchema: "public",
      });
      const scope = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
      await owned.admin`INSERT INTO managed_accounts(id,name) VALUES(${scope.accountId},'Files')`;
      await owned.admin`INSERT INTO workspaces(id,account_id,name,settings) VALUES(${scope.workspaceId},${scope.accountId},'Files','{}')`;

      const insertFile = async (input: {
        privateTo?: string[] | null;
        owner?: string | null;
        status?: string;
        objectKey?: string;
      }) => {
        const id = crypto.randomUUID();
        await owned.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,sha256,bucket,object_key,private_owner_subject_ids,owner_subject_id)
          VALUES(${id},${scope.accountId},${scope.workspaceId},${input.status ?? "ready"},'chart.png','chart.png','image/png',10,${"a".repeat(64)},'fixture',
            ${input.objectKey ?? `workspaces/${scope.workspaceId}/files/${id}/chart.png`},${input.privateTo ?? null},${input.owner ?? null})`;
        return id;
      };
      const alice = { subjectId: "user:alice", privateFileOwnerSubjectId: "user:alice" };
      const bob = { subjectId: "user:bob", privateFileOwnerSubjectId: "user:bob" };
      const as = <T>(actor: typeof alice, fn: () => Promise<T>) =>
        withSessionRlsActorContext(actor, fn);
      const visibleTo = async (actor: typeof alice, id: string) =>
        (
          await as(actor, () =>
            getFilesForSubject(db, { ...scope, subjectId: actor.subjectId, fileIds: [id] }),
          )
        ).length === 1;
      const change = (actor: typeof alice, fileId: string, visibility: "private" | "workspace") =>
        as(actor, () =>
          updateFileVisibility(db, {
            ...scope,
            fileId,
            visibility,
            actorSubjectId: actor.subjectId,
            auditSubjectId: actor.subjectId,
          }),
        );

      const privateFile = await insertFile({ privateTo: ["user:alice"], owner: "user:alice" });
      const sharedFile = await insertFile({});
      const screenshot = await insertFile({
        privateTo: ["user:alice"],
        owner: "user:alice",
        objectKey: `workspaces/${scope.workspaceId}/files/x/retained/shot.png`,
      });
      const pending = await insertFile({
        privateTo: ["user:alice"],
        owner: "user:alice",
        status: "pending",
      });

      // Someone else's Only me file: hidden, and only "private" is revealed.
      expect(await visibleTo(bob, privateFile)).toBe(false);
      expect(await visibleTo(alice, privateFile)).toBe(true);
      const privateToAnother = (actor: typeof alice, fileId: string) =>
        as(actor, () => isFilePrivateToAnother(db, { ...scope, fileId }));
      expect(await privateToAnother(bob, privateFile)).toBe(true);
      expect(await privateToAnother(alice, privateFile)).toBe(false);
      expect(await privateToAnother(bob, sharedFile)).toBe(false);
      expect(await privateToAnother(bob, pending)).toBe(false);
      expect(await privateToAnother(bob, crypto.randomUUID())).toBe(false);

      // Nobody else can share it or even find it to try.
      expect((await change(bob, privateFile, "workspace")).kind).toBe("not_found");
      // Its owner shares it: the workspace can open it and the change is audited.
      const shared = await change(alice, privateFile, "workspace");
      expect(shared).toMatchObject({
        kind: "changed",
        file: { scope: "workspace", ownerSubjectId: "user:alice" },
      });
      expect(await visibleTo(bob, privateFile)).toBe(true);
      expect(await privateToAnother(bob, privateFile)).toBe(false);
      expect((await change(alice, privateFile, "workspace")).kind).toBe("unchanged");
      const audits =
        await owned.admin`SELECT subject_id, action, target_id, metadata FROM audit_events WHERE target_id=${privateFile} ORDER BY occurred_at`;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        subject_id: "user:alice",
        action: "file.visibility.changed",
        target_id: privateFile,
      });
      expect(JSON.stringify(audits[0]!.metadata)).toContain('"to":"workspace"');

      // Only its owner can limit it again; a shared file with no owner stays shared.
      expect((await change(bob, privateFile, "private")).kind).toBe("not_owner");
      expect((await change(bob, sharedFile, "private")).kind).toBe("not_owner");
      expect(await change(alice, privateFile, "private")).toMatchObject({
        kind: "changed",
        file: { scope: "personal", ownerSubjectId: "user:alice" },
      });
      expect(await visibleTo(bob, privateFile)).toBe(false);

      // Session screenshots and unfinished files keep their audience.
      expect((await change(alice, screenshot, "workspace")).kind).toBe("not_changeable");
      expect((await change(alice, pending, "workspace")).kind).toBe("not_changeable");

      // The trigger, not just the application, enforces the two owner actions.
      const raw = postgres(appUrl.toString(), {
        max: 1,
        connection: {
          application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME,
          statement_timeout: 30_000,
        },
      });
      try {
        const asApp = (actor: string, run: (tx: postgres.TransactionSql) => Promise<unknown>) =>
          raw.begin(async (tx) => {
            await tx`SELECT set_config('opengeni.account_id',${scope.accountId},true),set_config('opengeni.workspace_id',${scope.workspaceId},true),set_config('opengeni.subject_id',${actor},true),set_config('opengeni.private_file_owner',${actor},true)`;
            return await run(tx);
          });
        await expect(
          asApp("user:bob", (tx) =>
            tx`UPDATE files SET private_owner_subject_ids=ARRAY['user:bob'], owner_subject_id='user:bob' WHERE id=${sharedFile}`.execute(),
          ),
        ).rejects.toMatchObject({ code: "55000" });
        await expect(
          asApp("user:alice", (tx) =>
            tx`UPDATE files SET owner_subject_id='user:bob' WHERE id=${privateFile}`.execute(),
          ),
        ).rejects.toMatchObject({ code: "55000" });
        await expect(
          asApp("user:alice", (tx) =>
            tx`UPDATE files SET private_owner_subject_ids=NULL WHERE id=${screenshot}`.execute(),
          ),
        ).rejects.toMatchObject({ code: "55000" });
        // A new file records who made it from the same identity RLS uses.
        const madeId = crypto.randomUUID();
        await asApp("user:alice", (tx) =>
          tx`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key,private_owner_subject_ids)
            VALUES(${madeId},${scope.accountId},${scope.workspaceId},'ready','a.txt','a.txt','text/plain',1,'fixture',${`workspaces/${scope.workspaceId}/files/${madeId}/a.txt`},ARRAY['user:alice'])`.execute(),
        );
        const [made] = await owned.admin`SELECT owner_subject_id FROM files WHERE id=${madeId}`;
        expect(made!.owner_subject_id).toBe("user:alice");
        // The yes-or-no lookup refuses any scope but the caller's own.
        await expect(
          asApp("user:bob", (tx) =>
            tx`SELECT opengeni_private.file_private_to_another(${crypto.randomUUID()}::uuid,${scope.workspaceId}::uuid,${privateFile}::uuid)`.execute(),
          ),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await raw.end({ timeout: 5 });
      }
      // Even an unrestricted maintenance session cannot reassign an owner.
      await expect(
        owned.admin`UPDATE files SET owner_subject_id='user:mallory' WHERE id=${privateFile}`.execute(),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        owned.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key,private_owner_subject_ids,owner_subject_id)
          VALUES(${crypto.randomUUID()},${scope.accountId},${scope.workspaceId},'ready','b.txt','b.txt','text/plain',1,'fixture','k',ARRAY['user:alice'],'user:bob')`.execute(),
      ).rejects.toMatchObject({ code: "23514" });

      const grants = await owned.admin`SELECT
          has_function_privilege('opengeni_app','opengeni_private.file_private_to_another(uuid,uuid,uuid)','EXECUTE') AS app,
          p.proconfig, p.prosecdef, p.proacl::text AS acl
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='opengeni_private' AND p.proname='file_private_to_another'`;
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({ app: true, prosecdef: true });
      expect(grants[0]!.proconfig).toContain("search_path=pg_catalog, public, pg_temp");
      expect(String(grants[0]!.acl)).not.toMatch(/(^|[{,])=X/);

      // Existing private files are not rewritten: one with a single private
      // owner reads as theirs, and sharing it records that owner.
      const legacy = await insertFile({ privateTo: ["user:alice"] });
      const legacyJoint = await insertFile({ privateTo: ["user:alice", "user:bob"] });
      const ownerOf = async (id: string) =>
        (
          await as(alice, () =>
            getFilesForSubject(db, { ...scope, subjectId: alice.subjectId, fileIds: [id] }),
          )
        )[0]?.ownerSubjectId;
      expect(await ownerOf(legacy)).toBe("user:alice");
      expect(await ownerOf(legacyJoint)).toBeNull();
      expect(await change(alice, legacy, "workspace")).toMatchObject({
        kind: "changed",
        file: { scope: "workspace", ownerSubjectId: "user:alice" },
      });
      const [recorded] = await owned.admin`SELECT owner_subject_id FROM files WHERE id=${legacy}`;
      expect(recorded!.owner_subject_id).toBe("user:alice");
      expect((await change(alice, legacy, "private")).kind).toBe("changed");
    } finally {
      await client?.close();
      await owned.release();
    }
  },
  180_000,
);
