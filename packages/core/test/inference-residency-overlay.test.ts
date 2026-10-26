import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  updateOrganizationInferenceResidency,
} from "@opengeni/db";

import { settingsWithInferenceResidency, settingsWithModelProviderCredentials } from "../src";

setDefaultTimeout(120_000);

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("inference-residency-overlay");
  if (!acquired) throw new Error("EU-only inference tests require PostgreSQL");
  shared = acquired;
  // The change function is withheld from the runtime until it is granted.
  await grantDeferredRuntimeAccess(shared.admin);
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("an EU-only organization puts the EU requirement on every execution overlay", async () => {
  const userId = `eu-overlay-${crypto.randomUUID()}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "EU-only owner",
  });
  const membership = provisioned.organizationMemberships[0]!;
  const scope = {
    accountId: membership.organizationId,
    workspaceId: membership.personalWorkspaceId,
  };
  const settings = testSettings();

  expect(
    (await settingsWithInferenceResidency(client.db, { ...scope, settings }))
      .requiredModelGeography,
  ).toBeUndefined();

  await updateOrganizationInferenceResidency(client.db, {
    organizationId: membership.organizationId,
    actorSubjectId: `user:${userId}`,
    actorKind: "browser_person",
    euOnly: true,
    expectedVersion: 0,
    operationId: crypto.randomUUID(),
  });

  expect(
    (await settingsWithInferenceResidency(client.db, { ...scope, settings }))
      .requiredModelGeography,
  ).toBe("eu");
  // The full overlay every model call path uses carries it too.
  expect(
    (
      await settingsWithModelProviderCredentials(client.db, {
        ...scope,
        settings,
        productModelId: settings.openaiModel,
      })
    ).requiredModelGeography,
  ).toBe("eu");
  // A requirement already on the settings is never removed.
  expect(
    (
      await settingsWithInferenceResidency(client.db, {
        accountId: scope.accountId,
        workspaceId: crypto.randomUUID(),
        settings: { ...settings, requiredModelGeography: "eu" },
      })
    ).requiredModelGeography,
  ).toBe("eu");
});
