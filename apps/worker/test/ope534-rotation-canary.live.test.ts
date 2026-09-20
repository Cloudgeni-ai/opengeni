/**
 * OPE534 integration acceptance, deliberately OFF in ordinary test runs.
 *
 * Prerequisites (parent must integrate the prevention fix first):
 * - pinned repository Bun + installed dependencies; Docker for the canonical
 *   fully migrated, uniquely named shared-PG fixture. No external DB override.
 * - reviewed integrated git HEAD, no tracked modifications; exact anonymous-
 *   pull sandbox image digest built from that candidate (with native supervisor).
 * - pre-provisioned dedicated Modal environment ope534-canary-<unique suffix>;
 *   MODAL_TOKEN_ID/MODAL_TOKEN_SECRET authorized for it. Never staging/main.
 *
 * Run only after explicit billable-canary authorization, from the checkout root:
 * OPENGENI_OPE534_CANARY=1
 * OPENGENI_OPE534_CANARY_AUTHORIZATION=ISOLATED_MODAL_CANARY_ONLY
 * OPENGENI_OPE534_SOURCE_SHA=<integrated 40-character HEAD>
 * OPENGENI_OPE534_IMAGE_REF=<registry/image@sha256:...>
 * OPENGENI_OPE534_MODAL_ENVIRONMENT=ope534-canary-<unique suffix>
 * bun test apps/worker/test/ope534-rotation-canary.live.test.ts
 *
 * This exercises canonical route/adoption/settlement/resume and composite reaper
 * APIs; it does not run inference, Temporal, or an HTTP frontend. Only fixture
 * tenant rows are inserted manually. Never backdate leases, delete holders,
 * force rotation, fake provider proofs, or rewrite command/process state.
 * The only disabled reaper edge is fleet-wide orphan discovery: the harness
 * must NEVER scan or terminate provider objects outside its own DB attribution.
 * Two 10-minute boxes rotate naturally at 7 minutes; allow 25 minutes total.
 * Exact-owned boxes/snapshots are cleaned up AFTER pass/failure, never to pass
 * acceptance. Cleanup failures fail the test and print only opaque resource IDs.
 */
import { test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  addSessionSystemUpdate,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  readLease,
} from "@opengeni/db";
import { acquireSharedTestDatabase, testSettings } from "@opengeni/testing";
import { createObservability } from "@opengeni/observability";
import { RoutingSandboxSession } from "@opengeni/runtime";
import {
  deleteModalCheckpointSnapshot,
  terminateUnpublishedSandboxSession,
  isProviderSandboxNotFoundError,
  type EstablishedSandboxSession,
} from "../../../packages/runtime/src/sandbox";
import { parseExecResponseBanner } from "../../../packages/runtime/src/sandbox/exec-banner";
import { createSandboxLeaseActivities } from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";
import {
  maybePersistWarmWorkspaceSnapshot,
  resumeBoxForTurn,
  sandboxLeaseHolderIdForAttempt,
  type ResumedTurnSandbox,
} from "../src/sandbox-resume";
import { wrapTurnBoxWithRouting } from "../src/sandbox-routing";
import {
  assertRotationEvidence,
  canaryConfiguration,
  requireCanary,
} from "./ope534-rotation-canary-evidence";

const LIFETIME_SECONDS = 600;
const ROTATION_LEAD_MS = 180_000;
const REAPER_MS = 5_000;
const live = process.env.OPENGENI_OPE534_CANARY === "1";

test.skipIf(!live)(
  "OPE534: adopted nonTTY server, later writes, two real deadline rotations",
  async () => {
    const config = canaryConfiguration(process.env);
    let dockerEndpoint: unknown;
    try {
      dockerEndpoint = JSON.parse(
        execFileSync(
          "docker",
          ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ),
      );
    } catch {
      throw new Error("OPE534 canary: local Docker context is unavailable");
    }
    requireCanary(
      typeof dockerEndpoint === "string" && dockerEndpoint.startsWith("unix://"),
      "refusing a remote Docker database fixture",
    );
    requireCanary(
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() === config.sourceSha,
      "checkout differs from pinned source",
    );
    requireCanary(
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        encoding: "utf8",
      }).trim() === "",
      "tracked source is dirty",
    );
    const runId = crypto.randomUUID();
    const shared = await acquireSharedTestDatabase("ope534_rotation_canary");
    requireCanary(shared, "Docker/fully migrated isolated database unavailable (not a skip)");
    requireCanary(
      new URL(shared.adminUrl).hostname === "127.0.0.1" &&
        new URL(shared.adminUrl).pathname.startsWith("/og_ope534_rotation_canary_"),
      "unexpected database attribution",
    );
    const client = createDb(shared.appUrl);
    const { db } = client;
    const admin = shared.admin;
    const settings = testSettings({
      databaseUrl: shared.appUrl,
      deploymentRevision: config.sourceSha,
      sandboxBackend: "modal",
      sandboxOwnershipEnabled: true,
      modalAppName: `ope534-canary-${runId}`,
      modalEnvironment: config.environment,
      modalTokenId: process.env.MODAL_TOKEN_ID!,
      modalTokenSecret: process.env.MODAL_TOKEN_SECRET!,
      modalImageRef: config.image,
      modalWorkspacePersistence: "snapshot_filesystem",
      modalTimeoutSeconds: LIFETIME_SECONDS,
      modalIdleTimeoutSeconds: LIFETIME_SECONDS,
      sandboxRotationLeadMs: ROTATION_LEAD_MS,
      sandboxLeaseReaperPeriodMs: REAPER_MS,
      sandboxIdleGraceMs: 30_000,
      sandboxSnapshotTimeoutMs: 60_000,
      sandboxDrainSnapshotTimeoutMs: 60_000,
      sandboxSnapshotIntervalMs: 0,
      sandboxDesktopEnabled: false,
      sandboxTerminalEnabled: false,
      sandboxPreparationProfiles: "none",
      sandboxEnvAllowlist: "",
    });
    const observability = createObservability(settings, { component: "ope534-isolated-canary" });
    const services = { db, settings, observability, objectStorage: null };
    const activities = createSandboxLeaseActivities(
      async (): Promise<ActivityServices> => ({
        ...services,
        bus: null as never,
        runtime: null as never,
        documentServices: null as never,
        wakeSessionWorkflow: null,
        signalSessionAttemptQuiesced: null,
        inspectSessionAttemptActivity: null,
        summarizeContextForCompaction: async () => {
          throw new Error("Canary must not invoke inference");
        },
      }),
      { sweepModalOrphans: async () => 0 },
    );
    const established = new Map<string, EstablishedSandboxSession>();
    const orderlyTerminated = new Set<string>();
    const ownedResumes: ResumedTurnSandbox[] = [];
    const hashes: Record<string, string> = {};
    const evidence: unknown[] = [];
    let failure: unknown;
    let workspaceId: string | undefined;
    try {
      const [account] = await admin<
        { id: string }[]
      >`insert into managed_accounts(name) values (${`ope534-${runId}`}) returning id`;
      const [workspace] = await admin<
        { id: string }[]
      >`insert into workspaces(account_id,name) values (${account!.id},${`ope534-${runId}`}) returning id`;
      workspaceId = workspace!.id;
      const accountId = account!.id;
      await admin`insert into workspace_inference_controls(workspace_id,account_id) values (${workspaceId},${accountId})`;
      const session = await createSession(db, {
        accountId,
        workspaceId,
        initialMessage: "OPE534 isolated acceptance",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "low",
        latencyMode: "standard",
        sandboxBackend: "modal",
      });
      const ids = {
        accountId,
        workspaceId,
        sessionId: session.id,
        sandboxGroupId: session.sandboxGroupId,
      };
      await initializeSessionStartAtomically(db, {
        ...ids,
        reasoningEffortFallback: "low",
        createdEventPayload: {},
      });
      let first = true;
      async function turn() {
        if (!first) {
          await addSessionSystemUpdate(db, {
            ...ids,
            kind: "agent_message",
            classification: "info",
            sourceId: runId,
            dedupeKey: crypto.randomUUID(),
            summary: "Continue isolated canary fixture",
            payload: {
              type: "agent_message",
              text: "Continue isolated canary fixture",
              operationId: crypto.randomUUID(),
            },
          });
        }
        first = false;
        const attemptId = crypto.randomUUID();
        const claim = await claimSessionWorkForAttempt(db, ids.workspaceId, {
          sessionId: session.id,
          workflowId: `session-${session.id}`,
          workflowRunId: crypto.randomUUID(),
          attemptId,
          dispatchId: crypto.randomUUID(),
          trigger: { kind: "next" },
        });
        requireCanary(claim.action === "claimed", "canonical turn admission did not claim");
        const holderId = sandboxLeaseHolderIdForAttempt(attemptId);
        const resumed = await resumeBoxForTurn(
          services,
          { ...ids, backend: "modal", image: config.image, environment: {} },
          "turn",
          holderId,
        );
        ownedResumes.push(resumed);
        requireCanary(resumed.established.instanceId, "provider instance was not published");
        established.set(resumed.established.instanceId, resumed.established);
        const route = wrapTurnBoxWithRouting(
          {
            db,
            settings,
            opJournal: { attachGeneration: () => "1", persistSettled: async () => undefined },
          },
          {
            workspaceId: ids.workspaceId,
            sessionId: session.id,
            environment: {},
            workspaceMutationFence: {
              accountId,
              turnId: claim.turn.id,
              executionGeneration: claim.turn.executionGeneration,
              attemptId,
            },
            homeLease: {
              accountId,
              sandboxGroupId: session.sandboxGroupId,
              leaseEpoch: resumed.leaseEpoch,
              instanceId: resumed.established.instanceId,
              backend: "modal",
            },
          },
          resumed.established,
        ).session;
        requireCanary(
          route instanceof RoutingSandboxSession,
          "canonical routing proxy unavailable",
        );
        return {
          resumed,
          route,
          attemptId,
          turnId: claim.turn.id,
          async complete() {
            await applySessionTurnSettlement(db, ids.workspaceId, {
              sessionId: session.id,
              turnId: claim.turn.id,
              triggerEventId: claim.turn.triggerEventId,
              attemptId,
              turnStatus: "completed",
              sessionStatus: "idle",
              activeTurnId: null,
              events: [{ type: "turn.completed", payload: { output: "canary fixture complete" } }],
            });
            await resumed.release({ workspaceWritersQuiesced: true });
            const [row] = await admin`select status from session_turns where id=${claim.turn.id}`;
            requireCanary(row?.status === "completed", "turn did not complete");
          },
        };
      }
      async function command(route: RoutingSandboxSession, cmd: string): Promise<string> {
        let page = await route.execCommand({
          cmd,
          tty: false,
          yieldTimeMs: 1_000,
          maxOutputTokens: 4_000,
        });
        let output = "";
        const deadline = Date.now() + 60_000;
        for (;;) {
          requireCanary(typeof page === "string", "command response is not a provider receipt");
          output += page;
          const banner = parseExecResponseBanner(page);
          if (banner.kind === "exited") {
            requireCanary(banner.exitCode === 0, "routed command failed");
            return output;
          }
          requireCanary(
            banner.kind === "running" && Date.now() < deadline,
            "command did not settle within its budget",
          );
          page = await route.writeStdin({
            sessionId: banner.sessionId,
            chars: "",
            yieldTimeMs: 1_000,
            maxOutputTokens: 4_000,
          });
        }
      }
      async function writeMarker(route: RoutingSandboxSession, name: string) {
        const value = `${runId}:${name}`;
        // All interpolated values are internally generated UUIDs/fixed labels.
        const path = `/workspace/ope534-${name}`;
        await command(route, `printf '%s' '${value}' > '${path}'`);
        hashes[path] = createHash("sha256").update(value).digest("hex");
      }
      async function verifyMarkers(route: RoutingSandboxSession) {
        const result: Record<string, string> = {};
        for (const [path, hash] of Object.entries(hashes)) {
          // A zero exit from sha256sum -c is required, not a match in arbitrary stdout.
          await command(route, `printf '%s  %s\\n' '${hash}' '${path}' | sha256sum -c -`);
          result[path] = hash;
        }
        return result;
      }
      let current = await turn();
      await writeMarker(current.route, "baseline");
      for (let cycle = 1; cycle <= 2; cycle++) {
        const snapshot = maybePersistWarmWorkspaceSnapshot(
          services,
          { ...ids, turnId: current.turnId, attemptId: current.attemptId },
          current.resumed.established.session,
          current.resumed.leaseEpoch,
          undefined,
          true,
        );
        requireCanary(await snapshot, "preceding checkpoint did not publish");
        await snapshot.settled;
        const baseline = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
        requireCanary(
          baseline?.archiveComplete && baseline.archiveGeneration !== null,
          "baseline checkpoint is incomplete",
        );
        const started = await current.route.execCommand({
          cmd: "exec python3 -m http.server 18765 --bind 127.0.0.1 --directory /workspace",
          tty: false,
          yieldTimeMs: 1_000,
          maxOutputTokens: 1_000,
        });
        requireCanary(typeof started === "string", "server start response missing");
        const banner = parseExecResponseBanner(started);
        requireCanary(banner.kind === "running", "nonTTY server did not yield");
        await current.route.adoptRetainedProcessAsBackgroundCommand(banner.sessionId);
        const [retained] =
          await admin`select p.id,p.holder_id,p.provider_command,b.state as background_state from sandbox_retained_processes p join session_background_commands b on b.retained_process_id=p.id where p.workspace_id=${ids.workspaceId} and p.session_id=${session.id} and p.provider_session_id=${banner.sessionId} and p.state='active'`;
        requireCanary(retained?.background_state === "running", "server was not durably adopted");
        requireCanary(
          retained.provider_command && retained.provider_command.pty !== true,
          "server is not a durable nonTTY provider command",
        );
        await current.complete();
        current = await turn();
        requireCanary(
          current.resumed.leaseEpoch === baseline.leaseEpoch,
          "background command did not preserve its completed-turn lease",
        );
        await command(
          current.route,
          "python3 -c 'import urllib.request; urllib.request.urlopen(\"http://127.0.0.1:18765\", timeout=5).read()'",
        );
        await writeMarker(current.route, `after-turn-${cycle}`);
        await current.complete();
        const before = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
        requireCanary(
          before?.instanceId && before.providerDeadlineAt && before.providerCreatedAt,
          "real provider clocks missing",
        );
        requireCanary(
          before.archiveGeneration === baseline.archiveGeneration &&
            before.workspaceGeneration > baseline.archiveGeneration,
          "later write is not newer than the preceding checkpoint",
        );
        requireCanary(
          before.providerDeadlineAt.getTime() - before.providerCreatedAt.getTime() ===
            LIFETIME_SECONDS * 1_000,
          "provider lifetime differs from isolated configuration",
        );
        let rotationRequestedAt: number | null = null;
        let rotationReason: string | null = null;
        let nextProgressAt = 0;
        for (;;) {
          requireCanary(
            Date.now() < before.providerDeadlineAt.getTime() - 5_000,
            "deadline exhausted without orderly capture (do not clear blockers)",
          );
          await activities.reapSandboxLeases();
          const lease = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
          requireCanary(lease, "lease disappeared");
          if (lease.rotationRequestedAt) {
            rotationRequestedAt = lease.rotationRequestedAt.getTime();
            rotationReason = lease.rotationReason;
          }
          if (Date.now() >= nextProgressAt) {
            console.info(
              JSON.stringify({
                kind: "ope534.awaiting-rotation",
                runId,
                cycle,
                instanceId: before.instanceId,
                liveness: lease.liveness,
                providerDeadlineAt: before.providerDeadlineAt.toISOString(),
                rotationRequestedAt,
              }),
            );
            nextProgressAt = Date.now() + 60_000;
          }
          if (lease.liveness === "cold") break;
          await Bun.sleep(REAPER_MS);
        }
        const cold = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
        requireCanary(
          cold?.archiveComplete &&
            cold.archiveGeneration !== null &&
            cold.currentCheckpointArtifactId,
          "cold lease has no complete publication",
        );
        const [process] =
          await admin`select state,reconcile_proof_outcome,settled_at from sandbox_retained_processes where id=${retained.id}`;
        const [holders] =
          await admin`select count(*)::int as count from sandbox_lease_holders where lease_id=${cold.id} and holder_id=${retained.holder_id}`;
        const [artifact] =
          await admin`select state,source_instance_id,source_lease_epoch,source_workspace_generation,published_at,created_at from sandbox_checkpoint_artifacts where id=${cold.currentCheckpointArtifactId}`;
        requireCanary(
          artifact?.source_instance_id === before.instanceId &&
            artifact.source_lease_epoch === before.leaseEpoch,
          "checkpoint has wrong predecessor identity",
        );
        current = await turn();
        const restoredHashes = await verifyMarkers(current.route);
        const after = await readLease(db, ids.workspaceId, ids.sandboxGroupId);
        requireCanary(
          after?.instanceId && rotationRequestedAt !== null,
          "rotation admission was not observed",
        );
        const receipt = {
          cycle,
          predecessor: before.instanceId,
          successor: after.instanceId,
          predecessorEpoch: before.leaseEpoch,
          successorEpoch: after.leaseEpoch,
          providerCreatedAt: before.providerCreatedAt.getTime(),
          providerDeadlineAt: before.providerDeadlineAt.getTime(),
          rotationRequestedAt,
          rotationReason,
          completedAt: Date.now(),
          rotationLeadMs: ROTATION_LEAD_MS,
          processState: String(process?.state),
          processProof: process?.reconcile_proof_outcome ?? null,
          processSettledAt: process?.settled_at?.getTime() ?? NaN,
          remainingProcessHolders: holders?.count ?? -1,
          baselineGeneration: baseline.archiveGeneration,
          writtenGeneration: before.workspaceGeneration,
          publishedGeneration: cold.archiveGeneration,
          checkpointArtifactId: cold.currentCheckpointArtifactId,
          checkpointVerified:
            artifact?.state === "current" &&
            artifact.published_at !== null &&
            artifact.source_workspace_generation === cold.archiveGeneration,
          checkpointCapturedAt: artifact?.created_at?.getTime() ?? NaN,
          captureReleased: cold.archiveCapture === null && after.archiveCapture === null,
          expectedHashes: { ...hashes },
          restoredHashes,
        };
        assertRotationEvidence(receipt);
        orderlyTerminated.add(before.instanceId);
        evidence.push(receipt);
        console.info(
          JSON.stringify({
            kind: "ope534.rotation",
            runId,
            sourceSha: config.sourceSha,
            image: config.image,
            ...receipt,
          }),
        );
      }
      // A new write on the second successor must survive one final ordinary idle
      // drain/restore too; this is NOT counted as a third deadline rotation.
      await writeMarker(current.route, "after-second-rotation");
      await current.complete();
      const finalDeadline = Date.now() + 120_000;
      while ((await readLease(db, ids.workspaceId, ids.sandboxGroupId))?.liveness !== "cold") {
        requireCanary(Date.now() < finalDeadline, "final ordinary drain did not complete");
        await activities.reapSandboxLeases();
        await Bun.sleep(REAPER_MS);
      }
      current = await turn();
      await verifyMarkers(current.route);
      await current.complete();
      requireCanary(evidence.length === 2, "two complete rotations were not recorded");
    } catch (error) {
      failure = error;
      if (workspaceId) {
        try {
          const leases =
            await admin`select id,instance_id,lease_epoch,liveness,workspace_generation,archive_generation,provider_created_at,provider_deadline_at,rotation_requested_at,rotation_reason from sandbox_leases where workspace_id=${workspaceId}`;
          const processes =
            await admin`select id,state,lease_epoch,provider_instance_id,reconcile_proof_outcome,last_reconcile_outcome,settlement_reason,settled_at from sandbox_retained_processes where workspace_id=${workspaceId}`;
          console.error(
            JSON.stringify({
              kind: "ope534.failed",
              runId,
              sourceSha: config.sourceSha,
              leases,
              processes,
            }),
          );
        } catch {
          console.error(JSON.stringify({ kind: "ope534.diagnostics-unavailable", runId }));
        }
      }
    } finally {
      const cleanupFailures: unknown[] = [];
      for (const resumed of ownedResumes)
        await resumed.release().catch((error) => cleanupFailures.push(error));
      for (const [instanceId, handle] of established) {
        if (orderlyTerminated.has(instanceId)) continue;
        try {
          await terminateUnpublishedSandboxSession(handle);
        } catch (error) {
          if (!isProviderSandboxNotFoundError("modal", error))
            cleanupFailures.push(new Error(`Exact-owned box cleanup unconfirmed: ${instanceId}`));
        }
      }
      if (workspaceId) {
        const artifacts =
          await admin`select object_id,provider_binding_key from sandbox_checkpoint_artifacts where workspace_id=${workspaceId} and state <> 'deleted'`;
        for (const artifact of artifacts) {
          try {
            await deleteModalCheckpointSnapshot(
              settings,
              artifact.provider_binding_key,
              artifact.object_id,
            );
          } catch {
            cleanupFailures.push(
              new Error(`Exact-owned snapshot cleanup unconfirmed: ${artifact.object_id}`),
            );
          }
        }
      }
      await client.close();
      await shared.release();
      if (cleanupFailures.length)
        failure = new AggregateError(
          [...(failure ? [failure] : []), ...cleanupFailures],
          "OPE534 canary/cleanup failed",
        );
    }
    if (failure) throw failure;
    console.info(
      JSON.stringify({
        kind: "ope534.accepted",
        runId,
        sourceSha: config.sourceSha,
        image: config.image,
        rotations: 2,
        markerHashes: hashes,
        cleanup: "complete",
      }),
    );
  },
  1_500_000,
);
