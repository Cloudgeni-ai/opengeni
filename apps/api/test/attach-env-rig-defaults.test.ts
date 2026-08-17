import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import type { Session } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createRig,
  createVariableSet,
  encryptVariableSetValue,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { sessionAttachEnvironment } from "../src/sandbox/session-environment";

const encryptionKey = randomBytes(32);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let settings: Settings;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_attach_env_rig_defaults");
  if (!shared) return;
  client = createDb(shared.appUrl, { max: 6 });
  settings = testSettings({
    sandboxBackend: "modal",
    environmentsEncryptionKey: encryptionKey.toString("base64"),
  });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("API-direct sandbox environment parity with frozen rig defaults", () => {
  test("layers every rig default in order below the session variable set", async () => {
    if (!shared || !client) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "attach-env-rig-test",
      accountExternalId: `account-${suffix}`,
      accountName: "Attach env rig",
      workspaceExternalSource: "attach-env-rig-test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Attach env rig",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const firstDefault = await createVariableSet(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "first-default",
      variables: [
        { name: "SHARED", valueEncrypted: encryptVariableSetValue(encryptionKey, "first") },
        { name: "FIRST_ONLY", valueEncrypted: encryptVariableSetValue(encryptionKey, "one") },
      ],
    });
    const laterDefault = await createVariableSet(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "later-default",
      variables: [
        { name: "SHARED", valueEncrypted: encryptVariableSetValue(encryptionKey, "later") },
        { name: "LATER_ONLY", valueEncrypted: encryptVariableSetValue(encryptionKey, "two") },
      ],
    });
    const sessionSet = await createVariableSet(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "session",
      variables: [
        { name: "SHARED", valueEncrypted: encryptVariableSetValue(encryptionKey, "session") },
        { name: "SESSION_ONLY", valueEncrypted: encryptVariableSetValue(encryptionKey, "three") },
      ],
    });
    const rig = await createRig(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "ordered-defaults",
      initialVersion: {
        defaultVariableSetIds: [firstDefault.id, laterDefault.id],
      },
    });
    const session = {
      rigId: rig.id,
      rigVersionId: rig.activeVersion!.id,
      environmentId: sessionSet.id,
      sandboxBackend: "modal",
      resources: [],
    } as unknown as Session;

    const environment = await sessionAttachEnvironment(
      { db: client.db, settings },
      grant.workspaceId,
      session,
    );

    expect(environment).toMatchObject({
      SHARED: "session",
      FIRST_ONLY: "one",
      LATER_ONLY: "two",
      SESSION_ONLY: "three",
    });
  });
});
