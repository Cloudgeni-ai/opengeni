import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  rotateWorkspaceProviderApiKeyConnection,
  upsertWorkspaceProviderApiKeyConnection,
  type DbClient,
  revokeWorkspaceProviderApiKeyConnections,
} from "../src/index";
import {
  getModelConnectionAccess,
  updateModelConnectionAccess,
} from "../src/model-connection-access";
import { assertModelConnectionAllowsTurn } from "../src/workspace-model-connection-access";
import {
  createClaudeSubscriptionAccount,
  upsertClaudeSubscriptionAccount,
  setInitialActiveClaudeCredential,
  getClaudeRotationSettings,
  disconnectClaudeSubscriptionAccount,
  materializeClaudeSubscriptionAccountForRun,
} from "../src/claude-subscription-accounts";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-provider-rotation-access");
  if (!shared) throw new Error("Real PostgreSQL required for credential access regression");
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

// 0598 retires the legacy Claude API-key store. Anthropic/Gateway/OpenRouter
// keep its rotate/replay contract; Claude now reconnects an exact pool account
// generation (docs/model-providers.md, Claude subscription usage).
for (const kind of ["anthropic", "openrouter", "vercel_gateway"] as const) {
  for (const denyAll of [false, true]) {
    test(`${kind} rotation preserves ${denyAll ? "deny-all" : "allowlist"} and policy revision`, async () => {
      if (!shared || !client) throw new Error("Real PostgreSQL required");
      const [account] = await shared.admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('rotation policy test') returning id`;
      const [workspace] = await shared.admin<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'rotation policy') returning id`;
      const scope = { accountId: account!.id, workspaceId: workspace!.id };
      const subjectId = "rotation-policy-test";
      const prefix = kind === "vercel_gateway" ? "workspace-gateway" : `workspace-${kind}`;
      const allowedModel = `${prefix}/allowed`;
      const deniedModel = `${prefix}/denied`;
      const original = await upsertWorkspaceProviderApiKeyConnection(client.db, kind, {
        ...scope,
        credentialEncrypted: "original-fixture",
        operationId: crypto.randomUUID(),
        requestDigest: "create-fixture",
        updatedBySubjectId: subjectId,
      });
      expect(original).not.toBeNull();
      const target = { ...scope, subjectId, kind, connectionId: original!.id };
      const policy = await updateModelConnectionAccess(client.db, target, {
        allowedModels: denyAll ? [] : [allowedModel],
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
        version: 1,
      });
      expect(policy?.version).toBe(2);
      const input = {
        ...scope,
        connectionId: original!.id,
        expectedVersion: original!.version,
        credentialEncrypted: "replacement-fixture",
        operationId: crypto.randomUUID(),
        requestDigest: "rotation-fixture",
        updatedBySubjectId: subjectId,
      };
      expect(
        await rotateWorkspaceProviderApiKeyConnection(client.db, kind, {
          ...input,
          expectedVersion: original!.version + 1,
        }),
      ).toBeNull();
      const rotated = await rotateWorkspaceProviderApiKeyConnection(client.db, kind, input);
      expect(rotated).not.toBeNull();
      expect(rotated!.id).not.toBe(original!.id);
      expect(
        await getModelConnectionAccess(client.db, { ...target, connectionId: rotated!.id }),
      ).toEqual(policy);
      const gate = (modelId: string) =>
        assertModelConnectionAllowsTurn(client!.db, {
          workspaceId: scope.workspaceId,
          subjectId,
          modelId,
          workspaceProviderConnectionId: rotated!.id,
        });
      await expect(gate(deniedModel)).rejects.toThrow("disabled");
      if (denyAll) await expect(gate(allowedModel)).rejects.toThrow("disabled");
      else await gate(allowedModel);
      expect((await rotateWorkspaceProviderApiKeyConnection(client.db, kind, input))?.id).toBe(
        rotated!.id,
      );
      expect(
        await rotateWorkspaceProviderApiKeyConnection(client.db, kind, {
          ...input,
          operationId: crypto.randomUUID(),
        }),
      ).toBeNull();
      expect(
        await rotateWorkspaceProviderApiKeyConnection(client.db, kind, {
          ...input,
          requestDigest: "conflicting-replay",
        }),
      ).toBeNull();
      expect(
        await getModelConnectionAccess(client.db, { ...target, connectionId: rotated!.id }),
      ).toEqual(policy);
      const rows = await shared.admin`
        select allowed_model_ids, allowed_workspace_ids, allow_personal_workspaces,
          access_policy_version, access_policy_updated_by, access_policy_updated_at
        from connections where id in (${original!.id}, ${rotated!.id}) order by created_at`;
      expect(rows).toHaveLength(2);
      expect(rows[1]).toEqual(rows[0]);
      const latestPolicy = await updateModelConnectionAccess(
        client.db,
        {
          ...target,
          connectionId: rotated!.id,
        },
        {
          allowedModels: denyAll ? [allowedModel] : [],
          allowedWorkspaces: null,
          allowPersonalWorkspaces: true,
          version: policy!.version,
        },
      );
      expect(latestPolicy?.version).toBe(3);
      // Disconnect/reconnect is still credential management, not permission to reset policy.
      await revokeWorkspaceProviderApiKeyConnections(client.db, kind, {
        ...scope,
        connectionId: rotated!.id,
        expectedVersion: rotated!.version,
        updatedBySubjectId: subjectId,
      });
      const reconnectInput = {
        ...scope,
        credentialEncrypted: "reconnect-fixture",
        operationId: crypto.randomUUID(),
        requestDigest: "reconnect-fixture",
        updatedBySubjectId: subjectId,
      };
      const reconnected = await upsertWorkspaceProviderApiKeyConnection(
        client.db,
        kind,
        reconnectInput,
      );
      expect(reconnected).not.toBeNull();
      for (const returned of [original, rotated, reconnected]) {
        for (const field of [
          "allowedModelIds",
          "allowedWorkspaceIds",
          "allowPersonalWorkspaces",
          "accessPolicyVersion",
          "accessPolicyUpdatedBy",
          "accessPolicyUpdatedAt",
        ]) {
          expect(returned).not.toHaveProperty(field);
          expect(returned!.metadata).not.toHaveProperty(field);
        }
      }
      expect(
        await getModelConnectionAccess(client.db, { ...target, connectionId: reconnected!.id }),
      ).toEqual(latestPolicy);
      await expect(
        assertModelConnectionAllowsTurn(client.db, {
          workspaceId: scope.workspaceId,
          subjectId,
          modelId: deniedModel,
          workspaceProviderConnectionId: reconnected!.id,
        }),
      ).rejects.toThrow("disabled");
      const reconnectedAllowed = () =>
        assertModelConnectionAllowsTurn(client!.db, {
          workspaceId: scope.workspaceId,
          subjectId,
          modelId: allowedModel,
          workspaceProviderConnectionId: reconnected!.id,
        });
      if (denyAll) await reconnectedAllowed();
      else await expect(reconnectedAllowed()).rejects.toThrow("disabled");
      expect(
        (await upsertWorkspaceProviderApiKeyConnection(client.db, kind, reconnectInput))?.id,
      ).toBe(reconnected!.id);
      expect(
        await upsertWorkspaceProviderApiKeyConnection(client.db, kind, {
          ...reconnectInput,
          requestDigest: "conflicting-reconnect",
        }),
      ).toBeNull();
    });
  }
}

for (const denyAll of [false, true]) {
  test(`Claude pool reconnect preserves ${denyAll ? "deny-all" : "allowlist"}, policy revision and active identity`, async () => {
    if (!shared || !client) throw new Error("Real PostgreSQL required");
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('Claude pool policy test') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Claude pool policy') returning id`;
    const scope = {
      accountId: account!.id,
      workspaceId: workspace!.id,
      subjectId: "rotation-policy-test",
    };
    const encryptionKey = Buffer.alloc(32, 47);
    const secret = {
      version: 1 as const,
      token: "sk-ant-oat01-original-fixture",
      identity: { accountUuid: crypto.randomUUID(), deviceId: "a".repeat(64) },
    };
    const input = {
      ...scope,
      encryptionKey,
      secret,
      providerAccountId: secret.identity.accountUuid,
    };
    await expect(createClaudeSubscriptionAccount(client.db, input)).rejects.toMatchObject({
      cause: { code: "42501" },
    });
    expect(
      await shared.admin`select id from claude_subscription_credentials
      where workspace_id = ${scope.workspaceId}`,
    ).toHaveLength(0);
    await shared.admin`insert into workspace_memberships(account_id, workspace_id, subject_id, role)
      values (${scope.accountId}, ${scope.workspaceId}, ${scope.subjectId}, 'owner')`;
    const original = await createClaudeSubscriptionAccount(client.db, input);
    await setInitialActiveClaudeCredential(client.db, {
      ...scope,
      credentialId: original.account.id,
      authoritySnapshot: original.authoritySnapshot,
    });
    const target = {
      ...scope,
      kind: "claude_subscription" as const,
      connectionId: original.account.id,
    };
    const allowedModel = "workspace-claude-subscription/allowed";
    const deniedModel = "workspace-claude-subscription/denied";
    const policy = await updateModelConnectionAccess(client.db, target, {
      allowedModels: denyAll ? [] : [allowedModel],
      allowedWorkspaces: null,
      allowPersonalWorkspaces: false,
      version: 1,
    });
    expect(policy?.version).toBe(2);
    const policyAudit = () => shared!.admin`select allowed_model_ids, allowed_workspace_ids,
      allow_personal_workspaces, access_policy_version, access_policy_updated_by, access_policy_updated_at
      from claude_subscription_credentials where id = ${original.account.id}`;
    const originalAudit = await policyAudit();
    const rotation = await getClaudeRotationSettings(client.db, {
      ...scope,
      authoritySnapshot: original.authoritySnapshot,
    });
    const reconnect = {
      ...input,
      credentialId: original.account.id,
      expectedCredentialVersion: original.account.version,
      expectedProviderAccountId: original.account.providerAccountId,
      authoritySnapshot: original.authoritySnapshot,
      secret: { ...secret, token: "sk-ant-oat01-replacement-fixture" },
    };
    await expect(
      upsertClaudeSubscriptionAccount(client.db, {
        ...reconnect,
        expectedCredentialVersion: original.account.version + 1,
      }),
    ).rejects.toThrow("changed");
    const replaced = await upsertClaudeSubscriptionAccount(client.db, reconnect);
    expect(replaced.account.id).toBe(original.account.id);
    expect(replaced.account.version).toBe(original.account.version + 1);
    expect(replaced.authoritySnapshot).toEqual(original.authoritySnapshot);
    expect(await getModelConnectionAccess(client.db, target)).toEqual(policy);
    expect([...(await policyAudit())]).toEqual([...originalAudit]);
    const materialized = await materializeClaudeSubscriptionAccountForRun(client.db, {
      ...scope,
      credentialId: original.account.id,
      encryptionKey,
      authoritySnapshot: original.authoritySnapshot,
    });
    expect(materialized.secret).toEqual(reconnect.secret);
    expect(materialized.version).toBe(replaced.account.version);
    expect(
      await getClaudeRotationSettings(client.db, {
        ...scope,
        authoritySnapshot: original.authoritySnapshot,
      }),
    ).toEqual(rotation);
    // Canonical reconnect is generation-fenced, not legacy operation-id replay.
    await expect(upsertClaudeSubscriptionAccount(client.db, reconnect)).rejects.toThrow("changed");
    expect(await getModelConnectionAccess(client.db, target)).toEqual(policy);
    const gate = (modelId: string) =>
      assertModelConnectionAllowsTurn(client!.db, {
        workspaceId: scope.workspaceId,
        subjectId: scope.subjectId,
        modelId,
        claudeCredentialId: original.account.id,
        claudeAuthoritySnapshot: original.authoritySnapshot,
      });
    await expect(gate(deniedModel)).rejects.toThrow("disabled");
    if (denyAll) await expect(gate(allowedModel)).rejects.toThrow("disabled");
    else await gate(allowedModel);
    const updated = await updateModelConnectionAccess(client.db, target, {
      ...policy!,
      allowedModels: denyAll ? [allowedModel] : [],
      allowPersonalWorkspaces: true,
    });
    expect(updated?.version).toBe(3);
    const updatedAudit = await policyAudit();
    const signedInAgain = await upsertClaudeSubscriptionAccount(client.db, {
      ...reconnect,
      expectedCredentialVersion: replaced.account.version,
      secret: { ...secret, token: "sk-ant-oat01-signin-again-fixture" },
    });
    expect(signedInAgain.account.id).toBe(original.account.id);
    expect(signedInAgain.account.version).toBe(3);
    expect(await getModelConnectionAccess(client.db, target)).toEqual(updated);
    expect([...(await policyAudit())]).toEqual([...updatedAudit]);
    if (denyAll) await gate(allowedModel);
    else await expect(gate(allowedModel)).rejects.toThrow("disabled");
    for (const returned of [original, replaced, signedInAgain]) {
      expect(JSON.stringify(returned)).not.toContain("sk-ant-oat01-");
      expect(returned.account).not.toHaveProperty("credentialEncrypted");
    }
    expect(
      await disconnectClaudeSubscriptionAccount(client.db, {
        ...scope,
        credentialId: original.account.id,
        authoritySnapshot: original.authoritySnapshot,
      }),
    ).toBe(true);
    expect(await getModelConnectionAccess(client.db, target)).toBeNull();
    await expect(gate(allowedModel)).rejects.toThrow("disabled");
  });
}
