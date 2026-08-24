// Step 2 of Slack workspace routing: the pure `packages/db` resolver library.
// Nothing wires these into the Slack pump yet, so these tests are the whole
// proof. The two that matter most are the candidate set (a personal workspace
// has no `workspace_memberships` row, so a bare membership join denies its own
// owner) and `resolveSlackTargetAuthority` (the ONLY place a Slack request may
// mint personal-workspace access, and it must refuse another subject's).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  createDb,
  createWorkspace,
  deleteSlackChannelRoute,
  deleteSlackUserDmRoute,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getSlackChannelRoute,
  getSlackUserDmRoute,
  grantWorkspaceAccess,
  listSlackRoutableWorkspacesForSubject,
  managedPersonalWorkspacePermissions,
  personalWorkspaceIdForSubject,
  probeSlackInteractionTenancy,
  resolveSlackTargetAuthority,
  upsertSlackChannelRoute,
  upsertSlackUserDmRoute,
  type DbClient,
  type SlackRouteHome,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

type ProvisionedHuman = {
  subjectId: string;
  accountId: string;
  sharedWorkspaceId: string;
  personalWorkspaceId: string;
  membershipId: string;
};

async function provisionHuman(prefix: string): Promise<ProvisionedHuman> {
  if (!client) throw new Error("database unavailable");
  const userId = `${prefix}-${crypto.randomUUID()}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: prefix,
  });
  const access = provisioned.accessContext;
  const sharedGrant = access.workspaceGrants.find(
    (grant) => grant.workspaceId === access.defaultWorkspaceId,
  );
  const membership = provisioned.organizationMemberships[0];
  if (!sharedGrant || !membership?.personalWorkspaceId) {
    throw new Error("organization authority missing");
  }
  return {
    subjectId: `user:${userId}`,
    accountId: sharedGrant.accountId,
    sharedWorkspaceId: sharedGrant.workspaceId,
    personalWorkspaceId: membership.personalWorkspaceId,
    membershipId: membership.id,
  };
}

/** A Slack connection owned by the home workspace, which every route FKs to. */
async function seedConnection(home: SlackRouteHome): Promise<string> {
  if (!shared) throw new Error("database unavailable");
  const [row] = await shared.admin<Array<{ id: string }>>`
    insert into connections (account_id, workspace_id, provider_domain, kind, credential_encrypted)
    values (${home.accountId}, ${home.workspaceId}, 'routing.test', 'app_install', 'sealed')
    returning id`;
  if (!row) throw new Error("connection seed returned no row");
  return row.id;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("slack-routing-resolvers");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("[slack-routing] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable");
    }
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("listSlackRoutableWorkspacesForSubject", () => {
  test("offers writable memberships plus the subject's own personal workspace", async () => {
    if (!client) return;
    const human = await provisionHuman("candidates");

    // A membership that can only read is not a place work can start.
    const readOnly = await createWorkspace(client.db, {
      accountId: human.accountId,
      name: "Read Only",
    });
    await grantWorkspaceAccess(client.db, {
      accountId: human.accountId,
      workspaceId: readOnly.id,
      subjectId: human.subjectId,
      permissions: ["workspace:read", "sessions:read"],
    });

    // An explicit `sessions:create` membership is.
    const writable = await createWorkspace(client.db, {
      accountId: human.accountId,
      name: "Writable",
    });
    await grantWorkspaceAccess(client.db, {
      accountId: human.accountId,
      workspaceId: writable.id,
      subjectId: human.subjectId,
      permissions: ["workspace:read", "sessions:create"],
    });

    // A workspace in the same account the subject has no membership in at all.
    const unrelated = await createWorkspace(client.db, {
      accountId: human.accountId,
      name: "Unrelated",
    });

    const candidates = await listSlackRoutableWorkspacesForSubject(client.db, {
      accountId: human.accountId,
      subjectId: human.subjectId,
    });
    const byId = new Map(candidates.map((candidate) => [candidate.workspaceId, candidate]));

    expect(byId.has(writable.id)).toBe(true);
    expect(byId.get(writable.id)?.personal).toBe(false);
    // The personal workspace has NO `workspace_memberships` row; a bare
    // membership join would deny the one human who always belongs.
    expect(byId.get(human.personalWorkspaceId)?.personal).toBe(true);
    expect(byId.has(human.sharedWorkspaceId)).toBe(true);
    expect(byId.has(readOnly.id)).toBe(false);
    expect(byId.has(unrelated.id)).toBe(false);
    for (const candidate of candidates) {
      expect(candidate.accountId).toBe(human.accountId);
    }
  });

  test("never leaks another organization or another subject's personal workspace", async () => {
    if (!client) return;
    const human = await provisionHuman("scoped");
    const stranger = await provisionHuman("stranger");

    const candidates = await listSlackRoutableWorkspacesForSubject(client.db, {
      accountId: human.accountId,
      subjectId: human.subjectId,
    });
    const ids = candidates.map((candidate) => candidate.workspaceId);
    expect(ids).not.toContain(stranger.personalWorkspaceId);
    expect(ids).not.toContain(stranger.sharedWorkspaceId);

    // Asking about an organization the subject does not belong to yields nothing.
    await expect(
      listSlackRoutableWorkspacesForSubject(client.db, {
        accountId: stranger.accountId,
        subjectId: human.subjectId,
      }),
    ).resolves.toEqual([]);
  });

  test("orders stably by label then workspace id", async () => {
    if (!client) return;
    const human = await provisionHuman("ordering");
    for (const name of ["Zulu", "Alpha", "Mike"]) {
      const workspace = await createWorkspace(client.db, {
        accountId: human.accountId,
        name,
      });
      await grantWorkspaceAccess(client.db, {
        accountId: human.accountId,
        workspaceId: workspace.id,
        subjectId: human.subjectId,
        permissions: ["sessions:create"],
      });
    }
    const candidates = await listSlackRoutableWorkspacesForSubject(client.db, {
      accountId: human.accountId,
      subjectId: human.subjectId,
    });
    const labels = candidates.map((candidate) => candidate.label);
    // Asserting only `labels === labels.sort()` is vacuous on a shrunken or
    // empty result, so pin the expected set too.
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(labels).toEqual([...labels].sort());
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("leaves the caller's subject scope untouched after probing another subject", async () => {
    if (!client) return;
    const human = await provisionHuman("guc");
    const other = await provisionHuman("guc-other");
    const observed = await client.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('opengeni.account_id', ${human.accountId}, true),
                   set_config('opengeni.workspace_id', ${human.sharedWorkspaceId}, true),
                   set_config('opengeni.subject_id', ${human.subjectId}, true)`,
      );
      await personalWorkspaceIdForSubject(tx, {
        accountId: other.accountId,
        subjectId: other.subjectId,
      });
      const rows = await tx.execute<{ subject: string | null }>(
        sql`select nullif(current_setting('opengeni.subject_id', true), '') as subject`,
      );
      return (rows as unknown as Array<{ subject: string | null }>)[0]?.subject ?? null;
    });
    expect(observed).toBe(human.subjectId);
  });

  test("short-circuits a non-human subject rather than tripping the membership guard", async () => {
    if (!client) return;
    const human = await provisionHuman("machine");
    await expect(
      listSlackRoutableWorkspacesForSubject(client.db, {
        accountId: human.accountId,
        subjectId: `api_key:${crypto.randomUUID()}`,
      }),
    ).resolves.toEqual([]);
  });
});

describe("resolveSlackTargetAuthority", () => {
  test("returns the ordinary membership grant when one exists", async () => {
    if (!client) return;
    const human = await provisionHuman("membership-grant");
    const grant = await resolveSlackTargetAuthority(client.db, {
      subjectId: human.subjectId,
      targetAccountId: human.accountId,
      targetWorkspaceId: human.sharedWorkspaceId,
    });
    expect(grant).toMatchObject({
      workspaceId: human.sharedWorkspaceId,
      accountId: human.accountId,
      subjectId: human.subjectId,
      principalKind: "human_session",
    });
    expect(grant?.permissions).toContain("sessions:create");
  });

  test("mints the personal-workspace grant only for its own owner", async () => {
    if (!client) return;
    const human = await provisionHuman("personal-grant");
    const stranger = await provisionHuman("personal-stranger");

    const own = await resolveSlackTargetAuthority(client.db, {
      subjectId: human.subjectId,
      targetAccountId: human.accountId,
      targetWorkspaceId: human.personalWorkspaceId,
    });
    expect(own).toEqual({
      workspaceId: human.personalWorkspaceId,
      accountId: human.accountId,
      subjectId: human.subjectId,
      permissions: managedPersonalWorkspacePermissions,
      principalKind: "human_session",
    });

    // Another subject's personal workspace is never reachable, even naming the
    // correct owning account.
    await expect(
      resolveSlackTargetAuthority(client.db, {
        subjectId: human.subjectId,
        targetAccountId: stranger.accountId,
        targetWorkspaceId: stranger.personalWorkspaceId,
      }),
    ).resolves.toBeNull();

    // A workspace id that is not the pointer is refused even inside the
    // subject's own active organization: the id must equal the derived pointer.
    const decoy = await createWorkspace(client.db, {
      accountId: human.accountId,
      name: "Decoy",
    });
    await expect(
      resolveSlackTargetAuthority(client.db, {
        subjectId: human.subjectId,
        targetAccountId: human.accountId,
        targetWorkspaceId: decoy.id,
      }),
    ).resolves.toBeNull();
  });

  test("refuses a non-human principal and an account that does not own the workspace", async () => {
    if (!client) return;
    const human = await provisionHuman("refusals");

    await expect(
      resolveSlackTargetAuthority(client.db, {
        subjectId: `api_key:${crypto.randomUUID()}`,
        targetAccountId: human.accountId,
        targetWorkspaceId: human.personalWorkspaceId,
      }),
    ).resolves.toBeNull();

    const other = await provisionHuman("refusals-other");
    await expect(
      resolveSlackTargetAuthority(client.db, {
        subjectId: human.subjectId,
        targetAccountId: other.accountId,
        targetWorkspaceId: human.sharedWorkspaceId,
      }),
    ).resolves.toBeNull();
  });

  test("stops minting the grant once the organization membership is no longer active", async () => {
    if (!client || !shared) return;
    const human = await provisionHuman("suspended");
    await expect(
      resolveSlackTargetAuthority(client.db, {
        subjectId: human.subjectId,
        targetAccountId: human.accountId,
        targetWorkspaceId: human.personalWorkspaceId,
      }),
    ).resolves.not.toBeNull();

    await shared.admin`
      update organization_memberships set status = 'suspended' where id = ${human.membershipId}`;

    await expect(
      resolveSlackTargetAuthority(client.db, {
        subjectId: human.subjectId,
        targetAccountId: human.accountId,
        targetWorkspaceId: human.personalWorkspaceId,
      }),
    ).resolves.toBeNull();
  });
});

describe("probeSlackInteractionTenancy", () => {
  test("crosses workspaces on the connection-global route key and returns ids only", async () => {
    if (!client || !shared) return;
    const human = await provisionHuman("probe");
    const home: SlackRouteHome = {
      accountId: human.accountId,
      workspaceId: human.sharedWorkspaceId,
    };
    const connectionId = await seedConnection(home);
    const target = await createWorkspace(client.db, {
      accountId: human.accountId,
      name: "Probe Target",
    });
    const routeKey = `probe-${crypto.randomUUID()}`;

    const [interaction] = await shared.admin<Array<{ id: string }>>`
      insert into slack_interactions (
        account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
        slack_thread_ts, route_key, triggering_provider_event_id, owning_subject_id, visibility
      ) values (
        ${human.accountId}, ${target.id}, ${connectionId}, 'T-PROBE', 'C-PROBE',
        '1700000000.0003', ${routeKey}, 'Ev-probe', ${human.subjectId}, 'workspace'
      ) returning id`;

    // The caller here is scoped nowhere near the target workspace; the probe is
    // what makes thread continuation work across a routed workspace at all.
    const probed = await probeSlackInteractionTenancy(client.db, { connectionId, routeKey });
    expect(probed).toEqual({
      accountId: human.accountId,
      workspaceId: target.id,
      interactionId: interaction?.id ?? "",
    });
    // Ids only: no text, no subject, no session content.
    expect(Object.keys(probed ?? {}).sort()).toEqual(["accountId", "interactionId", "workspaceId"]);

    await expect(
      probeSlackInteractionTenancy(client.db, { connectionId, routeKey: "absent" }),
    ).resolves.toBeNull();
  });
});

describe("route reads and writes", () => {
  test("remembers a channel answer idempotently and bumps its version", async () => {
    if (!client) return;
    const human = await provisionHuman("channel-route");
    const home: SlackRouteHome = {
      accountId: human.accountId,
      workspaceId: human.sharedWorkspaceId,
    };
    const connectionId = await seedConnection(home);
    const target = await createWorkspace(client.db, {
      accountId: human.accountId,
      name: "Channel Target",
    });
    const rerouted = await createWorkspace(client.db, {
      accountId: human.accountId,
      name: "Channel Rerouted",
    });

    await expect(
      getSlackChannelRoute(client.db, home, { connectionId, slackChannelId: "C-ROUTE" }),
    ).resolves.toBeNull();

    const first = await upsertSlackChannelRoute(client.db, home, {
      connectionId,
      slackTeamId: "T-ROUTE",
      slackChannelId: "C-ROUTE",
      targetAccountId: human.accountId,
      targetWorkspaceId: target.id,
      decidedBySubjectId: human.subjectId,
      decidedBySlackUserId: "U-ROUTE",
      source: "picker",
    });
    expect(first).toMatchObject({
      accountId: human.accountId,
      workspaceId: human.sharedWorkspaceId,
      targetWorkspaceId: target.id,
      source: "picker",
      version: 1,
    });

    const second = await upsertSlackChannelRoute(client.db, home, {
      connectionId,
      slackTeamId: "T-ROUTE",
      slackChannelId: "C-ROUTE",
      targetAccountId: human.accountId,
      targetWorkspaceId: rerouted.id,
      decidedBySubjectId: human.subjectId,
      decidedBySlackUserId: "U-ROUTE",
      source: "admin",
    });
    // Re-pointing a channel replaces the one answer; it never forks a second row.
    expect(second).toMatchObject({
      id: first.id,
      targetWorkspaceId: rerouted.id,
      source: "admin",
      version: 2,
    });

    await expect(
      getSlackChannelRoute(client.db, home, { connectionId, slackChannelId: "C-ROUTE" }),
    ).resolves.toMatchObject({ id: first.id, targetWorkspaceId: rerouted.id, version: 2 });

    // The "ask me" affordance clears the memory.
    await expect(
      deleteSlackChannelRoute(client.db, home, { connectionId, slackChannelId: "C-ROUTE" }),
    ).resolves.toBe(true);
    await expect(
      deleteSlackChannelRoute(client.db, home, { connectionId, slackChannelId: "C-ROUTE" }),
    ).resolves.toBe(false);
    await expect(
      getSlackChannelRoute(client.db, home, { connectionId, slackChannelId: "C-ROUTE" }),
    ).resolves.toBeNull();
  });

  test("keeps DM answers per Slack human and invisible to a sibling home workspace", async () => {
    if (!client) return;
    const human = await provisionHuman("dm-route");
    const home: SlackRouteHome = {
      accountId: human.accountId,
      workspaceId: human.sharedWorkspaceId,
    };
    const connectionId = await seedConnection(home);

    await upsertSlackUserDmRoute(client.db, home, {
      connectionId,
      slackTeamId: "T-DM",
      slackUserId: "U-DM",
      targetAccountId: human.accountId,
      targetWorkspaceId: human.personalWorkspaceId,
      decidedBySubjectId: human.subjectId,
      decidedBySlackUserId: "U-DM",
      source: "picker",
    });

    await expect(
      getSlackUserDmRoute(client.db, home, { connectionId, slackUserId: "U-DM" }),
    ).resolves.toMatchObject({ targetWorkspaceId: human.personalWorkspaceId, version: 1 });
    await expect(
      getSlackUserDmRoute(client.db, home, { connectionId, slackUserId: "U-OTHER" }),
    ).resolves.toBeNull();

    // Routing rows carry HOME tenancy, so a sibling workspace in the same
    // organization cannot see another installation's answers.
    const sibling = await createWorkspace(client.db, {
      accountId: human.accountId,
      name: "Sibling Home",
    });
    await expect(
      getSlackUserDmRoute(
        client.db,
        { accountId: human.accountId, workspaceId: sibling.id },
        { connectionId, slackUserId: "U-DM" },
      ),
    ).resolves.toBeNull();

    await expect(
      deleteSlackUserDmRoute(client.db, home, { connectionId, slackUserId: "U-DM" }),
    ).resolves.toBe(true);
  });
});
