/**
 * Sandbox rotation integration acceptance, deliberately OFF in ordinary test runs.
 *
 * Prerequisites (parent must integrate the prevention fix first):
 * - pinned repository Bun + installed dependencies; authorized disposable PG17
 *   with pgvector at 127.0.0.1:55434, postgres trust login. Select it with
 *   OPENGENI_SANDBOX_ROTATION_NATIVE_POSTGRES=LOCAL_DISPOSABLE_55434. The fixture allocates
 *   a unique migrated database and restricted app role. Docker fallback and
 *   arbitrary external DB overrides are forbidden.
 * - integrated supervision readiness migration and compatible readers deployed
 *   before launching: this isolated Settings object explicitly enables
 *   OPENGENI_MODAL_COMMAND_SUPERVISION_ENABLED; no shared config is changed.
 * - reviewed integrated git HEAD, no tracked modifications; exact anonymous-
 *   pull canonical GHCR sandbox image digest built from that candidate (with
 *   native supervisor). Before allocation, verify the immutable OCI config's
 *   source/revision labels through the index/manifest/config digest chain. This
 *   proves embedded source identity, not signed build attestation.
 * - pre-provisioned dedicated Modal environment sandbox-rotation-canary-<unique suffix>;
 *   MODAL_TOKEN_ID/MODAL_TOKEN_SECRET authorized for it. Never staging/main.
 *
 * Run only after explicit billable-canary authorization, from the checkout root:
 * OPENGENI_SANDBOX_ROTATION_CANARY=1
 * OPENGENI_SANDBOX_ROTATION_CANARY_AUTHORIZATION=ISOLATED_MODAL_CANARY_ONLY
 * OPENGENI_SANDBOX_ROTATION_SOURCE_SHA=<integrated 40-character HEAD>
 * OPENGENI_SANDBOX_ROTATION_IMAGE_REF=ghcr.io/cloudgeni-ai/opengeni-sandbox@sha256:<digest>
 * OPENGENI_SANDBOX_ROTATION_MODAL_ENVIRONMENT=sandbox-rotation-canary-<unique suffix>
 * OPENGENI_SANDBOX_ROTATION_NATIVE_POSTGRES=LOCAL_DISPOSABLE_55434
 * bun test apps/worker/test/sandbox-rotation-canary.live.test.ts
 *
 * This exercises canonical route/adoption/settlement/resume and composite reaper
 * APIs; it does not run inference, Temporal, or an HTTP frontend. Only fixture
 * tenant rows are inserted manually. Never backdate leases, delete holders,
 * force rotation, fake provider proofs, or rewrite command/process state.
 * The only disabled reaper edge is fleet-wide orphan discovery: the harness
 * must NEVER scan or terminate provider objects outside its own DB attribution.
 * Two 10-minute boxes rotate naturally at 6 minutes; allow 25 minutes total.
 * Exact-owned boxes/snapshots are cleaned up AFTER pass/failure, never to pass
 * acceptance. Cleanup failures fail the test and print only opaque resource IDs.
 *
 * The explicit OPENGENI_SANDBOX_ROTATION_COHORT=desktop-native mode instead uses
 * opengenipublicneuacr.azurecr.io/opengeni-desktop@sha256:<digest> (its canonical
 * GHCR mirror is optional), OPENGENI_SANDBOX_ROTATION_API_IMAGE_REF and
 * OPENGENI_SANDBOX_ROTATION_WORKER_IMAGE_REF as exact GHCR candidate digests.
 * The trusted host must verify/pull and launch precisely that worker digest,
 * without source mounts, using host networking for the isolated PG17 endpoint.
 * The fixture uses image-baked source tests/dependencies and verifies the real
 * root-owned /opt/opengeni/source-sha plus all three OCI digest/config chains;
 * .git is neither available nor required inside the worker image. Private pulls
 * may supply fixture-only *_GHCR_PULL_TOKEN / *_ACR_PULL_TOKEN bearer tokens.
 * The original headless checkout/cleanliness/provenance guards remain intact.
 *
 * Desktop mode keeps the global background flag false. Factual bare pipe/PTY
 * native receipts from an unenrolled bootstrap group are hashed before an
 * isolated owner qualification is published. Only a NEW explicit Modal group
 * with the canonical fixture grant's trusted subject creator and preselected
 * original request key can acquire its birth. Bootstrap uses a distinct key;
 * caller metadata supplies neither selector. Canonical keyed creation owns the
 * request identity/winner transaction. Its exact stock import and snapshot lineage must pass
 * the canonical physical create fences. Real worker and core/API constructors
 * run through the production cancellation controller. Native receipt, complete
 * output, writer/holder settlement, genuine PTY job control, two-second physical
 * cancellation and 35-second delayed/escaped-zombie checks are mandatory, as
 * are every original natural-rotation and captured-file assertion below.
 * This is native lifecycle qualification. Public HTTP/Temporal/UI Steer/Pause
 * acceptance is an additional independent workbench check, never inferred here.
 */
import { test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  acquireLease,
  addSessionSystemUpdate,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createSessionWithIdempotencyKeyResult,
  initializeSessionStartAtomically,
  readLease,
  releaseLeaseHolder,
  loadNativeCommandBirthQualification,
  inspectNativeCommandProviderQualification,
  publishNativeCommandQualification,
} from "@opengeni/db";
import { requestSessionBackgroundCommandCancellation } from "@opengeni/db/session-background-commands";
import { testSettings } from "@opengeni/testing";
import { supervisedCommandProtocolReady } from "@opengeni/db/retained-provider-commands";
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
  assertSupervisedCanaryCommand,
  canaryConfiguration,
  requireCanary,
} from "./sandbox-rotation-canary-evidence";
import {
  acquireCanaryDatabase,
  requireCanaryDatabaseAttribution,
} from "./sandbox-rotation-canary-database";
import { runCanaryCleanupStages, withCanaryFixture } from "./sandbox-rotation-canary-cleanup";
import { verifyCanaryImageProvenance } from "./sandbox-rotation-canary-provenance";
import { wrapChannelABoxWithRouting } from "../../../packages/core/src/sandbox/routing";
import { resolveModalCheckpointProviderBindingForSession } from "../../../packages/runtime/src/sandbox";
import {
  assertNativeCanaryCompletion,
  assertNativeCanarySettlement,
  desktopCanaryConfiguration,
  nativeCanaryEvidenceHash,
  nativeCanaryTools,
  prepareNativeCanaryControlProgram,
  startNativeCanaryShell,
  waitNativeCanaryControlReady,
  verifyDesktopCanarySource,
  type NativeSettledProjection,
} from "./sandbox-rotation-canary-native";
import {
  assertCanarySupervisionReady,
  assertCompletedTurnPreservedSupervision,
  assertSettledCanarySupervision,
  type CanarySupervisionProjection,
} from "./sandbox-rotation-canary-supervision";

const LIFETIME_SECONDS = 600;
const ROTATION_LEAD_MS = 240_000;
const REAPER_MS = 5_000;
const live = process.env.OPENGENI_SANDBOX_ROTATION_CANARY === "1";
const desktopNative = process.env.OPENGENI_SANDBOX_ROTATION_COHORT === "desktop-native";

test.skipIf(!live)(
  desktopNative
    ? "Sandbox rotation: desktop native new cohort, real pipe/PTY cancellation, two deadline rotations"
    : "Sandbox rotation: adopted nonTTY server, later writes, two real deadline rotations",
  async () => {
    requireCanary(
      !process.env.OPENGENI_SANDBOX_ROTATION_COHORT || desktopNative,
      "unsupported explicit canary cohort",
    );
    const config = desktopNative
      ? desktopCanaryConfiguration(process.env)
      : canaryConfiguration(process.env);
    if (!desktopNative) {
      requireCanary(
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() ===
          config.sourceSha,
        "checkout differs from pinned source",
      );
      requireCanary(
        execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
          encoding: "utf8",
        }).trim() === "",
        "tracked source is dirty",
      );
    }
    // A stale image fails before database or provider resource allocation.
    const imageProvenance = desktopNative
      ? await verifyDesktopCanarySource(desktopCanaryConfiguration(process.env))
      : await verifyCanaryImageProvenance(config.sourceSha, config.image);
    const runId = crypto.randomUUID();
    const markerHashes = await withCanaryFixture(acquireCanaryDatabase, async (shared, defer) => {
      requireCanaryDatabaseAttribution(shared.adminUrl);
      const client = createDb(shared.appUrl);
      defer("application client", () => client.close());
      const { db } = client;
      const admin = shared.admin;
      const settings = {
        ...testSettings({
          databaseUrl: shared.appUrl,
          runtimeDatabaseRole: shared.appRole,
          deploymentRevision: config.sourceSha,
          sandboxBackend: "modal",
          sandboxOwnershipEnabled: true,
          modalAppName: `sandbox-rotation-canary-${runId}`,
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
        }),
        // Requires the integrated prevention runtime and readiness migration.
        modalCommandSupervisionEnabled: !desktopNative,
      };
      if (desktopNative) {
        requireCanary(
          settings.modalCommandSupervisionEnabled === false &&
            (await supervisedCommandProtocolReady(db, "native-subreaper-v1")) &&
            (await supervisedCommandProtocolReady(db, "native-subreaper-pty-v1")),
          "desktop native qualification requires both canonical protocol fences at flag false",
        );
      } else {
        assertCanarySupervisionReady({
          enabled: settings.modalCommandSupervisionEnabled,
          databaseReady: await supervisedCommandProtocolReady(db),
          backend: settings.sandboxBackend,
        });
      }
      const observability = createObservability(settings, {
        component: "sandbox_rotation-isolated-canary",
      });
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
      let workspaceId: string | undefined;
      // Register before the first allocation. LIFO cleanup releases turn leases,
      // terminates owned boxes, deletes snapshots, closes the client, then releases
      // the fixture. Every stage runs even if inventory or earlier cleanup fails.
      defer("checkpoint inventory and deletion", async () => {
        if (!workspaceId) return;
        const artifacts =
          await admin`select object_id,provider_binding_key from sandbox_checkpoint_artifacts where workspace_id=${workspaceId} and state <> 'deleted'`;
        await runCanaryCleanupStages(
          artifacts.map((artifact) => ({
            name: `snapshot ${artifact.object_id}`,
            run: () =>
              deleteModalCheckpointSnapshot(
                settings,
                artifact.provider_binding_key,
                artifact.object_id,
              ),
          })),
        );
      });
      defer("owned provider instances", () =>
        runCanaryCleanupStages(
          [...established].map(([instanceId, handle]) => ({
            name: `box ${instanceId}`,
            run: async () => {
              if (orderlyTerminated.has(instanceId)) return;
              try {
                await terminateUnpublishedSandboxSession(handle);
              } catch (error) {
                if (!isProviderSandboxNotFoundError("modal", error)) throw error;
              }
            },
          })),
        ),
      );
      defer("owned turn leases", () =>
        runCanaryCleanupStages(
          ownedResumes.map((resumed, index) => ({
            name: `turn lease ${index}`,
            run: () => resumed.release(),
          })),
        ),
      );
      try {
        let accountId: string;
        let trustedCreatorSubjectId: string | undefined;
        if (desktopNative) {
          const subjectId = `sandbox-rotation-canary:${runId}`;
          const access = await bootstrapWorkspace(db, {
            accountExternalSource: "sandbox-rotation-canary",
            accountExternalId: runId,
            accountName: `sandbox_rotation-${runId}`,
            workspaceExternalSource: "sandbox-rotation-canary",
            workspaceExternalId: runId,
            workspaceName: `sandbox_rotation-${runId}`,
            subjectId,
          });
          const grant = access.workspaceGrants[0];
          requireCanary(
            grant?.workspaceId && grant.subjectId === subjectId,
            "canonical fixture bootstrap did not return its exact creator grant",
          );
          accountId = grant.accountId;
          workspaceId = grant.workspaceId;
          trustedCreatorSubjectId = grant.subjectId;
        } else {
          const [account] = await admin<
            { id: string }[]
          >`insert into managed_accounts(name) values (${`sandbox_rotation-${runId}`}) returning id`;
          const [workspace] = await admin<
            { id: string }[]
          >`insert into workspaces(account_id,name) values (${account!.id},${`sandbox_rotation-${runId}`}) returning id`;
          workspaceId = workspace!.id;
          accountId = account!.id;
          await admin`insert into workspace_inference_controls(workspace_id,account_id) values (${workspaceId},${accountId})`;
        }
        const sessionInput = {
          accountId,
          workspaceId,
          initialMessage: "Sandbox rotation isolated acceptance",
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "low" as const,
          latencyMode: "standard" as const,
          sandboxBackend: "modal" as const,
        };
        const bootstrapCreateKey = `sandbox-rotation-canary:bootstrap:${runId}`;
        const cohortCreateKey = `sandbox-rotation-canary:cohort:${runId}`;
        async function createDesktopSession(createIdempotencyKey: string) {
          requireCanary(
            desktopNative && trustedCreatorSubjectId,
            "desktop keyed create requires its trusted fixture creator",
          );
          const result = await createSessionWithIdempotencyKeyResult(db, {
            ...sessionInput,
            createdBy: { kind: "subject", subjectId: trustedCreatorSubjectId },
            createIdempotencyKey,
          });
          requireCanary(
            !result.denied && result.created,
            "desktop keyed create did not commit a fresh canonical session winner",
          );
          requireCanary(
            result.session.createdBy.kind === "subject" &&
              result.session.createdBy.subjectId === trustedCreatorSubjectId &&
              result.session.createIdempotencyKey === createIdempotencyKey,
            "canonical session winner did not freeze its exact trusted creator/request key",
          );
          return result.session;
        }
        let session = desktopNative
          ? await createDesktopSession(bootstrapCreateKey)
          : await createSession(db, sessionInput);
        let ids = {
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
        let qualified = false;
        let qualificationId: string | undefined;
        const nativeToolsByRoute = new WeakMap<
          RoutingSandboxSession,
          ReturnType<typeof nativeCanaryTools>
        >();
        const capabilityChecked = new Set<string>();
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
          const nativeTools = desktopNative ? nativeCanaryTools(route) : null;
          if (nativeTools) nativeToolsByRoute.set(route, nativeTools);
          if (desktopNative) {
            const decision = await inspectNativeCommandProviderQualification(db, {
              ...ids,
              providerInstanceId: resumed.established.instanceId,
              leaseEpoch: resumed.leaseEpoch,
              protocol: "native-subreaper-v1",
              sourceSha: config.sourceSha,
            });
            requireCanary(
              decision.status === (qualified ? "enrolled" : "legacy"),
              "physical provider binding differs from the canonical group birth",
            );
            if (qualified)
              requireCanary(
                decision.status === "enrolled" && decision.qualification.id === qualificationId,
                "physical binding changed qualification",
              );
          }
          if (!capabilityChecked.has(resumed.established.instanceId)) {
            // There is no native --probe subcommand. This ordinary routed
            // command must itself launch/settle under the native supervisor,
            // exercising its fail-closed subreaper/pidfd capability checks.
            await command(route, "test -x /usr/local/bin/opengeni-command-supervisor");
            capabilityChecked.add(resumed.established.instanceId);
          }
          return {
            resumed,
            route,
            attemptId,
            turnId: claim.turn.id,
            async complete() {
              if (nativeTools) await nativeTools.controller.waitForQuiescence();
              await applySessionTurnSettlement(db, ids.workspaceId, {
                sessionId: session.id,
                turnId: claim.turn.id,
                triggerEventId: claim.turn.triggerEventId,
                attemptId,
                turnStatus: "completed",
                sessionStatus: "idle",
                activeTurnId: null,
                events: [
                  { type: "turn.completed", payload: { output: "canary fixture complete" } },
                ],
              });
              await resumed.release({ workspaceWritersQuiesced: true });
              const [row] = await admin`select status from session_turns where id=${claim.turn.id}`;
              requireCanary(row?.status === "completed", "turn did not complete");
            },
          };
        }
        async function command(route: RoutingSandboxSession, cmd: string): Promise<string> {
          const nativeTools = nativeToolsByRoute.get(route);
          if (nativeTools) return await nativeTools.command(cmd);
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
            // Observation must not open an unsettled stdin admission: that
            // would fence the supervisor's quiescence receipt during this poll.
            page = await route.writeStdinForProcessRead({
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
          const path = `/workspace/sandbox_rotation-${name}`;
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
        async function supervisionProjection(processId: string) {
          const [row] = await admin<CanarySupervisionProjection[]>`
            select p.provider_command as "providerCommand", p.state, p.exit_code as "exitCode",
              p.settled_at as "settledAt", p.supervision_receipt as "supervisionReceipt",
              p.supervision_output_captured as "supervisionOutputCaptured",
              p.cancellation_requested_at as "cancellationRequestedAt", p.cancellation_reason as "cancellationReason",
              b.state as "backgroundState", b.cancel_requested_at as "backgroundCancelledAt",
              b.exit_code as "backgroundExitCode"
            from sandbox_retained_processes p join session_background_commands b on b.retained_process_id=p.id
            where p.id=${processId} and p.workspace_id=${ids.workspaceId} and p.session_id=${session.id}`;
          return row;
        }
        async function nativeProjection(processId: string) {
          const [row] = await admin<NativeSettledProjection[]>`
            select p.provider_command as "providerCommand", p.state, p.exit_code as "exitCode",
              p.settled_at as "settledAt", p.supervision_receipt as "supervisionReceipt",
              p.supervision_output_captured as "supervisionOutputCaptured",
              p.cancellation_requested_at as "cancellationRequestedAt", p.cancellation_reason as "cancellationReason",
              b.state as "backgroundState", b.cancel_requested_at as "backgroundCancelledAt",
              b.exit_code as "backgroundExitCode",
              (select count(*)::int from sandbox_lease_holders h where h.lease_id=p.lease_id and h.holder_id=p.holder_id) as "remainingHolders",
              (select count(*)::int from sandbox_workspace_mutation_admissions a where a.workspace_id=p.workspace_id
                and (a.id=p.parent_admission_id or (a.actor_kind='process' and a.actor_id=p.id))
                and a.settled_at is null) as "remainingAdmissions"
            from sandbox_retained_processes p left join session_background_commands b on b.retained_process_id=p.id
            where p.id=${processId} and p.workspace_id=${ids.workspaceId} and p.session_id=${session.id}`;
          return row;
        }
        async function bareShellProof(current: Awaited<ReturnType<typeof turn>>, pty: boolean) {
          const tools = nativeCanaryTools(current.route);
          const shell = await startNativeCanaryShell(tools, pty);
          const [retained] = await admin`select id,provider_command from sandbox_retained_processes
            where workspace_id=${ids.workspaceId} and session_id=${session.id}
              and provider_session_id=${shell.sessionId} and state='active'`;
          requireCanary(retained, "bare native shell was not canonically reserved before Start");
          const requestedAt = Date.now();
          tools.controller.cancel(new Error("isolated native lifecycle interruption"));
          await tools.controller.waitForQuiescence();
          const completedAt = Date.now();
          const receipt = assertNativeCanarySettlement(
            retained.provider_command,
            await nativeProjection(retained.id),
            { pty, requestedAt, completedAt, background: false },
          );
          // A receipt is the ownership proof. The original delayed-zombie probe
          // is still required independently, with exact fixture bytes retained.
          await Bun.sleep(35_000);
          const probe = nativeCanaryTools(current.route);
          await probe.command(
            `printf '%s  %s\\n' '${shell.programHash}' '${shell.path}/control-test.sh' | sha256sum -c - && ` +
              `test ! -e '${shell.path}/zombie' && test ! -e '${shell.path}/escaped-zombie'`,
          );
          await probe.controller.waitForQuiescence();
          return {
            ...receipt,
            sourceSha: config.sourceSha,
            image: config.image,
            programHash: shell.programHash,
            delayedZombieAbsent: true,
            escapedZombieAbsent: true,
            genuineJobControl: pty,
            scope: "native-lifecycle-controller",
          };
        }
        async function coreRoutingProof(current: Awaited<ReturnType<typeof turn>>, pty: boolean) {
          const requestId = crypto.randomUUID();
          const holderId = `direct:${requestId}`;
          const attached = await acquireLease(db, {
            ...ids,
            kind: "direct",
            holderId,
            subjectId: session.id,
            backend: "modal",
            leaseTtlMs: 45_000,
          });
          requireCanary(
            attached.role === "attached",
            "API/core proof did not attach exact warm instance",
          );
          const release = () =>
            releaseLeaseHolder(db, {
              ...ids,
              kind: "direct",
              holderId,
              idleGraceMs: settings.sandboxIdleGraceMs,
            });
          defer(`API/core request ${requestId}`, release);
          const wrapped = wrapChannelABoxWithRouting(
            { db, settings },
            {
              accountId,
              workspaceId: ids.workspaceId,
              sessionId: session.id,
              resourceSubjectId: trustedCreatorSubjectId ?? "dev",
              homeLease: {
                sandboxGroupId: ids.sandboxGroupId,
                leaseEpoch: current.resumed.leaseEpoch,
                instanceId: current.resumed.established.instanceId!,
                backend: "modal",
              },
              directRequest: { requestId, holderId },
            },
            current.resumed.established,
          );
          requireCanary(
            wrapped.session instanceof RoutingSandboxSession,
            "actual API/core constructor missing",
          );
          const tools = nativeCanaryTools(wrapped.session);
          const marker = `CORE_NATIVE_${requestId.replaceAll("-", "")}`;
          const output = await tools.command(`printf '%s' '${marker}'`, pty);
          requireCanary(output.includes(marker), "API/core native output was not captured");
          await tools.controller.waitForQuiescence();
          const [retained] = await admin`select id from sandbox_retained_processes
            where workspace_id=${ids.workspaceId} and session_id=${session.id}
              and owner_actor_kind='direct' and owner_actor_id=${requestId}`;
          requireCanary(retained, "API/core native command was not canonically reserved");
          const proof = assertNativeCanaryCompletion(await nativeProjection(retained.id), pty);
          await release();
          return { ...proof, requestId, scope: "actual-core-channel-a-constructor" };
        }
        async function adoptedStopProof(current: Awaited<ReturnType<typeof turn>>) {
          const tools = nativeCanaryTools(current.route);
          const fixture = await prepareNativeCanaryControlProgram(tools);
          const banner = parseExecResponseBanner(
            await tools.exec(`bash '${fixture.path}/control-test.sh'`),
          );
          requireCanary(banner.kind === "running", "native delayed command did not durably yield");
          await current.route.adoptRetainedProcessAsBackgroundCommand(banner.sessionId);
          await waitNativeCanaryControlReady(tools, fixture.path);
          const [retained] = await admin`select p.id,p.provider_command,b.id as command_id
            from sandbox_retained_processes p join session_background_commands b on b.retained_process_id=p.id
            where p.workspace_id=${ids.workspaceId} and p.session_id=${session.id}
              and p.provider_session_id=${banner.sessionId} and p.state='active' and b.state='running'`;
          requireCanary(retained, "native delayed command was not durably adopted");
          const requestedAt = Date.now();
          const requested = await requestSessionBackgroundCommandCancellation(db, {
            ...ids,
            commandId: retained.command_id,
            subjectId: trustedCreatorSubjectId ?? "dev",
          });
          requireCanary(requested.accepted, "canonical adopted-command stop was not accepted");
          await activities.reapSandboxLeases();
          const completedAt = Date.now();
          const proof = assertNativeCanarySettlement(
            retained.provider_command,
            await nativeProjection(retained.id),
            { pty: false, requestedAt, completedAt, background: true },
          );
          await tools.controller.waitForQuiescence();
          await Bun.sleep(35_000);
          await command(
            current.route,
            `printf '%s  %s\\n' '${fixture.programHash}' '${fixture.path}/control-test.sh' | sha256sum -c - && ` +
              `test ! -e '${fixture.path}/zombie' && test ! -e '${fixture.path}/escaped-zombie'`,
          );
          return {
            ...proof,
            programHash: fixture.programHash,
            delayedZombieAbsent: true,
            escapedZombieAbsent: true,
            scope: "canonical-adopted-command-explicit-stop-not-public-pause",
          };
        }
        let current = await turn();
        if (desktopNative) {
          requireCanary(
            (await loadNativeCommandBirthQualification(db, ids)) === null,
            "bootstrap group was already enrolled",
          );
          const bootstrapGroupId = ids.sandboxGroupId;
          const bootstrap = [
            await bareShellProof(current, false),
            await bareShellProof(current, true),
          ];
          const [create] = await admin`select provider_create_attempt from sandbox_leases
            where workspace_id=${ids.workspaceId} and sandbox_group_id=${bootstrapGroupId}`;
          const binding = await resolveModalCheckpointProviderBindingForSession(
            settings,
            current.resumed.established.session,
          );
          const actualImageId = create?.provider_create_attempt?.imageId;
          requireCanary(
            typeof actualImageId === "string" &&
              /^im-[A-Za-z0-9_-]+$/u.test(actualImageId) &&
              create?.provider_create_attempt?.imageRef === config.image &&
              create?.provider_create_attempt?.providerBindingKey === binding.key,
            "bootstrap lacks authenticated exact stock-image create provenance",
          );
          await current.complete();
          // The composite reaper also owns ordinary idle capture. Finish this
          // unrelated bootstrap group now so its snapshot/drain cannot consume
          // the later adopted-stop command's mandatory two-second fence.
          const bootstrapBeforeDrain = await readLease(db, ids.workspaceId, bootstrapGroupId);
          requireCanary(
            bootstrapBeforeDrain?.instanceId &&
              bootstrapBeforeDrain.providerDeadlineAt &&
              bootstrapBeforeDrain.rotationRequestedAt === null,
            "bootstrap ordinary drain lacks its original live provider binding",
          );
          const bootstrapDrainDeadline = Date.now() + 120_000;
          while ((await readLease(db, ids.workspaceId, bootstrapGroupId))?.liveness !== "cold") {
            requireCanary(
              Date.now() < bootstrapDrainDeadline &&
                Date.now() < bootstrapBeforeDrain.providerDeadlineAt.getTime() - 5_000,
              "bootstrap ordinary idle drain did not complete before provider expiry",
            );
            await activities.reapSandboxLeases();
            await Bun.sleep(REAPER_MS);
          }
          const bootstrapCold = await readLease(db, ids.workspaceId, bootstrapGroupId);
          requireCanary(
            bootstrapCold?.archiveComplete &&
              bootstrapCold.archiveGeneration !== null &&
              bootstrapCold.archiveGeneration >= bootstrapBeforeDrain.workspaceGeneration &&
              bootstrapCold.currentCheckpointArtifactId &&
              bootstrapCold.archiveCapture === null &&
              bootstrapCold.rotationRequestedAt === null,
            "bootstrap ordinary idle drain lacks complete unforced capture publication",
          );
          const [bootstrapArtifact] = await admin`
            select state,source_instance_id,source_lease_epoch,source_workspace_generation,published_at
            from sandbox_checkpoint_artifacts where id=${bootstrapCold.currentCheckpointArtifactId}`;
          requireCanary(
            bootstrapArtifact?.state === "current" &&
              bootstrapArtifact.published_at !== null &&
              bootstrapArtifact.source_instance_id === bootstrapBeforeDrain.instanceId &&
              bootstrapArtifact.source_lease_epoch === bootstrapBeforeDrain.leaseEpoch &&
              bootstrapArtifact.source_workspace_generation === bootstrapCold.archiveGeneration,
            "bootstrap ordinary idle drain published the wrong physical predecessor",
          );
          orderlyTerminated.add(bootstrapBeforeDrain.instanceId);
          const owner = createDb(shared.adminUrl);
          defer("qualification owner client", () => owner.close());
          qualificationId = crypto.randomUUID();
          const acceptanceEvidenceHash = nativeCanaryEvidenceHash({
            sourceSha: config.sourceSha,
            image: config.image,
            providerImageId: actualImageId,
            providerBindingKey: binding.key,
            creatorSubjectId: trustedCreatorSubjectId,
            createIdempotencyKey: cohortCreateKey,
            bootstrap,
          });
          requireCanary(
            trustedCreatorSubjectId,
            "isolated qualification lacks its trusted creator",
          );
          await publishNativeCommandQualification(owner.db, {
            id: qualificationId,
            accountId,
            workspaceId: ids.workspaceId,
            activationGeneration: 1,
            sourceSha: config.sourceSha,
            imageRef: config.image,
            providerImageId: actualImageId,
            providerBindingKey: binding.key,
            creatorSubjectId: trustedCreatorSubjectId,
            createIdempotencyKey: cohortCreateKey,
            protocols: ["native-subreaper-v1", "native-subreaper-pty-v1"],
            acceptanceEvidenceHash,
            enrollmentEnabled: true,
          });
          requireCanary(
            (await loadNativeCommandBirthQualification(db, ids)) === null,
            "qualification retrospectively enrolled bootstrap group",
          );
          const unmatched = await createDesktopSession(
            `sandbox-rotation-canary:unmatched:${runId}`,
          );
          requireCanary(
            (await loadNativeCommandBirthQualification(db, {
              accountId,
              workspaceId: ids.workspaceId,
              sandboxGroupId: unmatched.sandboxGroupId,
            })) === null,
            "qualification enrolled a fresh request with the right creator but wrong original key",
          );
          // Only canonical explicit Modal self-group INSERT can acquire birth.
          session = await createDesktopSession(cohortCreateKey);
          const replay = await createSessionWithIdempotencyKeyResult(db, {
            ...sessionInput,
            createdBy: { kind: "subject", subjectId: trustedCreatorSubjectId },
            createIdempotencyKey: cohortCreateKey,
          });
          requireCanary(
            !replay.denied && !replay.created && replay.session.id === session.id,
            "canonical keyed replay did not return the original qualified session winner",
          );
          ids = {
            accountId,
            workspaceId: ids.workspaceId,
            sessionId: session.id,
            sandboxGroupId: session.sandboxGroupId,
          };
          requireCanary(
            session.sandboxGroupId === session.id && ids.sandboxGroupId !== bootstrapGroupId,
            "cohort did not create a fresh explicit Modal self-group",
          );
          const birth = await loadNativeCommandBirthQualification(db, ids);
          requireCanary(
            birth?.id === qualificationId &&
              birth.acceptanceEvidenceHash === acceptanceEvidenceHash &&
              birth.creatorSubjectId === trustedCreatorSubjectId &&
              birth.createIdempotencyKey === cohortCreateKey,
            "new cohort birth did not freeze the exact creator/key and reviewed native evidence",
          );
          await initializeSessionStartAtomically(db, {
            ...ids,
            reasoningEffortFallback: "low",
            createdEventPayload: {},
          });
          first = true;
          qualified = true;
          current = await turn();
          const cohort = [
            await bareShellProof(current, false),
            await bareShellProof(current, true),
          ];
          const core = [
            await coreRoutingProof(current, false),
            await coreRoutingProof(current, true),
          ];
          const adoptedStop = await adoptedStopProof(current);
          console.info(
            JSON.stringify({
              kind: "sandbox_rotation.native-cohort",
              runId,
              sourceSha: config.sourceSha,
              image: config.image,
              qualificationId,
              bootstrapGroupId,
              cohortGroupId: ids.sandboxGroupId,
              creatorSubjectId: trustedCreatorSubjectId,
              createIdempotencyKey: cohortCreateKey,
              acceptanceEvidenceHash,
              bootstrap,
              cohort,
              core,
              adoptedStop,
              globalBackgroundFlag: false,
              scope: "native-lifecycle-controller-not-public-http-temporal",
            }),
          );
        }
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
          const nativeTools = nativeToolsByRoute.get(current.route);
          const started = nativeTools
            ? await nativeTools.exec(
                "exec python3 -m http.server 18765 --bind 127.0.0.1 --directory /workspace",
              )
            : await current.route.execCommand({
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
          const supervisionIdentity = assertSupervisedCanaryCommand(retained.provider_command);
          await current.complete();
          assertCompletedTurnPreservedSupervision(
            retained.provider_command,
            await supervisionProjection(retained.id),
          );
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
          assertCompletedTurnPreservedSupervision(
            retained.provider_command,
            await supervisionProjection(retained.id),
          );
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
                  kind: "sandbox_rotation.awaiting-rotation",
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
          requireCanary(rotationRequestedAt !== null, "rotation admission was not observed");
          const settledSupervision = assertSettledCanarySupervision(
            retained.provider_command,
            await supervisionProjection(retained.id),
            rotationRequestedAt,
            before.providerDeadlineAt.getTime(),
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
            supervision: supervisionIdentity,
            settledSupervision,
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
              kind: "sandbox_rotation.rotation",
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
        if (workspaceId) {
          try {
            const leases =
              await admin`select id,instance_id,lease_epoch,liveness,workspace_generation,archive_generation,provider_created_at,provider_deadline_at,rotation_requested_at,rotation_reason from sandbox_leases where workspace_id=${workspaceId}`;
            const processes =
              await admin`select id,state,lease_epoch,provider_instance_id,reconcile_proof_outcome,last_reconcile_outcome,settlement_reason,settled_at from sandbox_retained_processes where workspace_id=${workspaceId}`;
            console.error(
              JSON.stringify({
                kind: "sandbox_rotation.failed",
                runId,
                sourceSha: config.sourceSha,
                leases,
                processes,
              }),
            );
          } catch {
            console.error(
              JSON.stringify({ kind: "sandbox_rotation.diagnostics-unavailable", runId }),
            );
          }
        }
        throw error;
      }
      return hashes;
    });
    console.info(
      JSON.stringify({
        kind: "sandbox_rotation.accepted",
        runId,
        sourceSha: config.sourceSha,
        image: config.image,
        imageProvenance,
        rotations: 2,
        markerHashes,
        cleanup: "complete",
      }),
    );
  },
  1_500_000,
);
