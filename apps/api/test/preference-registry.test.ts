import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  signDelegatedAccessToken,
  type AccessGrant,
  type DelegatedAccessPrincipalKind,
  type Permission,
  type SkillSaveInput,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  withWorkspaceSubjectRls,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import { registerPreferenceRegistryRoutes } from "../src/routes/preference-registry";
import { registerSkillContentRoutes } from "../src/routes/skill-content";

// These are the post-cutover HTTP contracts. Historical text-only migration
// behavior is covered by the DB migration suite, not by resurrecting old routes.
const secret = "preference-registry-test-secret-at-least-32-bytes";
const read: Permission[] = ["workspace:read"];
const workspaceAdmin: Permission[] = [...read, "workspace:admin"];
const accountAdmin: Permission[] = [...workspaceAdmin, "account:admin"];
type Json = Record<string, any>;
type Attempt = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};
let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_PREFERENCE_REGISTRY_TEST_ADMIN_URL;
  const appUrl = process.env.OPENGENI_PREFERENCE_REGISTRY_TEST_APP_URL;
  if (adminUrl && appUrl) {
    await migrate(adminUrl);
    await provisionRoles(adminUrl, { appPassword: decodeURIComponent(new URL(appUrl).password) });
    const admin = postgres(adminUrl, { max: 4 });
    shared = {
      admin,
      adminUrl,
      appUrl,
      release: async () => {
        await admin.end();
      },
    };
  } else {
    const acquired = await acquireSharedTestDatabase("preference-registry");
    if (!acquired) throw new Error("PostgreSQL required for Skill authority tests");
    shared = acquired;
  }
  client = createDb(shared.appUrl);
  app = new Hono();
  const deps = {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
  } as ApiRouteDeps;
  registerPreferenceRegistryRoutes(app, deps);
  registerSkillContentRoutes(app, deps);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function workspace(account: string, name: string, subjectId: string): Promise<AccessGrant> {
  return (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "skill-authority-test",
      accountExternalId: account,
      accountName: "Skill authority test",
      workspaceExternalSource: "skill-authority-test",
      workspaceExternalId: name,
      workspaceName: name,
      subjectId,
    })
  ).workspaceGrants[0]!;
}

async function request(
  grant: AccessGrant,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    permissions?: Permission[];
    principalKind?: DelegatedAccessPrincipalKind;
    subjectId?: string;
    attempt?: Attempt;
  } = {},
) {
  const token = await signDelegatedAccessToken(secret, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: options.subjectId ?? grant.subjectId,
    permissions: options.permissions ?? read,
    principalKind: options.principalKind ?? (options.attempt ? "agent_attempt" : "human_session"),
    ...options.attempt,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return app.request(`http://x/v1/workspaces/${grant.workspaceId}${path}`, {
    method: options.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function json(response: Response, status = 200): Promise<Json> {
  expect(response.status).toBe(status);
  return response.json();
}

function saveRequest(
  scope: "organization" | "workspace" | "user" = "workspace",
  stableKey = `guide-${crypto.randomUUID()}`,
): Omit<SkillSaveInput, "accountId" | "workspaceId" | "actor"> {
  return {
    operationId: crypto.randomUUID(),
    skillId: crypto.randomUUID(),
    expectedRevisionId: null,
    expectedScopeVersion: 1,
    scope,
    stableKey,
    reason: "Create reviewed Skill",
    files: [
      {
        path: "SKILL.md",
        content:
          "---\nname: deployment-guide\ndescription: Use when deploying a service.\n---\nBody-only-sentinel: verify the deployment.\n",
      },
      { path: "references/check.txt", content: "Preserve this supporting file." },
    ],
  };
}

async function save(grant: AccessGrant, input = saveRequest(), permissions = workspaceAdmin) {
  return json(
    await request(grant, "/skills/content/save", { method: "POST", permissions, body: input }),
  );
}

async function seedAttempt(grant: AccessGrant): Promise<Attempt> {
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Skill snapshot test",
    resources: [],
    tools: [],
    metadata: {},
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const executionGeneration = 3;
  const [turn] = await shared.admin<{ id: string }[]>`
    INSERT INTO session_turns (account_id,workspace_id,session_id,trigger_event_id,temporal_workflow_id,
      status,position,prompt,model,reasoning_effort,sandbox_backend,execution_generation,initiator_kind,initiator_subject_id,initiator_context)
    VALUES (${grant.accountId},${grant.workspaceId},${session.id},gen_random_uuid(),${`skill-wf-${crypto.randomUUID()}`},
      'running',0,'Skill snapshot','gpt-5.6-sol','medium','none',${executionGeneration},'subject',${grant.subjectId},'{"accepted":true}'::jsonb)
    RETURNING id`;
  const attemptId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx.unsafe("set local opengeni.session_inference_claim = '1'");
    await tx`UPDATE sessions SET active_turn_id=${turn!.id},status='running' WHERE id=${session.id}`;
    await tx`UPDATE session_turns SET active_attempt_id=${attemptId} WHERE id=${turn!.id}`;
    await tx`INSERT INTO session_turn_attempts (id,account_id,workspace_id,session_id,turn_id,execution_generation,state,
      temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,mcp_approval_policies)
      VALUES (${attemptId},${grant.accountId},${grant.workspaceId},${session.id},${turn!.id},${executionGeneration},'running',
        'skill-wf',${`run-${attemptId}`},${`activity-${attemptId}`},0,'{}'::jsonb)`;
  });
  return { sessionId: session.id, turnId: turn!.id, attemptId, executionGeneration };
}

async function replaceAttempt(attempt: Attempt): Promise<Attempt> {
  const replacementId = crypto.randomUUID();
  const executionGeneration = attempt.executionGeneration + 1;
  await shared.admin.begin(async (tx) => {
    await tx.unsafe("set local opengeni.session_inference_claim = '1'");
    // Match production's session -> turn -> attempt lock order.
    await tx`SELECT id FROM sessions WHERE id=${attempt.sessionId} FOR UPDATE`;
    await tx`SELECT id FROM session_turns WHERE id=${attempt.turnId} FOR UPDATE`;
    await tx`SELECT id FROM session_turn_attempts WHERE id=${attempt.attemptId} FOR UPDATE`;
    await tx`UPDATE session_turn_attempts SET state='closed',outcome='superseded',closed_at=now(),updated_at=now()
      WHERE id=${attempt.attemptId}`;
    await tx`UPDATE session_turns SET execution_generation=${executionGeneration},active_attempt_id=${replacementId},updated_at=now()
      WHERE id=${attempt.turnId}`;
    await tx`INSERT INTO session_turn_attempts (id,account_id,workspace_id,session_id,turn_id,execution_generation,state,
      temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,mcp_approval_policies)
      SELECT ${replacementId},account_id,workspace_id,session_id,turn_id,${executionGeneration},'running',
        temporal_workflow_id,${`replacement-run-${replacementId}`},${`replacement-activity-${replacementId}`},
        verified_control_revision,mcp_approval_policies FROM session_turn_attempts WHERE id=${attempt.attemptId}`;
  });
  return { ...attempt, attemptId: replacementId, executionGeneration };
}

describe("shared Skill HTTP authority and retained history", () => {
  test("requires human scope authority and does not treat machines or keys as humans", async () => {
    const key = crypto.randomUUID();
    const owner = await workspace(key, key, `user:owner-${key}`);
    const input = saveRequest("organization");
    expect(
      (
        await request(owner, "/skills/content/save", {
          method: "POST",
          permissions: workspaceAdmin,
          body: input,
        })
      ).status,
    ).toBe(403);
    expect((await save(owner, input, accountAdmin)).outcome).toBe("applied");
    expect(
      (
        await request(owner, "/skills/content/save", {
          method: "POST",
          permissions: read,
          body: saveRequest(),
        })
      ).status,
    ).toBe(403);
    expect((await save(owner, saveRequest("user"), read)).outcome).toBe("applied");
    const attempt = await seedAttempt(owner);
    for (const machine of [
      { principalKind: "service" as const },
      { principalKind: "agent_attempt" as const, attempt },
      { principalKind: "human_session" as const, subjectId: `api_key:${key}` },
    ]) {
      expect(
        (
          await request(owner, "/skills/content/save", {
            method: "POST",
            permissions: accountAdmin,
            ...machine,
            body: saveRequest("user"),
          })
        ).status,
      ).toBe(403);
    }
    const before = await json(await request(owner, "/skills/content"));
    for (const path of ["proposals", `${input.skillId}/activate`, `${input.skillId}/correct`]) {
      const retired = await json(
        await request(owner, `/preferences/${path}`, {
          method: "POST",
          permissions: accountAdmin,
          body: {},
        }),
        410,
      );
      expect(retired.code).toBe("SKILL_FILE_LIFECYCLE_REQUIRED");
    }
    expect(await json(await request(owner, "/skills/content"))).toEqual(before);
  });

  test("preserves organization, workspace and initiating-human visibility without tenant leaks", async () => {
    const key = crypto.randomUUID();
    const alice = await workspace(key, `${key}-one`, `user:alice-${key}`);
    const aliceOtherWorkspace = await workspace(key, `${key}-two`, alice.subjectId);
    const bob = await workspace(key, `${key}-one`, `user:bob-${key}`);
    const otherAccount = await workspace(`${key}-other`, `${key}-other`, alice.subjectId);
    const organization = saveRequest("organization");
    const local = saveRequest();
    const personal = saveRequest("user");
    await save(alice, organization, accountAdmin);
    await save(alice, local);
    await save(alice, personal, read);
    const ids = async (grant: AccessGrant) =>
      (await json(await request(grant, "/skills/content"))).skills.map((skill: Json) => skill.id);
    expect(await ids(alice)).toEqual(
      expect.arrayContaining([organization.skillId, local.skillId, personal.skillId]),
    );
    expect(await ids(bob)).toEqual(expect.arrayContaining([organization.skillId, local.skillId]));
    expect(await ids(bob)).not.toContain(personal.skillId);
    expect(await ids(aliceOtherWorkspace)).toEqual(
      expect.arrayContaining([organization.skillId, personal.skillId]),
    );
    expect(await ids(aliceOtherWorkspace)).not.toContain(local.skillId);
    expect(await ids(otherAccount)).not.toContain(organization.skillId);
    expect((await request(bob, `/skills/content/${personal.skillId}`)).status).toBe(404);
    expect((await request(aliceOtherWorkspace, `/skills/content/${local.skillId}`)).status).toBe(
      404,
    );
    expect((await request(otherAccount, `/skills/content/${organization.skillId}`)).status).toBe(
      404,
    );
    const rows = await withWorkspaceSubjectRls(
      client.db,
      otherAccount.workspaceId,
      otherAccount.subjectId,
      (tx) =>
        tx.execute(
          sql`SELECT id FROM preference_registry_preferences WHERE id=${organization.skillId}::uuid`,
        ),
    );
    expect(Array.from(rows as Iterable<unknown>)).toHaveLength(0);
    const posture = await shared.admin<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN
      ('preference_registry_preferences','preference_registry_revisions','preference_registry_events','skill_source_bindings','skill_write_receipts')`;
    expect(posture).toHaveLength(5);
    expect(posture.every((table) => table.relrowsecurity && table.relforcerowsecurity)).toBe(true);
  });

  test("retains exact file history and fences saves and restores after a scope change", async () => {
    const key = crypto.randomUUID();
    const owner = await workspace(key, key, `user:owner-${key}`);
    const input = saveRequest();
    const first = await save(owner, input);
    const update = {
      ...input,
      operationId: crypto.randomUUID(),
      expectedRevisionId: first.revisionId,
      files: [{ path: "references/check.txt", content: "Updated checks." }],
    };
    const second = await save(owner, update);
    const historical = await json(
      await request(owner, `/skills/content/${input.skillId}?revisionId=${first.revisionId}`),
    );
    expect(historical.files).toEqual(input.files);
    expect(historical.contentHash).toBe(
      createHash("sha256").update(input.files[0]!.content).digest("hex"),
    );
    expect(historical.title).toBe("deployment-guide");
    await json(
      await request(owner, `/preferences/${input.skillId}/scope`, {
        method: "POST",
        permissions: workspaceAdmin,
        body: { scope: "user", expectedScopeVersion: 1, reason: "Move to personal scope" },
      }),
    );
    const stale = {
      ...update,
      scope: "user",
      expectedRevisionId: second.revisionId,
      operationId: crypto.randomUUID(),
    };
    expect(
      (
        await request(owner, "/skills/content/save", {
          method: "POST",
          permissions: read,
          body: stale,
        })
      ).status,
    ).toBe(409);
    const replacement = saveRequest("user");
    await save(owner, replacement, read);
    for (const action of ["deactivate", "supersede"] as const) {
      expect(
        (
          await request(owner, `/preferences/${input.skillId}/${action}`, {
            method: "POST",
            permissions: read,
            body: {
              expectedCurrentRevisionId: second.revisionId,
              expectedScopeVersion: 1,
              reason: "Stale lifecycle after scope change",
              ...(action === "supersede" ? { replacementPreferenceId: replacement.skillId } : {}),
            },
          })
        ).status,
      ).toBe(409);
    }
    const restore = {
      operationId: crypto.randomUUID(),
      revisionId: first.revisionId,
      expectedRevisionId: second.revisionId,
      expectedScopeVersion: 1,
      reason: "Restore exact original files",
    };
    expect(
      (
        await request(owner, `/skills/content/${input.skillId}/restore`, {
          method: "POST",
          permissions: read,
          body: restore,
        })
      ).status,
    ).toBe(409);
    const restored = await json(
      await request(owner, `/skills/content/${input.skillId}/restore`, {
        method: "POST",
        permissions: read,
        body: { ...restore, operationId: crypto.randomUUID(), expectedScopeVersion: 2 },
      }),
    );
    expect(restored.revisionId).not.toBe(first.revisionId);
    const current = await json(await request(owner, `/skills/content/${input.skillId}`));
    expect(current.files).toEqual(input.files);
    expect(current.scopeVersion).toBe(2);
    const history = await json(await request(owner, `/preferences/${input.skillId}`));
    expect(history.revisions.map((revision: Json) => revision.id)).toEqual(
      expect.arrayContaining([first.revisionId, second.revisionId, restored.revisionId]),
    );
  });

  test("snapshot and full-content reads require the exact live attempt and never expose body text in the index", async () => {
    const key = crypto.randomUUID();
    const owner = await workspace(key, key, `user:owner-${key}`);
    const input = saveRequest("user");
    await save(owner, input, read);
    const attempt = await seedAttempt(owner);
    const actor = { attempt, subjectId: "worker:skill-snapshot" };
    const snapshot = await json(await request(owner, "/preferences/summary", actor));
    expect(snapshot.initiatingHumanSubjectId).toBe(owner.subjectId);
    expect(JSON.stringify(snapshot)).not.toContain("Body-only-sentinel");
    const descriptor = snapshot.descriptors.find((entry: Json) => entry.id === input.skillId);
    expect(descriptor).toBeDefined();
    expect(descriptor.title).toBe("deployment-guide");
    const content = await json(
      await request(owner, "/preferences/full-content", {
        ...actor,
        method: "POST",
        body: { retrievalHandle: descriptor.retrievalHandle },
      }),
    );
    expect(content.content).toBe(input.files[0]!.content);
    for (const wrong of [
      { ...attempt, executionGeneration: attempt.executionGeneration + 1 },
      { ...attempt, turnId: crypto.randomUUID() },
      { ...attempt, attemptId: crypto.randomUUID() },
    ]) {
      expect(
        (await request(owner, "/preferences/summary", { ...actor, attempt: wrong })).status,
      ).toBe(403);
    }
    const other = await workspace(`${key}-other`, `${key}-other`, owner.subjectId);
    expect((await request(other, "/preferences/summary", actor)).status).toBe(403);
    await shared.admin`UPDATE session_turn_attempts SET execution_generation=execution_generation+1 WHERE id=${attempt.attemptId}`;
    expect(
      (
        await request(owner, "/preferences/full-content", {
          ...actor,
          method: "POST",
          body: { retrievalHandle: descriptor.retrievalHandle },
        })
      ).status,
    ).toBe(403);
  });

  test("concurrent snapshots converge and replaced attempts lose access atomically", async () => {
    const key = crypto.randomUUID();
    const owner = await workspace(key, key, `user:owner-${key}`);
    const input = saveRequest("user");
    await save(owner, input, read);
    const attempt = await seedAttempt(owner);
    const actor = { attempt, subjectId: "worker:concurrent-reader" };
    const snapshots = await Promise.all([
      request(owner, "/preferences/summary", actor).then((response) => json(response)),
      request(owner, "/preferences/summary", actor).then((response) => json(response)),
    ]);
    expect(snapshots[0]).toEqual(snapshots[1]);
    const [count] = await shared.admin<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM preference_registry_snapshots
      WHERE account_id=${owner.accountId} AND workspace_id=${owner.workspaceId} AND attempt_id=${attempt.attemptId}`;
    expect(count?.count).toBe(1);
    const descriptor = snapshots[0]!.descriptors.find((entry: Json) => entry.id === input.skillId);
    expect(descriptor).toBeDefined();
    const readContent = () =>
      request(owner, "/preferences/full-content", {
        ...actor,
        method: "POST",
        body: { retrievalHandle: descriptor.retrievalHandle },
      });
    const [racingRead, replacement] = await Promise.all([readContent(), replaceAttempt(attempt)]);
    expect([200, 403]).toContain(racingRead.status);
    expect((await readContent()).status).toBe(403);
    expect((await request(owner, "/preferences/summary", actor)).status).toBe(403);
    const current = await json(
      await request(owner, "/preferences/summary", { ...actor, attempt: replacement }),
    );
    expect(current.attemptId).toBe(replacement.attemptId);
    expect(current.executionGeneration).toBe(replacement.executionGeneration);
  });
});
