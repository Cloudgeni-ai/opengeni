import { expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { EditableArtifactApplicationPort } from "@opengeni/core";
import {
  createDb,
  createSession,
  listSessionTreeIds,
  recordSandboxFilePublication,
  withSessionRlsActorContext,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { registerArtifactCatalogRoutes } from "../src/routes/artifact-catalog";

// CI must execute the real FORCE-RLS proof; local no-Docker runs report a skip.
const postgresTest =
  process.env.CI || process.env.OPENGENI_REQUIRE_REAL_DB === "1" || Bun.which("docker")
    ? test
    : test.skip;
postgresTest(
  "catalog lists a chat and its readable sub-sessions in one read",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("catalog-session-tree");
    if (!owned) throw new Error("Catalog session tree verification requires PostgreSQL");
    let client: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      client = createDb(appUrl.toString());
      const accountId = crypto.randomUUID(),
        workspaceId = crypto.randomUUID(),
        personalWorkspaceId = crypto.randomUUID();
      const ownerSubject = `user:${crypto.randomUUID()}`,
        viewerSubject = `user:${crypto.randomUUID()}`,
        membershipId = crypto.randomUUID();
      const permissions = '["artifacts:read","files:read","sessions:read"]';
      await owned.admin.begin(async (tx) => {
        await tx`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Catalog tree')`;
        await tx`INSERT INTO workspaces(id,account_id,name,settings) VALUES(${workspaceId},${accountId},'Shared catalog','{}'),(${personalWorkspaceId},${accountId},'Owner Personal','{}')`;
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`INSERT INTO organization_memberships(id,account_id,subject_id,role,status,personal_workspace_id) VALUES(${membershipId},${accountId},${ownerSubject},'owner','active',${personalWorkspaceId})`;
        await tx`INSERT INTO workspace_memberships(account_id,workspace_id,subject_id,role,permissions) VALUES(${accountId},${workspaceId},${ownerSubject},'member',${permissions}),(${accountId},${workspaceId},${viewerSubject},'member',${permissions})`;
        await tx`SET LOCAL session_replication_role = origin`;
        await tx`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${workspaceId},${accountId}),(${personalWorkspaceId},${accountId})`;
      });
      const create = async () =>
        (
          await createSession(client!.db, {
            accountId,
            workspaceId,
            initialMessage: "Catalog tree",
            model: "test-model",
            resources: [],
            metadata: {},
            reasoningEffort: "medium",
            latencyMode: "standard",
            sandboxBackend: "none",
            createdBy: { kind: "subject", subjectId: ownerSubject },
            createdByContext: {},
          })
        ).id;
      const parent = await create(),
        child = await create(),
        grandchild = await create(),
        privateChild = await create(),
        unrelated = await create();
      await owned.admin.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        for (const [id, parentId] of [
          [child, parent],
          [grandchild, child],
          [privateChild, parent],
        ] as const)
          await tx`UPDATE sessions SET parent_session_id=${parentId}, root_session_id=${parent} WHERE id=${id}`;
        await tx`UPDATE sessions SET visibility='user_private',owner_subject_id=${ownerSubject},owner_organization_membership_id=${membershipId} WHERE id=${privateChild}`;
      });
      expect(
        await withSessionRlsActorContext({ subjectId: ownerSubject }, () =>
          listSessionTreeIds(client!.db, workspaceId, parent),
        ),
      ).toEqual([parent, privateChild, child, grandchild]);
      expect(await listSessionTreeIds(client.db, workspaceId, crypto.randomUUID())).toBeNull();

      // One published file per session, a Site made by the grandchild and a
      // document the child worked on.
      const files = new Map<string, string>();
      for (const source of [parent, child, grandchild, privateChild, unrelated]) {
        const fileId = crypto.randomUUID();
        files.set(source, fileId);
        await owned.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,sha256,bucket,object_key)
          VALUES(${fileId},${accountId},${workspaceId},'ready',${`${fileId}.pdf`},${`${fileId}.pdf`},'application/pdf',10,${"a".repeat(64)},'fixture',${fileId})`;
        await withSessionRlsActorContext({ subjectId: ownerSubject }, () =>
          recordSandboxFilePublication(client!.db, {
            accountId,
            workspaceId,
            fileId,
            sourceSessionId: source,
          }),
        );
      }
      const siteId = crypto.randomUUID(),
        versionId = crypto.randomUUID(),
        documentId = "4".repeat(32);
      await owned.admin.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`INSERT INTO workspace_artifacts(id,account_id,workspace_id,slug,title,current_version_id,created_by_subject_id)
          VALUES(${siteId},${accountId},${workspaceId},'tree-site','Tree Site',${versionId},${ownerSubject})`;
        await tx`INSERT INTO workspace_artifact_versions(id,account_id,workspace_id,artifact_id,revision,content_key,content_sha256,size_bytes,operation_key,source_session_id,source_turn_id,source_attempt_id,source_execution_generation,created_by_subject_id)
          VALUES(${versionId},${accountId},${workspaceId},${siteId},1,'fixture',${"a".repeat(64)},10,'tree-site',${grandchild},${crypto.randomUUID()},${crypto.randomUUID()},1,${ownerSubject})`;
        await tx`INSERT INTO editable_artifacts(account_id,workspace_id,id,modality,title,authorization_revision,causal_frontier,state_hash,created_by_subject_id)
          VALUES(${accountId},${workspaceId},${documentId},'document','Tree document',1,null,${`sha256:${"a".repeat(64)}`},${ownerSubject})`;
        await tx`INSERT INTO editable_artifact_session_links(account_id,workspace_id,session_id,artifact_id)
          VALUES(${accountId},${workspaceId},${child},${documentId})`;
      });
      const readArtifact: EditableArtifactApplicationPort["readArtifact"] = async (input) =>
        ({
          scope: input.scope,
          id: input.artifactId,
          modality: "document",
          title: "Tree document",
          lifecycle: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }) as never;
      const secret = "catalog-session-tree-test-secret";
      const app = new Hono();
      registerArtifactCatalogRoutes(app, {
        db: client.db,
        settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
        managedAuth: null,
        editableArtifacts: { readArtifact },
      } as never);
      const token = async (subjectId: string) =>
        `Bearer ${await signDelegatedAccessToken(secret, { accountId, workspaceId, subjectId, principalKind: "human_session", permissions: ["artifacts:read", "files:read", "sessions:read"], exp: Math.floor(Date.now() / 1000) + 3600 })}`;
      const viewer = await token(viewerSubject),
        owner = await token(ownerSubject);
      const request = (query: string, authorization = viewer) =>
        app.request(`/v1/workspaces/${workspaceId}/artifact-catalog?${query}`, {
          headers: { authorization },
        });
      const items = async (query: string, authorization = viewer) => {
        const response = await request(query, authorization);
        expect(response.status, await response.clone().text()).toBe(200);
        return (await response.json()) as {
          items: Array<{ id: string; kind: string; sourceSessionId?: string }>;
          nextCursor: string | null;
        };
      };
      const provenance = (body: Awaited<ReturnType<typeof items>>) =>
        Object.fromEntries(body.items.map((item) => [item.id, item.sourceSessionId]));

      // The viewer sees the chat, its child and grandchild, each item with its
      // own source; never the owner's private sub-session or an unrelated chat.
      const tree = await items(`sourceSessionId=${parent}&includeSubSessions=true`);
      expect(provenance(tree)).toEqual({
        [files.get(parent)!]: parent,
        [files.get(child)!]: child,
        [files.get(grandchild)!]: grandchild,
        [siteId]: grandchild,
        [documentId]: child,
      });
      expect(JSON.stringify(tree)).not.toContain(privateChild);
      // The owner may read the private sub-session, so its work is included.
      expect(
        provenance(await items(`sourceSessionId=${parent}&includeSubSessions=true`, owner)),
      ).toMatchObject({ [files.get(privateChild)!]: privateChild });
      // Without the flag only the chat's own work is listed, as before.
      expect(provenance(await items(`sourceSessionId=${parent}`))).toEqual({
        [files.get(parent)!]: parent,
      });
      // A sub-session's own tree excludes its parent.
      expect(
        Object.keys(
          provenance(await items(`sourceSessionId=${child}&includeSubSessions=true`)),
        ).sort(),
      ).toEqual([files.get(child)!, files.get(grandchild)!, siteId, documentId].sort());
      // Pages continue across the tree with the same filters.
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await items(
          `sourceSessionId=${parent}&includeSubSessions=true&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen.sort()).toEqual(Object.keys(provenance(tree)).sort());

      expect((await request("includeSubSessions=true")).status).toBe(422);
      expect(
        (await request(`sourceSessionId=${privateChild}&includeSubSessions=true`)).status,
      ).toBe(404);
    } finally {
      await client?.close();
      await owned.release();
    }
  },
  180_000,
);
