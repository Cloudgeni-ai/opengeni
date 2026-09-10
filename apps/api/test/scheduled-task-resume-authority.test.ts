import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as core from "@opengeni/core";
import {
  bootstrapWorkspace,
  beginExternalIdentityLink,
  confirmExternalIdentityLink,
  createDb,
  createOrganizationApiKey,
  createScheduledTask,
  ensureExternalIdentity,
  getScheduledTask,
  getExternalLinkTaskSnapshot,
  revokeExternalIdentityLink,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { registerScheduledTaskRoutes } from "../src/routes/scheduled-tasks";

let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("scheduled-task-resume-authority");
  if (!acquired) throw new Error("Resume authority requires real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterEach(() => mock.restore());
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

for (const revokeDuringResume of [false, true]) {
  test(`linked resume ${revokeDuringResume ? "rejects revocation after request authentication" : "captures current verified link authority"}`, async () => {
    const nativeSubjectId = `user:${randomUUID()}`;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: randomUUID(),
      accountName: "Resume authority",
      workspaceExternalSource: "test",
      workspaceExternalId: randomUUID(),
      workspaceName: "Resume authority",
      subjectId: nativeSubjectId,
    });
    const grant = access.workspaceGrants[0]!;
    await shared.admin`insert into organization_memberships
      (account_id, subject_id, role, status, personal_workspace_id, authorization_revision)
      values (${grant.accountId}, ${nativeSubjectId}, 'member', 'active', ${grant.workspaceId}, 1)`;
    const identity = await ensureExternalIdentity(client.db, {
      accountId: grant.accountId,
      externalId: "product-user",
    });
    const pending = await beginExternalIdentityLink(client.db, identity, {
      permissions: ["workspace:admin"],
    });
    const link = await confirmExternalIdentityLink(client.db, {
      accountId: grant.accountId,
      linkId: pending.link.id,
      nativeSubjectId,
      request: {
        challenge: pending.challenge,
        expectedRevision: pending.link.revision,
        permissions: ["workspace:admin"],
      },
    });
    const token = randomUUID();
    await createOrganizationApiKey(client.db, {
      accountId: grant.accountId,
      name: "Resume fixture",
      prefix: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions: ["workspace:admin"],
    });
    const task = await createScheduledTask(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBy: { kind: "subject", subjectId: nativeSubjectId },
      name: "Paused native task",
      status: "paused",
      schedule: { type: "manual" },
      temporalScheduleId: randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "Run", resources: [], tools: [], metadata: {} },
      metadata: {},
    });
    const resolveCatalog = core.resolveWorkspaceCatalogSettings;
    let reachedPostAuthentication = false;
    spyOn(core, "resolveWorkspaceCatalogSettings").mockImplementation(async (...args) => {
      const result = await resolveCatalog(...args);
      reachedPostAuthentication = true;
      if (revokeDuringResume) {
        await revokeExternalIdentityLink(client.db, {
          accountId: grant.accountId,
          linkId: link.id,
          subjectId: identity.subjectId,
          expectedRevision: link.revision,
        });
      }
      return result;
    });
    const syncScheduledTask = mock(async () => {});
    const app = new Hono();
    registerScheduledTaskRoutes(app, {
      db: client.db,
      settings: testSettings({ productAccessMode: "managed", sandboxBackend: "none" }),
      objectStorage: null,
      workflowClient: { syncScheduledTask },
    } as unknown as core.ApiRouteDeps);
    const response = await app.request(
      `/v1/workspaces/${grant.workspaceId}/scheduled-tasks/${task.id}/resume`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-opengeni-external-actor": encodeURIComponent(
            JSON.stringify({
              mode: "linked_native",
              identity: { externalId: identity.externalId, source: identity.source },
              linkId: link.id,
              expectedLinkRevision: link.revision,
            }),
          ),
        },
      },
    );
    expect(reachedPostAuthentication).toBe(true);
    expect(response.status).toBe(revokeDuringResume ? 403 : 200);
    const stored = await getScheduledTask(client.db, grant.workspaceId, task.id);
    expect(stored?.status).toBe(revokeDuringResume ? "paused" : "active");
    expect(syncScheduledTask).toHaveBeenCalledTimes(revokeDuringResume ? 0 : 1);
    if (revokeDuringResume) {
      expect(stored?.authorityRevision).toBe(task.authorityRevision);
    } else {
      const snapshot = await getExternalLinkTaskSnapshot(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        taskId: task.id,
        taskRevision: stored!.authorityRevision,
      });
      expect(snapshot?.actor.linkId).toBe(link.id);
    }
  });
}
