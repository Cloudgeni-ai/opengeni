// OPE-13 live Modal failure injection — intentionally hard-gated.
//
// This test creates at most two boxes (initial + elected replacement) in a
// dedicated app, tags each exact id with a unique disposable run tag, terminates
// the initial id, races concurrent target restore, and finally terminates only
// the exact ids it observed. There is no broad list/sweep cleanup and no secret
// output. The deterministic DNS/UNAVAILABLE negative path lives in runtime unit
// tests because redirecting the Modal SDK endpoint locally is not a supported,
// safe live-test seam.
//
// Required explicit safety preconditions:
//   OPENGENI_ENABLE_LIVE_TESTS=true
//   OPENGENI_OPE13_MODAL_FAILURE_INJECTION=I_ACKNOWLEDGE_DISPOSABLE_MODAL_RESOURCES
//   OPENGENI_OPE13_MODAL_MAX_RESOURCES=2
//   OPENGENI_SANDBOX_BACKEND=modal
//   OPENGENI_MODAL_APP_NAME=ope13-<dedicated-app>

import { describe, expect, test } from "bun:test";
import { getSettings } from "@opengeni/config";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { modalSandboxAttributionTags, terminateModalSandboxById } from "@opengeni/runtime/sandbox";
import { establishNamedModalTarget } from "@opengeni/core";
import { createDb, createSandbox, createSession, readLease } from "@opengeni/db";

const ACK = "I_ACKNOWLEDGE_DISPOSABLE_MODAL_RESOURCES";
const dedicatedApp = process.env.OPENGENI_MODAL_APP_NAME ?? "";
const enabled =
  process.env.OPENGENI_ENABLE_LIVE_TESTS === "true" &&
  process.env.OPENGENI_OPE13_MODAL_FAILURE_INJECTION === ACK &&
  process.env.OPENGENI_OPE13_MODAL_MAX_RESOURCES === "2" &&
  process.env.OPENGENI_SANDBOX_BACKEND === "modal" &&
  /^ope13-[a-z0-9-]+$/i.test(dedicatedApp);

describe("OPE-13 live Modal exact-box recovery (guarded)", () => {
  test.skipIf(!enabled)(
    "exact terminate + concurrent target restore elects one replacement and cleans every exact id",
    async () => {
      let shared: SharedTestDatabase | null = null;
      let client: ReturnType<typeof createDb> | null = null;
      const pendingCleanupIds = new Set<string>();
      const observedIds = new Set<string>();
      const held: Array<{ release(): Promise<void> }> = [];
      let recoveryWorkspaceId: string | null = null;
      let recoveryTargetId: string | null = null;
      const settings = getSettings();
      const runTag = `ope13-${crypto.randomUUID()}`;

      const tagExact = async (
        sandboxId: string,
        attribution: { leaseId: string; workspaceId: string; sandboxGroupId: string },
      ): Promise<void> => {
        const modal = await import("modal");
        const modalClient = new modal.ModalClient({
          ...(settings.modalTokenId ? { tokenId: settings.modalTokenId } : {}),
          ...(settings.modalTokenSecret ? { tokenSecret: settings.modalTokenSecret } : {}),
          ...(settings.modalEnvironment ? { environment: settings.modalEnvironment } : {}),
          timeoutMs: 30_000,
        });
        try {
          const sandbox = await modalClient.sandboxes.fromId(sandboxId);
          await sandbox.setTags({
            ...modalSandboxAttributionTags(attribution),
            ope13_disposable: "true",
            ope13_test_run: runTag,
          });
        } finally {
          modalClient.close();
        }
      };

      try {
        shared = await acquireSharedTestDatabase(`ope13-modal-live-${runTag}`);
        if (!shared) throw new Error("OPE-13 live test requires the disposable Postgres harness");
        client = createDb(shared.appUrl);
        const [account] = await shared.admin<{ id: string }[]>`
          insert into managed_accounts (name) values ('ope13-live') returning id`;
        const [workspace] = await shared.admin<{ id: string }[]>`
          insert into workspaces (account_id, name)
          values (${account!.id}, 'ope13-live') returning id`;
        const session = await createSession(client.db, {
          accountId: account!.id,
          workspaceId: workspace!.id,
          initialMessage: "ope13 live recovery",
          resources: [],
          metadata: { test: "ope13-disposable" },
          model: "scripted-model",
          sandboxBackend: "modal",
        });
        const target = await createSandbox(client.db, {
          accountId: account!.id,
          workspaceId: workspace!.id,
          kind: "modal",
          name: runTag,
        });
        recoveryWorkspaceId = workspace!.id;
        recoveryTargetId = target.id;
        const base = {
          db: client.db,
          settings,
          accountId: account!.id,
          workspaceId: workspace!.id,
          sandboxId: target.id,
          holderKind: "turn" as const,
          subjectId: session.id,
        };

        const initial = await establishNamedModalTarget({ ...base, holderId: `${runTag}-initial` });
        held.push(initial);
        pendingCleanupIds.add(initial.established.instanceId);
        observedIds.add(initial.established.instanceId);
        await tagExact(initial.established.instanceId, {
          leaseId: initial.lease.id,
          workspaceId: workspace!.id,
          sandboxGroupId: target.id,
        });
        expect(await terminateModalSandboxById(settings, initial.established.instanceId)).toBe(
          true,
        );
        pendingCleanupIds.delete(initial.established.instanceId);
        await initial.release();

        const settled = await Promise.allSettled(
          Array.from({ length: 8 }, (_, index) =>
            establishNamedModalTarget({ ...base, holderId: `${runTag}-restore-${index}` }),
          ),
        );
        // Register every fulfilled exact handle/id for cleanup BEFORE any
        // assertion can throw. If the race ever regresses to partial success or
        // rival ids, the failure path still terminates every returned resource.
        const restored = settled
          .filter(
            (
              result,
            ): result is PromiseFulfilledResult<
              Awaited<ReturnType<typeof establishNamedModalTarget>>
            > => result.status === "fulfilled",
          )
          .map((result) => result.value);
        held.push(...restored);
        for (const result of restored) {
          pendingCleanupIds.add(result.established.instanceId);
          observedIds.add(result.established.instanceId);
        }
        const failures = settled.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        expect(failures).toHaveLength(0);
        const ids = new Set(restored.map((result) => result.established.instanceId));
        expect(ids.size).toBe(1);
        const replacementId = [...ids][0]!;
        const lease = await readLease(client.db, workspace!.id, target.id);
        expect(lease?.instanceId).toBe(replacementId);
        expect(lease?.leaseEpoch).toBe(initial.lease.leaseEpoch + 1);
        await tagExact(replacementId, {
          leaseId: lease!.id,
          workspaceId: workspace!.id,
          sandboxGroupId: target.id,
        });
      } finally {
        await Promise.allSettled(held.map((result) => result.release()));
        // If lifecycle establishment failed after checkpointing an exact create
        // but before returning its handle, recover that exact id from the
        // disposable lease. Never list/sweep an app or infer an ambient box.
        if (client && recoveryWorkspaceId && recoveryTargetId) {
          const checkpoint = await readLease(
            client.db,
            recoveryWorkspaceId,
            recoveryTargetId,
          ).catch(() => null);
          if (checkpoint?.instanceId && !observedIds.has(checkpoint.instanceId)) {
            pendingCleanupIds.add(checkpoint.instanceId);
            observedIds.add(checkpoint.instanceId);
            await tagExact(checkpoint.instanceId, {
              leaseId: checkpoint.id,
              workspaceId: recoveryWorkspaceId,
              sandboxGroupId: recoveryTargetId,
            }).catch(() => undefined);
          }
        }
        const cleanupFailures: string[] = [];
        for (const sandboxId of pendingCleanupIds) {
          try {
            const terminated = await terminateModalSandboxById(settings, sandboxId);
            if (!terminated) cleanupFailures.push(sandboxId);
          } catch {
            cleanupFailures.push(sandboxId);
          }
        }
        await client?.close().catch(() => undefined);
        await shared?.release();
        expect(cleanupFailures).toEqual([]);
      }
    },
    420_000,
  );
});
