import { expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { EditableArtifactApplicationPort } from "@opengeni/core";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionAuthorityProjection,
  initializeSessionStartAtomically,
  recordSandboxFilePublication,
  requireWorkspace,
  withSessionRlsActorContext,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { acquireOwnerMigratedTestDatabase, testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { registerArtifactCatalogRoutes } from "../src/routes/artifact-catalog";

// CI must execute the real FORCE-RLS proof; local no-Docker runs report a skip.
const postgresTest =
  process.env.CI || process.env.OPENGENI_REQUIRE_REAL_DB === "1" || Bun.which("docker")
    ? test
    : test.skip;
postgresTest(
  "catalog enforces real private provenance RLS for human viewers and owner agents across kind filters",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("catalog-private-provenance");
    if (!owned) throw new Error("Catalog provenance verification requires PostgreSQL");
    let client: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(owned.ownerUrl);
      // Provision cluster roles with the harness administrator; migrations
      // above still exercise the restricted NOSUPERUSER/NOBYPASSRLS owner.
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
      // Owner-only fixture setup supplies a valid ownership graph. The boundary
      // under test is runtime read RLS, not membership/session-create protocols.
      await owned.admin.begin(async (tx) => {
        await tx`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Catalog provenance')`;
        // Workspace kind is derived from organization membership's Personal
        // pointer; there is intentionally no physical workspaces.kind column.
        await tx`INSERT INTO workspaces(id,account_id,name,settings) VALUES(${workspaceId},${accountId},'Shared catalog','{}'),(${personalWorkspaceId},${accountId},'Owner Personal','{}')`;
        // Keep workspace bootstrap triggers active (including the canonical
        // session-activity counter). Only protected membership seeding bypasses
        // lifecycle writer triggers in this administrator-owned fixture.
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`INSERT INTO organization_memberships(id,account_id,subject_id,role,status,personal_workspace_id) VALUES(${membershipId},${accountId},${ownerSubject},'owner','active',${personalWorkspaceId})`;
        await tx`INSERT INTO workspace_memberships(account_id,workspace_id,subject_id,role,permissions) VALUES(${accountId},${workspaceId},${ownerSubject},'member','["files:read","sessions:read"]'),(${accountId},${workspaceId},${viewerSubject},'member','["files:read","sessions:read"]')`;
        await tx`SET LOCAL session_replication_role = origin`;
        await tx`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${workspaceId},${accountId}),(${personalWorkspaceId},${accountId})`;
      });
      for (const [id, kind] of [
        [workspaceId, "shared"],
        [personalWorkspaceId, "personal"],
      ] as const)
        expect(
          (
            await withSessionRlsActorContext({ subjectId: ownerSubject }, () =>
              requireWorkspace(client!.db, id),
            )
          ).kind,
        ).toBe(kind);
      const create = () =>
        createSession(client!.db, {
          accountId,
          workspaceId,
          initialMessage: "Catalog source",
          model: "test-model",
          resources: [],
          metadata: {},
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: ownerSubject },
          createdByContext: {},
        });
      const privateSource = await create(),
        sharedSource = await create();
      const privateFile = crypto.randomUUID(),
        sharedFile = crypto.randomUUID(),
        unsupportedImage = crypto.randomUUID();
      for (const [fileId, sourceId, contentType] of [
        [privateFile, privateSource.id, "image/png"],
        [sharedFile, sharedSource.id, "image/png"],
        [unsupportedImage, sharedSource.id, "image/tiff"],
      ] as const) {
        await owned.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,sha256,bucket,object_key)
        VALUES(${fileId},${accountId},${workspaceId},'ready',${fileId},${fileId},${contentType},10,${"a".repeat(64)},'fixture',${fileId})`;
        await withSessionRlsActorContext({ subjectId: ownerSubject }, () =>
          recordSandboxFilePublication(client!.db, {
            accountId,
            workspaceId,
            fileId,
            sourceSessionId: sourceId,
          }),
        );
      }
      await owned.admin.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`UPDATE sessions SET visibility='user_private',owner_subject_id=${ownerSubject},owner_organization_membership_id=${membershipId} WHERE id=${privateSource.id}`;
      });
      expect(
        await withSessionRlsActorContext({ subjectId: viewerSubject }, () =>
          getSessionAuthorityProjection(client!.db, workspaceId, privateSource.id),
        ),
      ).toBeNull();
      expect(
        await withSessionRlsActorContext({ subjectId: ownerSubject }, () =>
          getSessionAuthorityProjection(client!.db, workspaceId, privateSource.id),
        ),
      ).not.toBeNull();
      const secret = "catalog-private-provenance-test-secret";
      const app = new Hono();
      registerArtifactCatalogRoutes(app, {
        db: client.db,
        settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
        managedAuth: null,
      } as never);
      const authorization = `Bearer ${await signDelegatedAccessToken(secret, { accountId, workspaceId, subjectId: viewerSubject, principalKind: "human_session", permissions: ["files:read", "sessions:read"], exp: Math.floor(Date.now() / 1000) + 3600 })}`;
      const request = (query: string) =>
        app.request(`/v1/workspaces/${workspaceId}/artifact-catalog?${query}`, {
          headers: { authorization },
        });
      const response = await request("kind=image");
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await response.json();
      expect(body.items.map((item: { id: string }) => item.id).sort()).toEqual(
        [privateFile, sharedFile].sort(),
      );
      expect(body.items.find((item: { id: string }) => item.id === privateFile)).toMatchObject({
        kind: "image",
        file: { artifactId: privateFile, kind: "file", contentType: "image/png" },
      });
      expect(
        body.items.find((item: { id: string }) => item.id === sharedFile).sourceSessionId,
      ).toBe(sharedSource.id);
      expect(JSON.stringify(body)).not.toContain(privateSource.id);
      expect((await request(`kind=image&sourceSessionId=${privateSource.id}`)).status).toBe(404);
      const sharedPage = await request(`kind=image&sourceSessionId=${sharedSource.id}`);
      expect(sharedPage.status).toBe(200);
      expect((await sharedPage.json()).items.map((item: { id: string }) => item.id)).toEqual([
        sharedFile,
      ]);
      expect(
        (await (await request("kind=file")).json()).items.map((item: { id: string }) => item.id),
      ).toEqual([unsupportedImage]);

      const started = await initializeSessionStartAtomically(client.db, {
        accountId,
        workspaceId,
        sessionId: sharedSource.id,
        reasoningEffortFallback: "low",
        createdEventPayload: {},
        goal: null,
      });
      if (!started.turn) throw new Error("Owner agent fixture did not create an initial turn");
      const attemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
        sessionId: sharedSource.id,
        workflowId: `session-${sharedSource.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      if (claimed.action !== "claimed") throw new Error("Owner agent fixture was not claimed");
      const workerSubject = "worker:catalog-owner-agent";
      expect(
        await withSessionRlsActorContext({ subjectId: workerSubject }, () =>
          getSessionAuthorityProjection(client!.db, workspaceId, privateSource.id),
        ),
      ).toBeNull();
      expect(
        await withSessionRlsActorContext(
          { subjectId: workerSubject, initiatingHumanSubjectId: ownerSubject },
          () => getSessionAuthorityProjection(client!.db, workspaceId, privateSource.id),
        ),
      ).not.toBeNull();
      expect(
        await withSessionRlsActorContext(
          { subjectId: workerSubject, initiatingHumanSubjectId: viewerSubject },
          () => getSessionAuthorityProjection(client!.db, workspaceId, privateSource.id),
        ),
      ).toBeNull();
      const siteId = crypto.randomUUID(),
        versionId = crypto.randomUUID();
      const editableIds = {
        document: "1".repeat(32),
        spreadsheet: "2".repeat(32),
        presentation: "3".repeat(32),
      } as const;
      // Seed existing native domain identities, not a catalog content store.
      // The route below still uses runtime RLS and the per-item application.
      await owned.admin.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`INSERT INTO workspace_artifacts(id,account_id,workspace_id,slug,title,current_version_id,created_by_subject_id)
          VALUES(${siteId},${accountId},${workspaceId},'owner-agent-site','Owner Site',${versionId},${ownerSubject})`;
        await tx`INSERT INTO workspace_artifact_versions(id,account_id,workspace_id,artifact_id,revision,content_key,content_sha256,size_bytes,operation_key,source_session_id,source_turn_id,source_attempt_id,source_execution_generation,created_by_subject_id)
          VALUES(${versionId},${accountId},${workspaceId},${siteId},1,'fixture',${"a".repeat(64)},10,'owner-agent-site',${privateSource.id},${crypto.randomUUID()},${crypto.randomUUID()},1,${ownerSubject})`;
        for (const [kind, id] of Object.entries(editableIds)) {
          await tx`INSERT INTO editable_artifacts(account_id,workspace_id,id,modality,title,authorization_revision,causal_frontier,state_hash,created_by_subject_id)
            VALUES(${accountId},${workspaceId},${id},${kind},${`Owner ${kind}`},1,${kind === "spreadsheet" ? "[]" : null}::jsonb,${`sha256:${"a".repeat(64)}`},${ownerSubject})`;
          await tx`INSERT INTO editable_artifact_session_links(account_id,workspace_id,session_id,artifact_id)
            VALUES(${accountId},${workspaceId},${privateSource.id},${id})`;
        }
      });
      const artifactReads: Array<Parameters<EditableArtifactApplicationPort["readArtifact"]>[0]> =
        [];
      const readArtifact: EditableArtifactApplicationPort["readArtifact"] = async (input) => {
        artifactReads.push(input);
        const modality = Object.entries(editableIds).find(([, id]) => id === input.artifactId)?.[0];
        if (!modality) throw new Error("Unexpected artifact application read");
        return {
          scope: input.scope,
          id: input.artifactId,
          modality,
          title: `Owner ${modality}`,
          lifecycle: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as never;
      };
      const ownerAgentApp = new Hono();
      registerArtifactCatalogRoutes(ownerAgentApp, {
        db: client.db,
        settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
        managedAuth: null,
        editableArtifacts: { readArtifact },
      } as never);
      const ownerAgentToken = await signDelegatedAccessToken(secret, {
        accountId,
        workspaceId,
        subjectId: workerSubject,
        principalKind: "agent_attempt",
        permissions: ["artifacts:read", "sessions:read"],
        sessionId: sharedSource.id,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const wrongOwnerToken = await signDelegatedAccessToken(secret, {
        accountId,
        workspaceId,
        subjectId: viewerSubject,
        principalKind: "human_session",
        permissions: ["artifacts:read", "sessions:read"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const agentRequest = (query: string, token = ownerAgentToken) =>
        ownerAgentApp.request(`/v1/workspaces/${workspaceId}/artifact-catalog?${query}`, {
          headers: { authorization: `Bearer ${token}` },
        });
      for (const [kind, id] of Object.entries({ site: siteId, ...editableIds })) {
        const query = `kind=${kind}&sourceSessionId=${privateSource.id}`;
        const ownerPage = await agentRequest(query);
        expect(ownerPage.status, await ownerPage.clone().text()).toBe(200);
        expect((await ownerPage.json()).items).toMatchObject([
          { id, kind, sourceSessionId: privateSource.id },
        ]);
        expect((await agentRequest(query, wrongOwnerToken)).status).toBe(404);
        const discovery = await agentRequest(`kind=${kind}`);
        expect(discovery.status, await discovery.clone().text()).toBe(200);
        const item = (await discovery.json()).items[0];
        expect(item.id).toBe(id);
        // Editable workspace discovery intentionally has no canonical session.
        expect(item.sourceSessionId).toBe(kind === "site" ? privateSource.id : undefined);
      }
      expect(artifactReads).toHaveLength(6);
      expect(artifactReads.every(({ actor }) => actor.kind === "agent")).toBe(true);
      await owned.admin`UPDATE session_turn_attempts SET state='closed',outcome='completed',closed_at=now() WHERE workspace_id=${workspaceId} AND id=${attemptId}`;
      for (const kind of ["site", ...Object.keys(editableIds)])
        expect((await agentRequest(`kind=${kind}`)).status).toBe(404);
    } finally {
      await client?.close();
      await owned.release();
    }
  },
  180_000,
);
