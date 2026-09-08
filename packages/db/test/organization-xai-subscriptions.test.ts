import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  createDb,
  type DbClient,
  upsertOrganizationXaiSubscription,
  listOrganizationXaiSubscriptions,
  updateOrganizationXaiSubscription,
  updateOrganizationXaiRotation,
  listXaiSubscriptionAccountsMetadata,
  materializeXaiCredentialForRun,
  resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
  createXaiSubscriptionCredential,
  withWorkspaceSubjectRls,
  getXaiRotationSettings,
  refreshXaiSubscriptionCredentialSerialized,
  acquireXaiCredentialLease,
  releaseXaiCredentialLease,
  withSessionActivityRlsContext,
  getModelConnectionAccess,
  updateModelConnectionAccess,
  assertModelConnectionAllowsTurn,
  getWorkspaceConnectionModelRestrictions,
  modelAllowedByConnections,
  upsertOrganizationCodexSubscriptionCredential,
  updateOrganizationCodexRotationSettings,
  listCodexAccountStatuses,
  upsertOrganizationModelProviderConnection,
  organizationModelProviderConnectionActiveForWorkspace,
  getCodexRotationSettings,
  getCodexCredentialStatus,
  getOrganizationCodexRotationSettings,
  selectXaiCredentialForUse,
  setXaiSessionAccountPin,
  upsertWorkspaceVercelAiGatewayConnection,
  upsertWorkspaceOpenRouterConnection,
} from "../src";

const realTest = test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1");
let shared: SharedTestDatabase;
let client: DbClient;
const encryptionKey = new Uint8Array(32).fill(41);
const organizationSnapshot = { version: 1, scope: "organization" } as const;

realTest(
  "connection access restricts shared and Personal workspaces independently and blocks exact model use",
  async () => {
    const setup = await fixture();
    const { account } = await connect(setup, "restricted-models");
    const target = {
      accountId: setup.organizationId,
      workspaceId: null,
      subjectId: setup.actorSubjectId,
      kind: "supergrok" as const,
      connectionId: account.id,
    };
    const initial = await getModelConnectionAccess(client.db, target);
    expect(initial).toEqual({
      allowedModels: null,
      allowedWorkspaces: null,
      allowPersonalWorkspaces: true,
      version: 1,
    });
    const updated = await updateModelConnectionAccess(client.db, target, {
      ...initial!,
      allowedModels: ["supergrok/allowed"],
      allowedWorkspaces: [setup.workspaceId],
      allowPersonalWorkspaces: false,
    });
    expect(updated?.version).toBe(2);
    expect(
      await updateModelConnectionAccess(client.db, target, { ...initial!, allowedModels: [] }),
    ).toBeNull();
    expect(
      await listXaiSubscriptionAccountsMetadata(client.db, {
        workspaceId: setup.personalWorkspaceId,
        subjectId: setup.actorSubjectId,
      }),
    ).toEqual([]);
    const run = {
      workspaceId: setup.workspaceId,
      subjectId: setup.actorSubjectId,
      xaiCredentialId: account.id,
    };
    await assertModelConnectionAllowsTurn(client.db, { ...run, modelId: "supergrok/allowed" });
    await expect(
      assertModelConnectionAllowsTurn(client.db, { ...run, modelId: "supergrok/blocked" }),
    ).rejects.toThrow("disabled");
    const restrictions = await getWorkspaceConnectionModelRestrictions(
      client.db,
      setup.workspaceId,
      setup.actorSubjectId,
    );
    expect(modelAllowedByConnections(restrictions, "supergrok/allowed")).toBe(true);
    expect(modelAllowedByConnections(restrictions, "supergrok/blocked")).toBe(false);
    const denied = await updateModelConnectionAccess(client.db, target, {
      ...updated!,
      allowedWorkspaces: [],
      allowPersonalWorkspaces: true,
    });
    expect(denied?.version).toBe(3);
    expect(
      await listXaiSubscriptionAccountsMetadata(client.db, {
        workspaceId: setup.workspaceId,
        subjectId: setup.actorSubjectId,
      }),
    ).toEqual([]);
    expect(
      (
        await listXaiSubscriptionAccountsMetadata(client.db, {
          workspaceId: setup.personalWorkspaceId,
          subjectId: setup.actorSubjectId,
        })
      ).map((row) => row.id),
    ).toEqual([account.id]);
    await expect(
      assertModelConnectionAllowsTurn(client.db, { ...run, modelId: "supergrok/allowed" }),
    ).rejects.toThrow("disabled");
    expect((await listOrganizationXaiSubscriptions(client.db, setup)).accounts).toHaveLength(1);
    const other = await fixture();
    await expect(
      updateModelConnectionAccess(client.db, target, {
        ...denied!,
        allowedWorkspaces: [other.workspaceId],
      }),
    ).rejects.toThrow("not in this organization");
  },
);

realTest("workspace administrators cannot change inherited connection policy columns", async () => {
  const setup = await fixture();
  const { account } = await connect(setup, "org-policy-authority");
  await expect(
    withWorkspaceSubjectRls(client.db, setup.workspaceId, setup.actorSubjectId, (tx) =>
      tx.execute(sql`
    update xai_subscription_credentials set allowed_model_ids = ARRAY[]::text[], access_policy_version = 2,
      access_policy_updated_by = ${setup.actorSubjectId}, access_policy_updated_at = now() where id = ${account.id}::uuid
  `),
    ),
  ).rejects.toThrow();
  expect(
    await getModelConnectionAccess(client.db, {
      accountId: setup.organizationId,
      workspaceId: setup.workspaceId,
      subjectId: setup.actorSubjectId,
      kind: "supergrok",
      connectionId: account.id,
    }),
  ).toBeNull();
});

realTest(
  "Codex and both organization gateways enforce the same workspace and model policy",
  async () => {
    for (const kind of ["codex", "vercel_gateway", "openrouter"] as const) {
      const setup = await fixture();
      const connectionId =
        kind === "codex"
          ? (
              await upsertOrganizationCodexSubscriptionCredential(client.db, {
                ...setup,
                credentialEncrypted: "test-encrypted-envelope",
                chatgptAccountId: "account",
                scopes: null,
                planType: "team",
                isFedramp: false,
                expiresAt: null,
                lastRefreshAt: null,
              })
            ).id
          : "current";
      if (kind !== "codex")
        await upsertOrganizationModelProviderConnection(client.db, {
          ...setup,
          providerKind: kind,
          credentialEncrypted: "test-encrypted-envelope",
          credentialDigest: "a".repeat(64),
          operationId: crypto.randomUUID(),
        });
      const target = {
        accountId: setup.organizationId,
        subjectId: setup.actorSubjectId,
        workspaceId: null,
        kind,
        connectionId,
      };
      const initial = await getModelConnectionAccess(client.db, target);
      expect(initial?.allowedWorkspaces).toBeNull();
      const modelId =
        kind === "codex"
          ? "codex/allowed"
          : `organization-${kind === "vercel_gateway" ? "gateway" : "openrouter"}/allowed`;
      const policy = await updateModelConnectionAccess(client.db, target, {
        ...initial!,
        allowedModels: [modelId],
      });
      const run = {
        workspaceId: setup.workspaceId,
        subjectId: setup.actorSubjectId,
        codexCredentialId: connectionId,
      };
      await assertModelConnectionAllowsTurn(client.db, { ...run, modelId });
      await expect(
        assertModelConnectionAllowsTurn(client.db, {
          ...run,
          modelId: modelId.replace("allowed", "blocked"),
        }),
      ).rejects.toThrow("disabled");
      await updateModelConnectionAccess(client.db, target, {
        ...policy!,
        allowedWorkspaces: [],
        allowPersonalWorkspaces: false,
      });
      if (kind === "codex")
        expect(await listCodexAccountStatuses(client.db, setup.workspaceId)).toEqual([]);
      else
        expect(
          await organizationModelProviderConnectionActiveForWorkspace(client.db, {
            accountId: setup.organizationId,
            workspaceId: setup.workspaceId,
            providerKind: kind,
          }),
        ).toBe(false);
      await expect(assertModelConnectionAllowsTurn(client.db, { ...run, modelId })).rejects.toThrow(
        "disabled",
      );
      expect((await getModelConnectionAccess(client.db, target))?.version).toBe(3);
    }
  },
);

realTest(
  "each workspace gets a usable default from its assigned organization subscriptions",
  async () => {
    const setup = await fixture();
    const first = (await connect(setup, "default-unassigned")).account;
    const second = (await connect(setup, "default-assigned")).account;
    const target = {
      accountId: setup.organizationId,
      subjectId: setup.actorSubjectId,
      workspaceId: null,
      kind: "supergrok" as const,
      connectionId: first.id,
    };
    const policy = await getModelConnectionAccess(client.db, target);
    await updateModelConnectionAccess(client.db, target, { ...policy!, allowedWorkspaces: [] });
    const source = {
      workspaceId: setup.workspaceId,
      subjectId: setup.actorSubjectId,
      authoritySnapshot: organizationSnapshot,
    };
    expect((await getXaiRotationSettings(client.db, source))?.activeCredentialId).toBe(second.id);
    expect(
      (
        await selectXaiCredentialForUse(client.db, {
          ...source,
          accountId: setup.organizationId,
          shardKey: "assigned-test",
          modelId: "supergrok/allowed",
        })
      ).credentialId,
    ).toBe(second.id);
    const codex = [];
    for (const identity of ["first", "second"])
      codex.push(
        await upsertOrganizationCodexSubscriptionCredential(client.db, {
          ...setup,
          credentialEncrypted: "test-encrypted-envelope",
          chatgptAccountId: identity,
          scopes: null,
          planType: "team",
          isFedramp: false,
          expiresAt: null,
          lastRefreshAt: null,
        }),
      );
    const codexTarget = { ...target, kind: "codex" as const, connectionId: codex[0]!.id };
    const codexPolicy = await getModelConnectionAccess(client.db, codexTarget);
    await updateModelConnectionAccess(client.db, codexTarget, {
      ...codexPolicy!,
      allowedWorkspaces: [],
    });
    expect((await getCodexRotationSettings(client.db, setup.workspaceId))?.activeCredentialId).toBe(
      codex[1]!.id,
    );
    expect(
      (await listCodexAccountStatuses(client.db, setup.workspaceId)).find((row) => row.isActive)
        ?.id,
    ).toBe(codex[1]!.id);
    expect((await getCodexCredentialStatus(client.db, setup.workspaceId))?.credentialId).toBe(
      codex[1]!.id,
    );
    expect((await getOrganizationCodexRotationSettings(client.db, setup))?.activeCredentialId).toBe(
      codex[0]!.id,
    );
  },
);

realTest("catalog uses the active subscription unless rotation enables the pool", async () => {
  for (const kind of ["codex", "supergrok"] as const) {
    const setup = await fixture();
    for (const name of ["first", "second"]) {
      const id =
        kind === "supergrok"
          ? (await connect(setup, name)).account.id
          : (
              await upsertOrganizationCodexSubscriptionCredential(client.db, {
                ...setup,
                credentialEncrypted: "test-envelope",
                chatgptAccountId: name,
                scopes: null,
                planType: "team",
                isFedramp: false,
                expiresAt: null,
                lastRefreshAt: null,
              })
            ).id;
      const target = {
        accountId: setup.organizationId,
        workspaceId: null,
        subjectId: setup.actorSubjectId,
        kind,
        connectionId: id,
      };
      const policy = await getModelConnectionAccess(client.db, target);
      await updateModelConnectionAccess(client.db, target, {
        ...policy!,
        allowedModels: [`${kind}/${name}`],
      });
    }
    const read = () =>
      getWorkspaceConnectionModelRestrictions(client.db, setup.workspaceId, setup.actorSubjectId);
    const prefix = `${kind}/`;
    expect((await read())[prefix]).toEqual([`${kind}/first`]);
    await (
      kind === "codex" ? updateOrganizationCodexRotationSettings : updateOrganizationXaiRotation
    )(client.db, { ...setup, rotationEnabled: true });
    expect((await read())[prefix]?.sort()).toEqual([`${kind}/first`, `${kind}/second`]);
    await (
      kind === "codex" ? updateOrganizationCodexRotationSettings : updateOrganizationXaiRotation
    )(client.db, { ...setup, rotationEnabled: false });
    expect((await read())[prefix]).toEqual([`${kind}/first`]);
  }
});

realTest(
  "workspace gateways keep access policy on the actual connection without changing key revision",
  async () => {
    for (const kind of ["vercel_gateway", "openrouter"] as const) {
      const setup = await fixture();
      const create =
        kind === "vercel_gateway"
          ? upsertWorkspaceVercelAiGatewayConnection
          : upsertWorkspaceOpenRouterConnection;
      const row = await create(client.db, {
        accountId: setup.organizationId,
        workspaceId: setup.workspaceId,
        updatedBySubjectId: setup.actorSubjectId,
        operationId: crypto.randomUUID(),
        requestDigest: "b".repeat(64),
        credentialEncrypted: "test-encrypted-envelope",
      });
      expect(row).not.toBeNull();
      const target = {
        kind,
        connectionId: row!.id,
        accountId: setup.organizationId,
        workspaceId: setup.workspaceId,
        subjectId: setup.actorSubjectId,
      };
      const policy = await getModelConnectionAccess(client.db, target);
      const modelId = `workspace-${kind === "vercel_gateway" ? "gateway" : "openrouter"}/allowed`;
      expect(
        (
          await updateModelConnectionAccess(client.db, target, {
            ...policy!,
            allowedModels: [modelId],
          })
        )?.version,
      ).toBe(2);
      await assertModelConnectionAllowsTurn(client.db, { ...target, modelId });
      await expect(
        assertModelConnectionAllowsTurn(client.db, {
          ...target,
          modelId: modelId.replace("allowed", "blocked"),
        }),
      ).rejects.toThrow("disabled");
      expect(
        await getModelConnectionAccess(client.db, {
          ...target,
          kind: kind === "vercel_gateway" ? "openrouter" : "vercel_gateway",
        }),
      ).toBeNull();
      const [stored] = await shared.admin<
        { version: number }[]
      >`select version from connections where id = ${row!.id}`;
      expect(stored!.version).toBe(row!.version);
    }
  },
);
beforeAll(async () => {
  if (process.env.OPENGENI_REQUIRE_REAL_DB !== "1") return;
  const database = await acquireSharedTestDatabase("organization-xai-subscriptions");
  if (!database) throw new Error("Real PostgreSQL is required");
  shared = database;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture() {
  const [account] = await shared.admin<
    { id: string }[]
  >`insert into managed_accounts(name) values ('SuperGrok organization test') returning id`;
  const organizationId = account!.id;
  const [workspace] = await shared.admin<
    { id: string }[]
  >`insert into workspaces(account_id,name) values (${organizationId}, 'Shared') returning id`;
  const [personal] = await shared.admin<
    { id: string }[]
  >`insert into workspaces(account_id,name) values (${organizationId}, 'Personal') returning id`;
  const actorSubjectId = `user:${crypto.randomUUID()}`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values (${organizationId},${actorSubjectId},'owner','active',${personal!.id})`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,role,permissions)
    values (${organizationId},${workspace!.id},${actorSubjectId},'owner','[]'::jsonb)`;
  for (const id of [workspace!.id, personal!.id])
    await shared.admin`insert into workspace_inference_controls(account_id,workspace_id) values (${organizationId},${id})`;
  return {
    organizationId,
    actorSubjectId,
    workspaceId: workspace!.id,
    personalWorkspaceId: personal!.id,
  };
}
async function connect(
  actor: { organizationId: string; actorSubjectId: string },
  providerAccountId: string,
) {
  return await upsertOrganizationXaiSubscription(client.db, {
    ...actor,
    providerAccountId,
    encryptionKey,
    secret: { version: 1, accessToken: "test-access-token", refreshToken: "test-refresh-token" },
    label: "SuperGrok plan",
    accountEmail: "account@example.test",
    expiresAt: new Date(Date.now() + 3600_000),
  });
}

realTest(
  "organization accounts inherit into shared and Personal workspaces, preserve exact scope and remain admin managed",
  async () => {
    const actor = await fixture();
    const other = await fixture();
    const first = await connect(actor, "one");
    const second = await connect(actor, "two");
    const otherFirst = await connect(other, "one");
    expect(otherFirst.account.id).not.toBe(first.account.id);
    expect((await connect(actor, "one")).account.id).toBe(first.account.id);
    const listed = await listOrganizationXaiSubscriptions(client.db, actor);
    expect(listed.accounts).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain("test-access-token");
    expect(listed.rotation?.activeCredentialId).toBe(first.account.id);
    await updateOrganizationXaiSubscription(client.db, {
      ...actor,
      credentialId: second.account.id,
      activate: true,
      label: "Second plan",
    });
    await updateOrganizationXaiRotation(client.db, { ...actor, rotationEnabled: true });
    for (const workspaceId of [actor.workspaceId, actor.personalWorkspaceId]) {
      const input = { workspaceId, subjectId: actor.actorSubjectId };
      expect(
        await resolveXaiProviderAccountAuthoritySnapshotForAcceptance(client.db, input),
      ).toEqual(organizationSnapshot);
      const rotation = await getXaiRotationSettings(client.db, {
        ...input,
        authoritySnapshot: organizationSnapshot,
      });
      expect(rotation?.activeCredentialId).toBe(second.account.id);
      expect(rotation?.rotationEnabled).toBe(true);
      const accounts = await listXaiSubscriptionAccountsMetadata(client.db, input);
      expect(accounts.map((account) => account.id).sort()).toEqual(
        [first.account.id, second.account.id].sort(),
      );
      expect(
        (
          await materializeXaiCredentialForRun(client.db, {
            ...input,
            credentialId: first.account.id,
            authoritySnapshot: organizationSnapshot,
            encryptionKey,
          })
        ).secret.accessToken,
      ).toBe("test-access-token");
      await expect(
        materializeXaiCredentialForRun(client.db, {
          ...input,
          credentialId: first.account.id,
          authoritySnapshot: { version: 1, scope: "workspace" },
          encryptionKey,
        }),
      ).rejects.toThrow();
      await expect(
        withWorkspaceSubjectRls(client.db, workspaceId, actor.actorSubjectId, async (tx) => {
          await tx.execute(
            sql`update xai_subscription_credentials set label = 'workspace takeover' where id = ${first.account.id}::uuid`,
          );
        }),
      ).rejects.toThrow();
      await expect(
        withWorkspaceSubjectRls(client.db, workspaceId, actor.actorSubjectId, async (tx) => {
          await tx.execute(
            sql`update xai_rotation_settings set active_credential_id = ${first.account.id}::uuid where authority_scope = 'organization'`,
          );
        }),
      ).rejects.toThrow();
    }
    await expect(
      materializeXaiCredentialForRun(client.db, {
        workspaceId: other.workspaceId,
        subjectId: other.actorSubjectId,
        credentialId: first.account.id,
        authoritySnapshot: organizationSnapshot,
        encryptionKey,
      }),
    ).rejects.toThrow();
    await expect(
      listOrganizationXaiSubscriptions(client.db, {
        ...actor,
        actorSubjectId: other.actorSubjectId,
      }),
    ).rejects.toThrow();
    const refreshed = await refreshXaiSubscriptionCredentialSerialized(client.db, {
      accountId: actor.organizationId,
      workspaceId: actor.workspaceId,
      subjectId: actor.actorSubjectId,
      credentialId: first.account.id,
      authoritySnapshot: organizationSnapshot,
      encryptionKey,
      observedAccessToken: "test-access-token",
      observedRefreshToken: "test-refresh-token",
      refresh: async () => ({
        secret: { version: 1, accessToken: "refreshed-token" },
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    });
    expect(refreshed.refreshed).toBe(true);
    await createXaiSubscriptionCredential(client.db, {
      accountId: actor.organizationId,
      workspaceId: actor.workspaceId,
      subjectId: actor.actorSubjectId,
      encryptionKey,
      secret: { version: 1, accessToken: "local-token" },
      providerAccountId: "local",
    });
    expect(
      await resolveXaiProviderAccountAuthoritySnapshotForAcceptance(client.db, {
        workspaceId: actor.workspaceId,
        subjectId: actor.actorSubjectId,
      }),
    ).toEqual({ version: 1, scope: "workspace" });
    // Already accepted organization work keeps its original pool after a local connection is added.
    expect(
      (
        await materializeXaiCredentialForRun(client.db, {
          workspaceId: actor.workspaceId,
          subjectId: actor.actorSubjectId,
          credentialId: first.account.id,
          authoritySnapshot: organizationSnapshot,
          encryptionKey,
        })
      ).secret.accessToken,
    ).toBe("refreshed-token");
  },
);

realTest.each(["shared", "personal"] as const)(
  "organization %s lease blocks disconnect and wakes after pool changes",
  async (workspaceKind) => {
    const setup = await fixture();
    const actor = {
      ...setup,
      workspaceId: workspaceKind === "personal" ? setup.personalWorkspaceId : setup.workspaceId,
    };
    const connected = await connect(actor, "leased");
    const sessionId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    await withSessionActivityRlsContext(
      client.db,
      { accountId: actor.organizationId, workspaceId: actor.workspaceId },
      async (tx) => {
        await tx.execute(sql`insert into sessions(id,account_id,workspace_id,initial_message,model,reasoning_effort,latency_mode,sandbox_backend,sandbox_group_id,status,temporal_workflow_id,tool_policy)
      values (${sessionId},${actor.organizationId},${actor.workspaceId},'test','test-model','medium','standard','none',${sessionId},'running',${`test-${sessionId}`},'{"mode":"explicit","inheritedFromSessionId":null}'::jsonb)`);
        await tx.execute(sql`insert into session_turns(id,account_id,workspace_id,session_id,trigger_event_id,temporal_workflow_id,status,source,position,prompt,model,reasoning_effort,latency_mode,sandbox_backend,execution_generation,xai_provider_account_authority_snapshot)
      values (${turnId},${actor.organizationId},${actor.workspaceId},${sessionId},${crypto.randomUUID()},${`test-${sessionId}`},'running','user',1,'test','test-model','medium','standard','none',1,'{"version":1,"scope":"organization"}'::jsonb)`);
      },
    );
    const lease = await acquireXaiCredentialLease(client.db, {
      accountId: actor.organizationId,
      workspaceId: actor.workspaceId,
      subjectId: actor.actorSubjectId,
      sessionId,
      turnId,
      holderId: "test-holder",
      authoritySnapshot: organizationSnapshot,
    });
    expect(lease.credentialId).toBe(connected.account.id);
    await expect(
      updateOrganizationXaiSubscription(client.db, {
        ...actor,
        credentialId: connected.account.id,
        disconnect: true,
      }),
    ).rejects.toThrow();
    await releaseXaiCredentialLease(client.db, {
      workspaceId: actor.workspaceId,
      subjectId: actor.actorSubjectId,
      turnId,
      holderId: lease.holderId!,
      generation: lease.generation!,
    });
    await shared.admin`insert into xai_capacity_waiters(account_id,workspace_id,session_id,blocked_turn_id,blocked_turn_generation,workflow_id,authority_scope,next_check_at)
      values (${actor.organizationId},${actor.workspaceId},${sessionId},${turnId},1,${`test-${sessionId}`},'organization',now() + interval '1 day')`;
    await updateOrganizationXaiRotation(client.db, { ...actor, rotationEnabled: true });
    const [waiter] = await shared.admin<
      { wake_revision: number; due: boolean }[]
    >`select wake_revision, next_check_at <= now() as due from xai_capacity_waiters where session_id = ${sessionId}`;
    expect(Number(waiter!.wake_revision)).toBeGreaterThan(0);
    expect(waiter!.due).toBe(true);
    const [wake] = await shared.admin<
      { reason: string }[]
    >`select reason from session_workflow_wake_outbox where session_id = ${sessionId}`;
    expect(wake?.reason).toBe("xai_capacity");
    const pinInput = {
      accountId: actor.organizationId,
      workspaceId: actor.workspaceId,
      subjectId: actor.actorSubjectId,
      sessionId,
      authoritySnapshot: organizationSnapshot,
    };
    await setXaiSessionAccountPin(client.db, {
      ...pinInput,
      credentialId: connected.account.id,
      pinSource: "manual",
    });
    await withWorkspaceSubjectRls(client.db, actor.workspaceId, actor.actorSubjectId, (tx) =>
      tx.execute(
        sql`update xai_session_account_pins set last_credential_id = ${connected.account.id}::uuid where session_id = ${sessionId}::uuid`,
      ),
    );
    const accessTarget = {
      accountId: actor.organizationId,
      workspaceId: null,
      subjectId: actor.actorSubjectId,
      kind: "supergrok" as const,
      connectionId: connected.account.id,
    };
    const access = await getModelConnectionAccess(client.db, accessTarget);
    await updateModelConnectionAccess(client.db, accessTarget, {
      ...access!,
      allowedWorkspaces: [],
    });
    const unpinned = await setXaiSessionAccountPin(client.db, {
      ...pinInput,
      credentialId: null,
      pinSource: null,
    });
    expect(unpinned.pinnedCredentialId).toBeNull();
    expect(unpinned.lastCredentialId).toBe(connected.account.id);

    expect(
      await updateOrganizationXaiSubscription(client.db, {
        ...actor,
        credentialId: connected.account.id,
        disconnect: true,
      }),
    ).toEqual({ disconnected: true });
  },
);
