import { expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  createDb,
  createSession,
  getSessionAuthorityProjection,
  getWorkspaceArtifactContentRef,
  withSessionRlsActorContext,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { acquireOwnerMigratedTestDatabase, testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { registerWorkspaceArtifactRoutes } from "../src/routes/workspace-artifacts";

// CI must execute the real FORCE-RLS proof; local no-Docker runs report a skip.
const postgresTest =
  process.env.CI || process.env.OPENGENI_REQUIRE_REAL_DB === "1" || Bun.which("docker")
    ? test
    : test.skip;

postgresTest(
  "a Site published from an Only me chat is readable by the workspace without revealing the chat",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("site-private-source");
    if (!owned) throw new Error("Site visibility verification requires PostgreSQL");
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
      await owned.admin.begin(async (tx) => {
        await tx`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Site visibility')`;
        await tx`INSERT INTO workspaces(id,account_id,name,settings) VALUES(${workspaceId},${accountId},'Shared','{}'),(${personalWorkspaceId},${accountId},'Owner Personal','{}')`;
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`INSERT INTO organization_memberships(id,account_id,subject_id,role,status,personal_workspace_id) VALUES(${membershipId},${accountId},${ownerSubject},'owner','active',${personalWorkspaceId})`;
        await tx`INSERT INTO workspace_memberships(account_id,workspace_id,subject_id,role,permissions) VALUES(${accountId},${workspaceId},${ownerSubject},'member','["artifacts:read","sessions:read"]'),(${accountId},${workspaceId},${viewerSubject},'member','["artifacts:read","sessions:read"]')`;
        await tx`SET LOCAL session_replication_role = origin`;
        await tx`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${workspaceId},${accountId}),(${personalWorkspaceId},${accountId})`;
      });
      const privateSource = await createSession(client.db, {
        accountId,
        workspaceId,
        initialMessage: "Build a page",
        model: "test-model",
        resources: [],
        metadata: {},
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: ownerSubject },
        createdByContext: {},
      });
      const siteId = crypto.randomUUID(),
        firstVersionId = crypto.randomUUID(),
        currentVersionId = crypto.randomUUID();
      await owned.admin.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`UPDATE sessions SET visibility='user_private',owner_subject_id=${ownerSubject},owner_organization_membership_id=${membershipId} WHERE id=${privateSource.id}`;
        await tx`INSERT INTO workspace_artifacts(id,account_id,workspace_id,slug,title,current_version_id,created_by_subject_id)
          VALUES(${siteId},${accountId},${workspaceId},'private-chat-site','Private chat Site',${currentVersionId},${ownerSubject})`;
        for (const [id, revision] of [
          [firstVersionId, 1],
          [currentVersionId, 2],
        ] as const) {
          await tx`INSERT INTO workspace_artifact_versions(id,account_id,workspace_id,artifact_id,revision,content_key,content_sha256,size_bytes,operation_key,source_session_id,source_turn_id,source_attempt_id,source_execution_generation,created_by_subject_id)
            VALUES(${id},${accountId},${workspaceId},${siteId},${revision},${`blob-${revision}`},${"a".repeat(64)},10,${`op-${revision}`},${privateSource.id},${crypto.randomUUID()},${crypto.randomUUID()},1,'worker:first-party-mcp')`;
          await tx`INSERT INTO workspace_artifact_events(account_id,workspace_id,artifact_id,type,from_version_id,to_version_id,operation_key,source_session_id,source_turn_id,source_attempt_id,source_execution_generation,actor_subject_id,reason)
            VALUES(${accountId},${workspaceId},${siteId},'published',${revision === 1 ? null : firstVersionId},${id},${`op-${revision}`},${privateSource.id},${crypto.randomUUID()},${crypto.randomUUID()},1,'worker:first-party-mcp','publish')`;
        }
      });

      // The chat itself stays hidden from the other member.
      expect(
        await withSessionRlsActorContext({ subjectId: viewerSubject }, () =>
          getSessionAuthorityProjection(client!.db, workspaceId, privateSource.id),
        ),
      ).toBeNull();
      // The published content does not: its current version is readable.
      const viewerRef = await withSessionRlsActorContext({ subjectId: viewerSubject }, () =>
        getWorkspaceArtifactContentRef(
          client!.db,
          workspaceId,
          { subjectId: viewerSubject },
          siteId,
        ),
      );
      expect(viewerRef.version.id).toBe(currentVersionId);
      expect(viewerRef.contentKey).toBe("blob-2");

      const secret = "site-private-source-test-secret";
      const app = new Hono();
      registerWorkspaceArtifactRoutes(app, {
        db: client.db,
        settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
        managedAuth: null,
      } as never);
      const token = async (subjectId: string) =>
        `Bearer ${await signDelegatedAccessToken(secret, {
          accountId,
          workspaceId,
          subjectId,
          principalKind: "human_session",
          permissions: ["artifacts:read", "sessions:read"],
          exp: Math.floor(Date.now() / 1000) + 3600,
        })}`;
      const read = async (subjectId: string, path = "") => {
        const response = await app.request(
          `/v1/workspaces/${workspaceId}/published-artifacts${path}`,
          { headers: { authorization: await token(subjectId) } },
        );
        expect(response.status, await response.clone().text()).toBe(200);
        return await response.json();
      };

      const viewerDetail = await read(viewerSubject, `/${siteId}`);
      expect(viewerDetail.artifact.currentVersion).toMatchObject({
        id: currentVersionId,
        sourceSessionId: null,
        sourceTurnId: null,
        sourceAttemptId: null,
      });
      expect(viewerDetail.versions.map((version: { id: string }) => version.id).sort()).toEqual(
        [firstVersionId, currentVersionId].sort(),
      );
      expect(viewerDetail.events).toHaveLength(2);
      expect(JSON.stringify(viewerDetail)).not.toContain(privateSource.id);

      const viewerList = await read(viewerSubject);
      expect(
        viewerList.artifacts.find((artifact: { id: string }) => artifact.id === siteId)
          ?.currentVersion?.id,
      ).toBe(currentVersionId);
      expect(JSON.stringify(viewerList)).not.toContain(privateSource.id);

      // The chat's owner still sees where the Site came from.
      const ownerDetail = await read(ownerSubject, `/${siteId}`);
      expect(ownerDetail.artifact.currentVersion.sourceSessionId).toBe(privateSource.id);
    } finally {
      await client?.close();
      await owned.release();
    }
  },
  180_000,
);
