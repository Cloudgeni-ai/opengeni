import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  changePreferenceRegistryScope,
  createDb,
  createWorkspace,
  listSkillDescriptors,
  updateOrganizationSkillReach,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { listSkills, readSkill, saveSkill } from "../src/domain/skills";

// An organization Skill works in the workspaces its organization picks
// (migration 1195): agents elsewhere never see it, people still find it.

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("organization-skill-reach");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1")
    throw new Error("PostgreSQL required");
  if (shared) client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const skillFile = (name: string) => ({
  path: "SKILL.md",
  content: `---\nname: ${name}\ndescription: Reach test Skill\n---\nDo the thing.`,
});

/** An organization with shared workspaces A (where the owner works), B and C,
 * a member's Personal workspace P, and an organization Skill saved in A. */
async function organization() {
  const key = crypto.randomUUID();
  const owner = `user:reach-${key}`;
  const grant = (
    await bootstrapWorkspace(client!.db, {
      accountExternalSource: "test",
      accountExternalId: key,
      accountName: "Reach test",
      workspaceExternalSource: "test",
      workspaceExternalId: key,
      workspaceName: "A",
      subjectId: owner,
    })
  ).workspaceGrants[0]!;
  const accountId = grant.accountId;
  const b = await createWorkspace(client!.db, { accountId, name: "B" });
  const c = await createWorkspace(client!.db, { accountId, name: "C" });
  const p = await createWorkspace(client!.db, { accountId, name: "Personal" });
  await shared!.admin`
    insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${accountId}, ${`user:member-${key}`}, 'active', ${p.id})`;
  const human = {
    accountId,
    workspaceId: grant.workspaceId,
    actor: { kind: "human", subjectId: owner, principalKind: "human_session" } as const,
  };
  const save = async (scope: "organization" | "workspace", name: string) =>
    await saveSkill(client!.db, {
      ...human,
      operationId: crypto.randomUUID(),
      skillId: crypto.randomUUID(),
      expectedRevisionId: null,
      expectedScopeVersion: 1,
      stableKey: `${name}-${key}`,
      scope,
      files: [skillFile(name)],
      reason: "Reach test",
    });
  const skill = await save("organization", "shared-procedure");
  return {
    accountId,
    owner,
    a: grant.workspaceId,
    b: b.id,
    c: c.id,
    p: p.id,
    skillId: skill.skillId,
    save,
  };
}

type Org = Awaited<ReturnType<typeof organization>>;

async function agentsSee(org: Org, workspaceId: string): Promise<boolean> {
  const descriptors = await listSkillDescriptors(client!.db, {
    accountId: org.accountId,
    workspaceId,
  });
  return descriptors.some((entry) => entry.id === org.skillId);
}

async function where(org: Org): Promise<Record<"a" | "b" | "c" | "p", boolean>> {
  return {
    a: await agentsSee(org, org.a),
    b: await agentsSee(org, org.b),
    c: await agentsSee(org, org.c),
    p: await agentsSee(org, org.p),
  };
}

function reach(org: Org, allowedWorkspaceIds: string[] | null, allowPersonalWorkspaces: boolean) {
  return updateOrganizationSkillReach(client!.db, {
    accountId: org.accountId,
    workspaceId: org.a,
    subjectId: org.owner,
    skillId: org.skillId,
    allowedWorkspaceIds,
    allowPersonalWorkspaces,
  });
}

describe("organization Skill reach", () => {
  test("works everywhere until the organization picks, then only where it picked", async () => {
    if (!client) return;
    const org = await organization();
    expect(await where(org)).toEqual({ a: true, b: true, c: true, p: true });

    expect(await reach(org, [org.b], false)).toEqual({
      status: "updated",
      reach: { allowedWorkspaceIds: [org.b], allowPersonalWorkspaces: false },
    });
    expect(await where(org)).toEqual({ a: false, b: true, c: false, p: false });

    await reach(org, [], true);
    expect(await where(org)).toEqual({ a: false, b: false, c: false, p: true });

    await reach(org, null, false);
    expect(await where(org)).toEqual({ a: true, b: true, c: true, p: false });

    const [audit] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where account_id=${org.accountId} and action='skill.reach.changed' and target_id=${org.skillId}`;
    expect(audit!.count).toBe(3);
  });

  test("people still find it where agents don't use it, marked as not used there", async () => {
    if (!client) return;
    const org = await organization();
    await reach(org, [org.b], true);
    const inC = { accountId: org.accountId, workspaceId: org.c, subjectId: org.owner };

    expect(await readSkill(client.db, inC, org.skillId)).toBeNull();
    expect((await listSkills(client.db, inC)).map((skill) => skill.id)).not.toContain(org.skillId);

    const listed = (await listSkills(client.db, inC, { includeOrganizationElsewhere: true })).find(
      (skill) => skill.id === org.skillId,
    );
    expect(listed?.availableHere).toBe(false);
    expect(listed?.reach).toEqual({ allowedWorkspaceIds: [org.b], allowPersonalWorkspaces: true });

    const inB = { accountId: org.accountId, workspaceId: org.b, subjectId: org.owner };
    const opened = await readSkill(client.db, inB, org.skillId);
    expect(opened?.availableHere).toBe(true);
    expect(opened?.files.map((file) => file.path)).toEqual(["SKILL.md"]);

    const workspaceSkill = await org.save("workspace", "team-only");
    const team = await readSkill(
      client.db,
      { accountId: org.accountId, workspaceId: org.a },
      workspaceSkill.skillId,
    );
    expect(team?.reach).toBeNull();
    expect(team?.availableHere).toBe(true);
  });

  test("refuses workspaces outside the organization's shared ones, and non-organization Skills", async () => {
    if (!client) return;
    const org = await organization();
    const stranger = crypto.randomUUID();
    expect(await reach(org, [org.b, org.p, stranger], true)).toEqual({
      status: "unknown_workspaces",
      workspaceIds: [org.p, stranger].sort(),
    });
    const workspaceSkill = await org.save("workspace", "team-only");
    expect(
      await updateOrganizationSkillReach(client.db, {
        accountId: org.accountId,
        workspaceId: org.a,
        subjectId: org.owner,
        skillId: workspaceSkill.skillId,
        allowedWorkspaceIds: null,
        allowPersonalWorkspaces: true,
      }),
    ).toEqual({ status: "not_organization" });
    expect(
      await updateOrganizationSkillReach(client.db, {
        accountId: org.accountId,
        workspaceId: org.a,
        subjectId: org.owner,
        skillId: crypto.randomUUID(),
        allowedWorkspaceIds: null,
        allowPersonalWorkspaces: true,
      }),
    ).toEqual({ status: "not_found" });
    expect(await where(org)).toEqual({ a: true, b: true, c: true, p: true });
  });

  test("moving it out of the organization drops its reach; moving it back starts at everywhere", async () => {
    if (!client) return;
    const org = await organization();
    await reach(org, [org.b], false);
    const move = async (scope: "workspace" | "organization", expectedScopeVersion: number) =>
      await changePreferenceRegistryScope(client!.db, {
        accountId: org.accountId,
        workspaceId: org.a,
        actorSubjectId: org.owner,
        principalKind: "human_session",
        preferenceId: org.skillId,
        scope,
        expectedScopeVersion,
        authorizeScope: () => undefined,
        reason: "Reach test move",
      });
    const toWorkspace = await move("workspace", 1);
    const [rows] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from organization_skill_reach where preference_id=${org.skillId}`;
    expect(rows!.count).toBe(0);
    await move("organization", toWorkspace.preference.scopeVersion);
    expect(await where(org)).toEqual({ a: true, b: true, c: true, p: true });
  });
});
