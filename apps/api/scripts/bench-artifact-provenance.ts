import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  createDb,
  createSession,
  recordSandboxFilePublication,
  withSessionRlsActorContext,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { registerArtifactCatalogRoutes } from "../src/routes/artifact-catalog";

// Disposable, real-RLS diagnostic. No provider traffic or production data.
const fixture = await acquireOwnerMigratedTestDatabase("artifact-provenance-budget");
if (!fixture) throw new Error("Real PostgreSQL required");
let client: ReturnType<typeof createDb> | undefined;
try {
  await migrate(fixture.ownerUrl);
  await provisionRoles(fixture.adminUrl, { appPassword: fixture.appPassword });
  const appUrl = new URL(fixture.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = fixture.appPassword;
  client = createDb(appUrl.toString());
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID();
  const personalWorkspaceId = crypto.randomUUID(),
    membershipId = crypto.randomUUID();
  const subjectId = `user:${crypto.randomUUID()}`;
  await fixture.admin.begin(async (tx) => {
    await tx`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Budget fixture')`;
    await tx`INSERT INTO workspaces(id,account_id,name,settings) VALUES
      (${workspaceId},${accountId},'Shared','{}'),(${personalWorkspaceId},${accountId},'Personal','{}')`;
    await tx`SET LOCAL session_replication_role=replica`;
    await tx`INSERT INTO organization_memberships(id,account_id,subject_id,role,status,personal_workspace_id)
      VALUES(${membershipId},${accountId},${subjectId},'owner','active',${personalWorkspaceId})`;
    await tx`INSERT INTO workspace_memberships(account_id,workspace_id,subject_id,role,permissions)
      VALUES(${accountId},${workspaceId},${subjectId},'member','["files:read","sessions:read"]')`;
    await tx`SET LOCAL session_replication_role=origin`;
    await tx`INSERT INTO workspace_inference_controls(workspace_id,account_id)
      VALUES(${workspaceId},${accountId}),(${personalWorkspaceId},${accountId})`;
  });
  const sources: string[] = [];
  for (let i = 0; i < 60; i++) {
    const session = await withSessionRlsActorContext({ subjectId }, () =>
      createSession(client!.db, {
        accountId,
        workspaceId,
        initialMessage: "Fixture source",
        model: "test-model",
        resources: [],
        metadata: {},
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId },
        createdByContext: {},
      }),
    );
    sources.push(session.id);
  }
  for (const group of ["Unique", "Same"]) {
    for (let i = 0; i < 60; i++) {
      const id = crypto.randomUUID(),
        filename = `${group}-${i}.txt`;
      await fixture.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,sha256,bucket,object_key)
        VALUES(${id},${accountId},${workspaceId},'ready',${filename},${filename},'text/plain',10,${"a".repeat(64)},'fixture',${id})`;
      await withSessionRlsActorContext({ subjectId }, () =>
        recordSandboxFilePublication(client!.db, {
          accountId,
          workspaceId,
          fileId: id,
          sourceSessionId: sources[group === "Same" ? 0 : i]!,
        }),
      );
    }
  }
  const secret = "artifact-budget-fixture-only-signing-secret";
  const app = new Hono();
  registerArtifactCatalogRoutes(app, {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
    managedAuth: null,
  } as never);
  const authorization = `Bearer ${await signDelegatedAccessToken(secret, {
    accountId,
    workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: ["files:read", "sessions:read"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  const driver = (client.db as any).$client;
  const samples: unknown[] = [];
  for (let iteration = 0; iteration < 8; iteration++) {
    for (const group of iteration % 2 ? ["Unique", "Same"] : ["Same", "Unique"]) {
      const queries: Record<string, number> = {};
      driver.options.debug = (_id: number, query: string) => {
        const key = query.replace(/\s+/g, " ").trim();
        queries[key] = (queries[key] ?? 0) + 1;
      };
      const start = performance.now(),
        cpu = process.cpuUsage();
      const response = await app.request(
        `/v1/workspaces/${workspaceId}/artifact-catalog?kind=file&q=${group}&limit=60`,
        { headers: { authorization } },
      );
      const body = await response.json();
      const elapsedMs = performance.now() - start,
        used = process.cpuUsage(cpu);
      driver.options.debug = undefined;
      if (
        response.status !== 200 ||
        body.items.length !== 60 ||
        body.items.some((x: any) => !x.sourceSessionId)
      ) {
        throw new Error(JSON.stringify({ status: response.status, body }));
      }
      if (iteration >= 3)
        samples.push({
          group,
          elapsedMs,
          cpuMs: (used.user + used.system) / 1000,
          statements: Object.values(queries).reduce((a, b) => a + b, 0),
          queries,
        });
    }
  }
  console.log(JSON.stringify({ source: "current-worktree", samples }, null, 2));
} finally {
  await client?.close();
  await fixture.release();
}
