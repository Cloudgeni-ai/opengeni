import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  deleteWorkspace,
  listConnectorToolPermissionPolicies,
  updateConnectorToolPermissionPolicies,
  projectConnectorToolPermission,
  connectorToolPolicyRevision,
  ConnectorToolPermissionConflictError,
  type DbClient,
} from "../src";

let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const database = await acquireSharedTestDatabase("connector-permission-preservation");
  if (!database) throw new Error("Real database required for permission verification");
  shared = database;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("reset reveals inherited choice, whole-tool edits replace exceptions, and stale saves cannot win", async () => {
  const grant = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Permission fixture",
      workspaceExternalSource: "test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Permission fixture",
      subjectId: "human:permissions",
    })
  ).workspaceGrants[0]!;
  const target = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    connectionId: crypto.randomUUID(),
    serverId: "mail",
  };
  const read = () => listConnectorToolPermissionPolicies(client.db, target);
  const revision = async () =>
    connectorToolPolicyRevision(await read(), target.connectionId, target.serverId);
  const projected = async () =>
    projectConnectorToolPermission(await read(), {
      ...target,
      toolName: "change",
      defaultDecision: "allow",
    });
  try {
    await updateConnectorToolPermissionPolicies(client.db, {
      ...target,
      toolNames: ["*"],
      policy: "ask",
    });
    await updateConnectorToolPermissionPolicies(client.db, {
      ...target,
      toolNames: ["change"],
      policy: "allow",
    });
    await updateConnectorToolPermissionPolicies(client.db, {
      ...target,
      toolNames: ["change"],
      actionName: "delete",
      policy: "block",
    });
    expect(await projected()).toMatchObject({ permission: "allow", conditional: true });
    await updateConnectorToolPermissionPolicies(client.db, {
      ...target,
      toolNames: ["change"],
      policy: "allow",
    });
    expect(await projected()).toMatchObject({ permission: "allow", conditional: false });
    await updateConnectorToolPermissionPolicies(client.db, {
      ...target,
      toolNames: ["change"],
      policy: null,
    });
    expect(await projected()).toMatchObject({
      permission: "ask",
      inherited: true,
      source: "connector_default",
    });
    const expectedRevision = await revision();
    const race = await Promise.allSettled(
      ["allow", "block"].map((policy) =>
        updateConnectorToolPermissionPolicies(client.db, {
          ...target,
          expectedRevision,
          toolNames: ["change"],
          policy: policy as "allow" | "block",
        }),
      ),
    );
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = race.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      ConnectorToolPermissionConflictError,
    );
    await updateConnectorToolPermissionPolicies(client.db, {
      ...target,
      toolNames: ["*", "change"],
      policy: null,
    });
    expect(await projected()).toMatchObject({
      permission: "allow",
      inherited: true,
      source: "recommended",
    });
    expect(await read()).toHaveLength(0);
  } finally {
    await deleteWorkspace(client.db, grant.workspaceId);
  }
});
