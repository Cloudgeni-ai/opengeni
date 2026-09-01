import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { reconcileRigProviderImageCleanupObligationsForSource } from "../src/activities/rig-provider-image-cleanup";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_ID = "33333333-3333-4333-8333-333333333333";
const INSTANCE_ID = "sb-source";
const OBLIGATION_ID = "44444444-4444-4444-8444-444444444444";
const PROVIDER_BINDING_KEY = JSON.stringify({
  version: 1,
  serverUrl: "https://api.modal.com",
  workspaceName: "workspace-a",
  environment: "main",
});

describe("durable Rig provider image cleanup reconciliation", () => {
  test("a replacement worker discovers an outcome-unknown request and persists its late image", async () => {
    const calls: string[] = [];
    const recovered = await reconcileRigProviderImageCleanupObligationsForSource(
      {
        db: {} as never,
        settings: testSettings({ sandboxBackend: "modal" }),
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        sourceLeaseId: LEASE_ID,
        sourceInstanceId: INSTANCE_ID,
        timeoutMs: 5_000,
      },
      {
        list: async (_db, input) => {
          expect(input).toEqual({
            accountId: ACCOUNT_ID,
            workspaceId: WORKSPACE_ID,
            sourceLeaseId: LEASE_ID,
            sourceInstanceId: INSTANCE_ID,
          });
          calls.push("list");
          return [
            {
              id: OBLIGATION_ID,
              state: "outcome_unknown",
              buildRequestId: "rig-provider-image-request",
              objectId: null,
              providerBindingKey: PROVIDER_BINDING_KEY,
              providerBinding: JSON.parse(PROVIDER_BINDING_KEY),
              sourceLeaseId: LEASE_ID,
              sourceInstanceId: INSTANCE_ID,
            },
          ];
        },
        recover: async (_settings, input) => {
          calls.push("recover");
          expect(input.sandboxId).toBe(INSTANCE_ID);
          expect(input.requestId).toBe("rig-provider-image-request");
          expect(input.expectedProviderBindingKey).toBe(PROVIDER_BINDING_KEY);
          expect(input.timeoutMs).toBeGreaterThan(0);
          return {
            provider: "modal",
            backend: "modal",
            imageId: "im-recovered-after-restart",
            imageDigest: null,
            providerBindingKey: PROVIDER_BINDING_KEY,
            providerBinding: JSON.parse(PROVIDER_BINDING_KEY),
          };
        },
        record: async (_db, input) => {
          calls.push("record");
          expect(input).toEqual({
            accountId: ACCOUNT_ID,
            workspaceId: WORKSPACE_ID,
            obligationId: OBLIGATION_ID,
            buildRequestId: "rig-provider-image-request",
            providerBindingKey: PROVIDER_BINDING_KEY,
            objectId: "im-recovered-after-restart",
          });
          return true;
        },
      },
    );

    expect(recovered).toBe(1);
    expect(calls).toEqual(["list", "recover", "record"]);
  });

  test("fails closed when recovery returns another provider binding", async () => {
    let recorded = false;
    await expect(
      reconcileRigProviderImageCleanupObligationsForSource(
        {
          db: {} as never,
          settings: testSettings({ sandboxBackend: "modal" }),
          accountId: ACCOUNT_ID,
          workspaceId: WORKSPACE_ID,
          sourceLeaseId: LEASE_ID,
          sourceInstanceId: INSTANCE_ID,
          timeoutMs: 5_000,
        },
        {
          list: async () => [
            {
              id: OBLIGATION_ID,
              state: "outcome_unknown",
              buildRequestId: "rig-provider-image-request",
              objectId: null,
              providerBindingKey: PROVIDER_BINDING_KEY,
              providerBinding: JSON.parse(PROVIDER_BINDING_KEY),
              sourceLeaseId: LEASE_ID,
              sourceInstanceId: INSTANCE_ID,
            },
          ],
          recover: async () => ({
            provider: "modal",
            backend: "modal",
            imageId: "im-wrong-binding",
            imageDigest: null,
            providerBindingKey: PROVIDER_BINDING_KEY.replace("workspace-a", "workspace-b"),
            providerBinding: JSON.parse(PROVIDER_BINDING_KEY.replace("workspace-a", "workspace-b")),
          }),
          record: async () => {
            recorded = true;
            return true;
          },
        },
      ),
    ).rejects.toThrow("another provider identity");
    expect(recorded).toBe(false);
  });
});
