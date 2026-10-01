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

for (const kind of ["anthropic", "claude_subscription", "openrouter", "vercel_gateway"] as const) {
  for (const denyAll of [false, true]) {
    test(`${kind} rotation preserves ${denyAll ? "deny-all" : "allowlist"} and policy revision`, async () => {
      if (!shared || !client) throw new Error("Real PostgreSQL required");
      const [account] = await shared.admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('rotation policy test') returning id`;
      const [workspace] = await shared.admin<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'rotation policy') returning id`;
      const scope = { accountId: account!.id, workspaceId: workspace!.id };
      const subjectId = "rotation-policy-test";
      const prefix =
        kind === "vercel_gateway"
          ? "workspace-gateway"
          : kind === "claude_subscription"
            ? "workspace-claude-subscription"
            : `workspace-${kind}`;
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
