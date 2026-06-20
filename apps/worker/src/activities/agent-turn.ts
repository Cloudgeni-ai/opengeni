import {
  claimNextQueuedTurn as claimNextQueuedTurnDb,
  createTurn,
  applyCreditDebitUpToBalance,
  finishTurn,
  getBillingBalance,
  requireFile,
  getSessionEvent,
  getSessionGoal,
  getSessionTurn,
  requireSession,
  recordUsageEvent,
  appendSessionHistoryItems,
  consumeSessionCompactionRequest,
  getActiveSessionHistoryItems,
  nextSessionHistoryPosition,
  requeuePreemptedTurn,
  saveRunState,
  upsertSandboxSessionEnvelope,
  setSessionStatus,
  setSessionLastInputTokens,
  sumUsageQuantity,
  type AppendEventInput,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import {
  sandboxStateEntryFromRunState,
  agentsErrorRunState,
  maxTurnsExceededRunState,
  modelResponseUsageFromSdkEvent,
  normalizeSdkEvent,
  sanitizeHistoryItemsForModel,
  type SandboxFileDownload,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import { calculateModelUsageCostMicros, configuredModelPricing, configuredStaticUsageLimits, type ModelUsageInput, type Settings } from "@opengeni/config";
import { CancelledFailure } from "@temporalio/activity";
import { settingsWithEnabledCapabilityMcpServers } from "./capabilities";
import {
  mergeResourceRefs,
  mergeToolRefs,
} from "./common";
import { maybeCompactContext } from "./context-compaction";
import { loadWorkspaceEnvironmentForRun, sandboxEnvironmentForRun } from "./environment";
import { resolveWorkspaceAgentInstructions, resolveWorkspacePackRuntime, settingsWithPackSandboxImage } from "./packs";
import { notifyParentOfChildTerminal } from "./parent-wake";
import { createSecretRedactor, identityRedactor } from "./redaction";
import { turnInput } from "./run-input";
import {
  createRuntimeBatcher,
  currentActivityContext,
  nextStreamEvent,
  startActivityHeartbeat,
} from "./streaming";
import type {
  ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "./types";
import { createObjectStorage, type ObjectStorage } from "@opengeni/storage";
import { CAPABILITY_DESCRIPTORS, type ResourceRef } from "@opengeni/contracts";

// How long the session workflow holds the loop after a retryable provider
// failure before the goal continuation re-enters the model. Azure/OpenAI TPM
// throttling is minute-granular; anything shorter mostly burns continuation
// budget against the same window.
export const PROVIDER_BACKPRESSURE_DELAY_MS = 60_000;

// Resume notice fed to the model when a turn re-enters after a graceful
// worker shutdown (deploy/rollout restart) checkpointed it mid-flight. The
// agent must not blindly replay side effects it cannot see in its history:
// at most the single in-flight model step was lost, and anything it started
// there may or may not have completed.
export const WORKER_SHUTDOWN_RESUME_TEXT = [
  "[TURN RESUMED AFTER WORKER RESTART] The platform worker running this turn restarted (deploy/rollout) before the turn finished.",
  "Your conversation history above, including this turn's earlier work, is preserved up to the last checkpoint; at most the single in-flight model step after it was lost.",
  "Continue the original task from where it left off. Before repeating any action with side effects, check whether it already happened.",
].join("\n");

// Resume notice for the harder variant: the worker died WITHOUT running the
// graceful checkpoint (SIGKILL, OOM, node loss — surfaced to the workflow as
// a heartbeat-timeout activity failure). Conversation truth is still
// dual-written after every model response, so the bound is the same order as
// a graceful preempt, but nothing after the last reconcile was captured and
// the agent must be even more suspicious about repeated side effects.
export const WORKER_DEATH_RESUME_TEXT = [
  "[TURN RESUMED AFTER WORKER CRASH] The platform worker running this turn died before the turn finished.",
  "Your conversation history above, including this turn's earlier work, is preserved up to the last checkpoint; anything in flight after that checkpoint was lost.",
  "Continue the original task from where it left off. Before repeating any action with side effects, check whether it already happened.",
].join("\n");

/**
 * True when this activity attempt was cancelled because its hosting worker is
 * shutting down gracefully (SIGTERM during a deploy), as opposed to a
 * workflow-requested cancellation (user interrupt) or a server-side timeout.
 */
export function isWorkerShutdownCancellation(error: unknown): boolean {
  return error instanceof CancelledFailure && error.message === "WORKER_SHUTDOWN";
}

/**
 * Compute the conversation-truth rows a reconcile pass should append, given the
 * SDK's current `state.history` and the count already persisted.
 *
 * `state.history` is a computed getter that runs the SDK's orphan-tool-call
 * pruning on every access, so it is non-monotonic: a `function_call` with no
 * settling result yet is transiently absent and a later access yields a
 * different, possibly shorter/reordered list. The old code sliced this list by
 * a blind length watermark and appended at fixed positions with
 * onConflictDoNothing, which could freeze a position with one shape and later
 * persist a `function_call_result` whose `function_call` had been pruned away in
 * an earlier slice — the orphaned tool output that 400s the Responses API and
 * bricks the session on every replay.
 *
 * Defending: sanitize the full current history into an API-valid sequence (the
 * same pure rules the read path uses), then append only the new tail beyond the
 * watermark. A trailing dangling call is dropped here and re-evaluated next
 * pass once its result lands, so a call and its result are written together at
 * consecutive positions and a result is never persisted without its call. The
 * watermark advances to the sanitized length — never past anything unwritten —
 * so a non-monotonic history can never desync it. When previously-persisted
 * rows already exceed the sanitized length (e.g. legacy orphans written before
 * this fix), nothing new is appended and the watermark holds steady.
 */
/**
 * Stable+unique usage source key for one model call, used to build the per-call
 * idempotency key (`usage:model.tokens:${turnId}:${sourceKey}`). The turnId is
 * shared across a re-dispatch of the SAME turn (preemption resume, approval
 * rerun, activity retry), so the sourceKey alone must distinguish calls.
 *
 * - A provider responseId is globally stable+unique, so reuse it verbatim: a
 *   true activity retry that re-emits the same responseId correctly DEDUPES
 *   (one charge), while two distinct calls get distinct ids.
 * - Without a responseId the only fallback was POSITIONAL ("response-1",
 *   "aggregate"), which collides across a re-dispatch — dispatch B's first
 *   call reuses dispatch A's "response-1" key and its charge is silently
 *   dropped (undercharge). Qualifying the positional fallback with the
 *   per-execution dispatch id (the Temporal activityId, unique per scheduled
 *   execution) makes re-dispatched calls distinct while still deduping a
 *   same-execution retry.
 */
export function modelUsageSourceKey(input: {
  responseId?: string | null | undefined;
  dispatchId: string | null;
  positionalKey: string;
}): string {
  if (input.responseId) {
    return input.responseId;
  }
  return input.dispatchId ? `${input.dispatchId}:${input.positionalKey}` : input.positionalKey;
}

export function historyRowsToAppend(
  rawHistory: Array<Record<string, unknown>>,
  // How many items of the CURRENT in-memory history are already persisted (the
  // slice index into `sanitized`). This is the in-memory history length, NOT the
  // total persisted-row count: after a compaction the in-memory history is the
  // short [summary, ...tail, ...new] list, far shorter than the total rows in
  // the table (which still hold the superseded prefix).
  persistedHistoryCount: number,
  // Next free WHOLE-NUMBER absolute position to write at. Decoupled from the
  // slice index because compaction inserts a fractional summary position, so the
  // total-row count no longer equals max(position)+1. Defaults to
  // persistedHistoryCount to preserve the pre-compaction behaviour (contiguous
  // positions from 0) when callers do not pass an explicit next position.
  nextPosition: number = persistedHistoryCount,
): { rows: Array<{ position: number; item: Record<string, unknown> }>; nextWatermark: number; nextPosition: number } {
  const sanitized = sanitizeHistoryItemsForModel(rawHistory);
  if (sanitized.length <= persistedHistoryCount) {
    return { rows: [], nextWatermark: persistedHistoryCount, nextPosition };
  }
  const rows = sanitized.slice(persistedHistoryCount).map((item, offset) => ({
    position: nextPosition + offset,
    item: item as Record<string, unknown>,
  }));
  return { rows, nextWatermark: sanitized.length, nextPosition: nextPosition + rows.length };
}

export function createRunAgentTurnActivity(services: () => Promise<ActivityServices>) {
  return async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
    const { settings, db, bus, runtime, objectStorage, observability, wakeSessionWorkflow } = await services();
    const activityStarted = performance.now();
    const activitySpan = observability.startSpan("worker.run_agent_segment", {
      "opengeni.session_id": input.sessionId,
      "opengeni.workflow_id": input.workflowId,
      "opengeni.trigger_event_id": input.triggerEventId,
    });
    let activityStatus = "unknown";
    let activityError: unknown;
    let turnId: string | undefined;
    let heartbeatTimer: ReturnType<typeof startActivityHeartbeat> | undefined;
    let batcher: ReturnType<typeof createRuntimeBatcher> | null = null;
    let preparedTools: Awaited<ReturnType<OpenGeniRuntime["prepareTools"]>> | null = null;
    let publish: ((events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>, immediate?: boolean) => Promise<void>) | null = null;
    let turnStartedPublished = false;
    let stream: Awaited<ReturnType<OpenGeniRuntime["runStream"]>> | undefined;
    // Dual-write of conversation truth (issue #35): completed items are
    // reconciled into session_history_items after every model response and at
    // every turn-end path (idempotent on position), and the sandbox recovery
    // envelope is upserted alongside. Best-effort by design: persistence
    // problems must never fail the run.
    //
    // Orphaned-tool-output guard: `stream.state.history` is NOT a plain
    // append-only array — it is a computed getter
    // (`getTurnInput(originalInput, generatedItems)`) that runs the SDK's
    // `dropOrphanToolCalls` on every access, so a `function_call` with no
    // settling result yet is transiently ABSENT from history and a later
    // reconcile sees a DIFFERENT, shorter/reordered list. A blind length
    // watermark with onConflictDoNothing-on-position then freezes the first
    // shape of a position and can persist a `function_call_result` at a tail
    // position while its `function_call` was pruned away in an earlier slice
    // and never written — the orphan that bricks the session. We defend against
    // it by sanitizing the current history into an API-valid sequence (the same
    // pure function the read path uses) before persisting: a dangling call is
    // never persisted (it is deferred until its result exists, when the pair is
    // written together at consecutive positions), and a result is never
    // persisted without its preceding call. The watermark counts only items we
    // actually persisted, so a non-monotonic history can never desync it.
    let persistedHistoryCount = 0;
    let historyCountAtTurnStart = 0;
    // Next free WHOLE-NUMBER absolute position to append at. Tracked separately
    // from persistedHistoryCount (the in-memory slice index) because a compaction
    // inserts a fractional summary position, so total rows no longer equal
    // max(position)+1 and the slice index can no longer double as the position.
    let nextHistoryPosition = 0;
    const reconcileConversationTruth = async () => {
      if (!stream || !turnId) {
        return;
      }
      try {
        const rawHistory = (stream.state as { history?: unknown[] }).history;
        if (Array.isArray(rawHistory)) {
          const { rows, nextWatermark, nextPosition } = historyRowsToAppend(
            rawHistory as Array<Record<string, unknown>>,
            persistedHistoryCount,
            nextHistoryPosition,
          );
          if (rows.length > 0) {
            await appendSessionHistoryItems(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId,
              items: rows,
            });
          }
          persistedHistoryCount = nextWatermark;
          nextHistoryPosition = nextPosition;
        }
        const envelope = sandboxStateEntryFromRunState(stream.state);
        if (envelope) {
          await upsertSandboxSessionEnvelope(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            envelope,
          });
        }
      } catch (persistError) {
        console.error("session history dual-write failed (run unaffected)", persistError);
      }
    };
    // Reassigned after the workspace environment loads; the publish closure is
    // created (and used for turn.started) before the environment is available.
    let redact: (payload: unknown) => unknown = identityRedactor;
    let environmentId = "";
    // Hoisted for the preemption path: an approval-decision rerun must
    // re-enter through the approval resume path (its frozen mid-flight state
    // only exists in the RunState blob), never through a swapped trigger.
    let triggerType: string | null = null;
    try {
      const capabilitySettings = await settingsWithEnabledCapabilityMcpServers(db, input.workspaceId, settings);
      runtime.configure(capabilitySettings);
      const session = await requireSession(db, input.workspaceId, input.sessionId);
      const trigger = await getSessionEvent(db, input.workspaceId, input.triggerEventId);
      if (!trigger) {
        throw new Error(`Trigger event not found: ${input.triggerEventId}`);
      }
      triggerType = trigger.type;
      let turn = input.turnId ? await getSessionTurn(db, input.workspaceId, input.turnId) : await claimNextQueuedTurnDb(db, input.workspaceId, input.sessionId, input.workflowId);
      if (!turn && !input.turnId) {
        const createdTurnId = await createTurn(db, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          temporalWorkflowId: input.workflowId,
          triggerEventId: input.triggerEventId,
        });
        turn = await getSessionTurn(db, input.workspaceId, createdTurnId);
      }
      if (!turn) {
        throw new Error(`Session turn not found for trigger: ${input.triggerEventId}`);
      }
      turnId = turn.id;
      await ensureRunAllowed(settings, db, input.accountId, input.workspaceId);
      const activityContext = currentActivityContext();
      // Setup (environment load, MCP connects, sandbox restore) does not
      // stream and so never observes cancellation on its own; these explicit
      // checks let a graceful shutdown preempt the turn before the worker is
      // force-killed instead of riding the setup to a heartbeat timeout.
      const throwIfWorkerShuttingDown = () => {
        const reason = activityContext?.cancellationSignal.reason;
        if (isWorkerShutdownCancellation(reason)) {
          throw reason;
        }
      };
      heartbeatTimer = startActivityHeartbeat(activityContext, {
        phase: "running",
        sessionId: input.sessionId,
        turnId,
      });
      let producerSeq = 0;
      // One producer per activity execution, not per turn: a turn can run
      // again on the same workflow (preemption resume, approval rerun), and
      // each execution restarts producerSeq at 1 — a shared producer id would
      // trip the per-producer uniqueness constraint on the event log. The
      // Temporal activity id is unique per scheduled execution.
      const producerId = `${input.workflowId}:${turnId}${activityContext ? `:${activityContext.info.activityId}` : ""}`;
      // Unique per scheduled activity execution (Temporal activityId). Folded
      // into positional usage source keys so a re-dispatch of this turn does
      // not collide its model-call charges with the prior dispatch's. A genuine
      // activity retry reuses the same activityId, so its re-emitted calls keep
      // deduping (no double charge).
      const dispatchId = activityContext?.info.activityId ?? null;
      publish = async (events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>, immediate = false) => {
        const inputs = events.map((event) => ({
          ...event,
          payload: redact(event.payload),
          turnId: turnId!,
          producerId,
          producerSeq: ++producerSeq,
        }));
        await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, inputs);
        activityContext?.heartbeat({ phase: "events_published", sessionId: input.sessionId, turnId, producerSeq });
        if (immediate) {
          await Bun.sleep(0);
        }
      };
      activityContext?.heartbeat({ phase: "turn_started", sessionId: input.sessionId, turnId });

      // A shutdown that landed during claim/billing setup preempts before the
      // turn visibly starts: nothing ran yet, so the requeued turn replays the
      // original trigger cleanly on a healthy worker.
      throwIfWorkerShuttingDown();
      await setSessionStatus(db, input.workspaceId, input.sessionId, "running", turnId);
      await publish([
        { type: "session.status.changed", payload: { status: "running" } },
        { type: "turn.started", payload: { triggerEventId: input.triggerEventId } },
      ], true);
      turnStartedPublished = true;

      // Pack-scoped runtime: enabled packs may declare the sandbox image this
      // workspace's sessions run in and skills for the sandbox skill index.
      // Resolved after turn.started so a composition conflict (two enabled
      // packs declaring images) fails the turn with its plain error instead
      // of failing the activity opaquely.
      const packRuntime = await resolveWorkspacePackRuntime(db, input.workspaceId);
      // Workspace tier of the agent-persona resolution (session > workspace >
      // deployment default). null means the workspace has no override, so the
      // runtime falls back to runSettings.agentInstructionsTemplate (the
      // deployment default, byte-identical to the historical preamble).
      const workspaceAgentInstructions = await resolveWorkspaceAgentInstructions(db, input.workspaceId);
      const runSettings = {
        ...settingsWithPackSandboxImage(capabilitySettings, packRuntime.sandboxImage),
        openaiModel: turn.model,
        openaiReasoningEffort: turn.reasoningEffort,
        sandboxBackend: turn.sandboxBackend,
      };
      const turnResources = mergeResourceRefs(session.resources, turn.resources);
      const turnTools = mergeToolRefs(session.tools, turn.tools);
      const workspaceEnvironment = await loadWorkspaceEnvironmentForRun(db, runSettings, input.workspaceId, session.environmentId);
      environmentId = workspaceEnvironment?.id ?? "";
      redact = createSecretRedactor(
        Object.entries(workspaceEnvironment?.values ?? {}).map(([name, value]) => ({ name, value })),
      );
      const sandboxEnvironment = await sandboxEnvironmentForRun(runSettings, turnResources, workspaceEnvironment?.values ?? {});
      const fileResourceDownloads = await sandboxFileDownloadsForRun(runSettings, db, objectStorage, input.workspaceId, turnResources);
      throwIfWorkerShuttingDown();
      preparedTools = await runtime.prepareTools(runSettings, turnTools, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        subjectId: "worker:first-party-mcp",
        subjectLabel: "OpenGeni worker",
        // Manager-style sessions carry a creation-validated permission set
        // for their first-party MCP token; null keeps the fixed default.
        ...(session.firstPartyMcpPermissions?.length ? { firstPartyPermissions: session.firstPartyMcpPermissions } : {}),
      });
      const agent = runtime.buildAgent(runSettings, turnResources, {
        reasoningEffort: turn.reasoningEffort,
        sandboxEnvironment,
        fileResourceDownloads,
        mcpServers: preparedTools.mcpServers,
        ...(packRuntime.skills.length > 0 ? { packSkills: packRuntime.skills } : {}),
        ...(workspaceAgentInstructions ? { instructionsTemplate: workspaceAgentInstructions } : {}),
        ...(workspaceEnvironment
          ? {
            workspaceEnvironment: {
              name: workspaceEnvironment.name,
              description: workspaceEnvironment.description,
              variableNames: Object.keys(workspaceEnvironment.values),
            },
          }
          : {}),
      });
      // Pre-turn client-side context compaction (Azure path). When the
      // resolved mode is "client" and the last turn's input tokens crossed the
      // soft budget, this summarizes the orphan-safe old prefix into one user
      // message and supersedes the summarized rows BEFORE the history is read
      // for this turn, so the model sees [summary, ...recent tail] + new input.
      // Best-effort: a no-op or failure leaves the un-compacted history intact.
      // Skipped on approval/preempt resumes (no fresh user turn; the frozen
      // RunState or in-flight tail must replay verbatim).
      if (triggerType === "user.message" || triggerType === "goal.continuation") {
        try {
          // Operator /compact (the slash command) sets a durable request flag;
          // consume it atomically so a forced compaction runs now even when the
          // budget trigger would not fire. Only the turn that observes the flag
          // runs it, so concurrent turns can't double-compact.
          const forced = await consumeSessionCompactionRequest(db, input.workspaceId, input.sessionId);
          const outcome = await maybeCompactContext(
            db,
            runSettings,
            { accountId: input.accountId, workspaceId: input.workspaceId, sessionId: input.sessionId, turnId },
            session.lastInputTokens,
            undefined,
            forced ? { force: true } : {},
          );
          if (outcome.compacted) {
            // trigger precedence: an explicit operator /compact wins for the
            // event label; otherwise a hard-forced (at/over hardFraction*B)
            // compaction is surfaced as "hard" so the backstop firing is
            // observable downstream, and the default soft trigger is implicit.
            const trigger = forced ? "operator" : outcome.hardForced ? "hard" : undefined;
            await publish([{ type: "session.context.compacted", payload: { summaryPosition: outcome.summaryPosition, ...(trigger ? { trigger } : {}) } }]);
          }
        } catch (compactError) {
          console.error("context compaction failed (turn proceeds un-compacted)", compactError);
        }
      }
      const runInput = await turnInput(db, runtime, agent, trigger, runSettings);
      // Slice index = the length of the model-facing (active) history this turn
      // is seeded from; new items beyond it (the trigger message + this turn's
      // generated items) are the ones to persist. After a compaction this is the
      // short [summary, ...tail] active set, NOT the total row count. The
      // absolute write position is tracked separately (next whole number past
      // the max existing position) because the fractional summary row means
      // total rows no longer equal max(position)+1. Pre-compaction both reduce to
      // the old total-count value, so the common path is unchanged.
      //
      // CRITICAL: seed from the SANITIZED active-row length, not the raw active
      // count. `prepareRunInput` builds `state.history` from
      // `sanitizeHistoryItemsForModel(activeRows)`, so when sanitization drops K
      // rows (a legacy orphan/dangling pair), the in-memory history this turn
      // starts from is K shorter than the raw row count. The reconcile slices the
      // re-sanitized `state.history` off `persistedHistoryCount`; seeding it from
      // the raw count (K too high) skips K genuinely-new items, and a
      // `function_call` left in that skipped region can later have its
      // `function_call_result` persisted alone — the orphan that 400s on replay
      // and bricks the session (issue-61). The sanitized seed is already
      // orphan-free, so it is a stable prefix of the re-sanitized history and the
      // slice begins exactly at the first genuinely-new item.
      const activeSeedRows = await getActiveSessionHistoryItems(db, input.workspaceId, input.sessionId);
      persistedHistoryCount = sanitizeHistoryItemsForModel(
        activeSeedRows.map((row) => row.item),
      ).length;
      historyCountAtTurnStart = persistedHistoryCount;
      nextHistoryPosition = await nextSessionHistoryPosition(db, input.workspaceId, input.sessionId);
      let responseUsageCount = 0;
      // Actual input tokens of the most recent model response this turn; the
      // pre-read trigger for the NEXT turn. Persisted at every turn-end path.
      let lastInputTokensObserved: number | null = null;
      throwIfWorkerShuttingDown();
      stream = await runtime.runStream(agent, runInput, runSettings, {
        sandboxEnvironment,
        onRuntimeEvent: async (event) => {
          await publish!([{ type: event.type, payload: event.payload }], true);
        },
      });
      batcher = createRuntimeBatcher(async (events) => {
        await publish!(events);
      });

      const iterator = stream.toStream()[Symbol.asyncIterator]();
      let streamDone = false;
      try {
        while (true) {
          const next = await nextStreamEvent(iterator, activityContext);
          if (next.done) {
            streamDone = true;
            break;
          }
          const responseUsage = modelResponseUsageFromSdkEvent(next.value);
          if (responseUsage) {
            responseUsageCount += 1;
            const observed = responseUsage.usage?.inputTokens;
            if (typeof observed === "number" && observed > 0) {
              lastInputTokensObserved = observed;
            }
            await recordModelUsageAndDebitCredits(settings, db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId,
              model: turn.model,
              usage: responseUsage.usage,
              sourceKey: modelUsageSourceKey({
                responseId: responseUsage.responseId,
                dispatchId,
                positionalKey: `response-${responseUsageCount}`,
              }),
            });
            await reconcileConversationTruth();
            try {
              await ensureRunAllowed(settings, db, input.accountId, input.workspaceId);
            } catch (limitError) {
              // Capture the run state at the boundary so the budget valve in
              // the outer catch can end this segment gracefully with full
              // conversation context preserved for the post-top-up resume.
              let serializedRunState: string | null = null;
              try {
                serializedRunState = stream.state.toString();
              } catch {
                serializedRunState = null;
              }
              throw new BudgetExhaustedError(
                limitError instanceof Error ? limitError.message : String(limitError),
                serializedRunState,
              );
            }
          }
          const normalized = normalizeSdkEvent(next.value);
          for (const event of normalized) {
            await batcher.push(event);
          }
        }
      } finally {
        if (!streamDone) {
          await iterator.return?.();
        }
      }
      await batcher.flush();
      await stream.completed.catch(() => undefined);
      if (responseUsageCount === 0) {
        const aggregateInput = (stream.state.usage as { inputTokens?: unknown } | undefined)?.inputTokens;
        if (typeof aggregateInput === "number" && aggregateInput > 0) {
          lastInputTokensObserved = aggregateInput;
        }
        await recordModelUsageAndDebitCredits(settings, db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId,
          model: turn.model,
          usage: stream.state.usage,
          sourceKey: modelUsageSourceKey({ responseId: null, dispatchId, positionalKey: "aggregate" }),
        });
      }
      if (lastInputTokensObserved !== null) {
        await setSessionLastInputTokens(db, input.workspaceId, input.sessionId, lastInputTokensObserved)
          .catch((error) => console.error("persist last_input_tokens failed (non-fatal)", error));
      }

      if (stream.interruptions.length > 0) {
        await reconcileConversationTruth();
        const approvals = runtime.serializeApprovals(stream.interruptions);
        await saveRunState(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId,
          serializedRunState: stream.state.toString(),
          pendingApprovals: approvals,
        });
        await publish([
          { type: "session.requiresAction", payload: { approvals } },
          { type: "session.status.changed", payload: { status: "requires_action" } },
        ], true);
        await finishTurn(db, input.workspaceId, turnId, "requires_action");
        await setSessionStatus(db, input.workspaceId, input.sessionId, "requires_action", turnId);
        activityStatus = "requires_action";
        return { status: "requires_action" };
      }

      const finalOutput = String(stream.finalOutput ?? "");
      await reconcileConversationTruth();
      if (settings.sessionHistorySource !== "items") {
        // Legacy conversation memory; in items mode the blob is only written
        // for requires_action pauses (the one RunState-only resume path).
        await saveRunState(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId,
          serializedRunState: stream.state.toString(),
          pendingApprovals: [],
        });
      }
      await publish([
        { type: "agent.message.completed", payload: { text: finalOutput } },
        { type: "turn.completed", payload: { output: finalOutput } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ], true);
      await finishTurn(db, input.workspaceId, turnId, "idle");
      await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
      await recordUsageEvent(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "agent_run.completed",
        quantity: 1,
        unit: "run",
        sourceResourceType: "session_turn",
        sourceResourceId: turnId,
        idempotencyKey: `usage:agent_run.completed:${turnId}`,
      });
      activityStatus = "idle";
      return { status: "idle" };
    } catch (error) {
      // Graceful worker shutdown (deploy / rollout restart): checkpoint and
      // hand the turn back instead of failing the session. Conversation truth
      // is already dual-written per model response; the final reconcile below
      // bounds the loss to at most the single in-flight model step. The turn
      // is re-queued so the session workflow re-dispatches it on a healthy
      // worker — through a synthesized resume notice when this turn already
      // persisted progress (replaying the original trigger would duplicate
      // input the model has already seen and invite it to redo side effects),
      // or through the original trigger when nothing was persisted yet. This
      // is an explicit checkpoint/resume, not a blind activity retry: the
      // resumed attempt sees everything the first attempt did.
      //
      // The branch deliberately does NOT require turn.started to have been
      // published: a shutdown landing during setup (claim/billing, before the
      // turn visibly started) must also requeue, not fail the session. In
      // that early case nothing ran and nothing was checkpointed, so the
      // requeued turn replays the original trigger cleanly. The turn id falls
      // back to the workflow-claimed turn when the local lookup had not
      // finished yet.
      const preemptTurnId = turnId ?? input.turnId;
      if (isWorkerShutdownCancellation(error) && preemptTurnId) {
        try {
          await batcher?.flush().catch(() => undefined);
          await reconcileConversationTruth();
          // An approval-decision rerun always replays its original trigger:
          // the decision is applied through the approval resume path reading
          // the frozen RunState blob (the only representation of a turn
          // paused mid-flight), so swapping the trigger for a resume notice
          // could drop the user's decision. Re-applying an already-consumed
          // approval re-executes at most the single approved step — the same
          // bound every preemption already accepts.
          const approvalRerun = triggerType === "user.approvalDecision";
          let resumeWithNotice = !approvalRerun && settings.sessionHistorySource === "items" && persistedHistoryCount > historyCountAtTurnStart;
          if (settings.sessionHistorySource !== "items" && stream) {
            // Legacy run-state mode: the resume reads the RunState blob, so
            // the checkpoint must be captured there — including any pending
            // approval interruptions, exactly like the requires_action path,
            // so a shutdown while approvals wait does not erase them. A
            // failed capture falls back to the previous snapshot and a clean
            // re-run of the original trigger.
            try {
              await saveRunState(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: preemptTurnId,
                serializedRunState: stream.state.toString(),
                pendingApprovals: runtime.serializeApprovals(stream.interruptions ?? []),
              });
              resumeWithNotice = true;
            } catch {
              resumeWithNotice = false;
            }
          }
          const [preemptedEvent] = await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, [
            {
              turnId: preemptTurnId,
              type: "turn.preempted",
              payload: {
                triggerEventId: input.triggerEventId,
                reason: "worker_shutdown",
                resumeWithNotice,
                ...(resumeWithNotice ? { text: WORKER_SHUTDOWN_RESUME_TEXT } : {}),
              },
            },
            {
              turnId: preemptTurnId,
              type: "session.status.changed",
              payload: { status: "queued" },
            },
          ]);
          await requeuePreemptedTurn(db, input.workspaceId, preemptTurnId, resumeWithNotice && preemptedEvent ? preemptedEvent.id : input.triggerEventId);
          await setSessionStatus(db, input.workspaceId, input.sessionId, "queued", null).catch(() => undefined);
          activityStatus = "preempted";
          return { status: "preempted" };
        } catch (preemptError) {
          // A failing checkpoint/requeue must not surface as an arbitrary
          // activity error around a half-applied preemption (the workflow
          // would fail the session while a requeued turn lingers). Fall
          // through to the cancellation path below: the turn is marked
          // cancelled — also resetting a turn this block already requeued —
          // and the session fails like an uncheckpointed death.
          console.error("worker-shutdown preemption failed; falling back to cancellation", preemptError);
        }
      }
      if (error instanceof CancelledFailure) {
        activityStatus = "cancelled";
        activityError = error;
        await batcher?.flush().catch(() => undefined);
        if (preemptTurnId) {
          await finishTurn(db, input.workspaceId, preemptTurnId, "cancelled").catch(() => undefined);
        }
        throw error;
      }
      // The SDK's per-segment turn cap is a pacing valve, not a failure: end
      // the turn gracefully and idle the session so an active goal continues
      // via a synthesized continuation turn (or a user message resumes work).
      // The run state captured at the cap keeps full conversation context for
      // that resumption.
      const maxTurns = maxTurnsExceededRunState(error);
      if (maxTurns && publish && turnId && turnStartedPublished) {
        await batcher?.flush().catch(() => undefined);
        // The SDK attaches the run state at the throw site; persisting it lets
        // the continuation resume with this segment's full context. If capture
        // ever fails, the continuation falls back to the previous snapshot --
        // degraded context, flagged on the event, but still strictly better
        // than a terminal failed session: the sandbox filesystem state
        // persists independently and the agent re-derives from it.
        await reconcileConversationTruth();
        const runStateSaved = Boolean(maxTurns.serializedRunState) && settings.sessionHistorySource !== "items";
        if (maxTurns.serializedRunState && settings.sessionHistorySource !== "items") {
          await saveRunState(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            serializedRunState: maxTurns.serializedRunState,
            pendingApprovals: [],
          });
        }
        await publish([
          { type: "turn.completed", payload: { output: "", segmentLimit: "max_turns", runStateSaved } },
          { type: "session.status.changed", payload: { status: "idle" } },
        ], true);
        await finishTurn(db, input.workspaceId, turnId, "idle");
        await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
        await recordUsageEvent(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: "agent_run.completed",
          quantity: 1,
          unit: "run",
          sourceResourceType: "session_turn",
          sourceResourceId: turnId,
          idempotencyKey: `usage:agent_run.completed:${turnId}`,
        });
        activityStatus = "idle";
        return { status: "idle" };
      }
      // Budget/limit exhaustion between model calls is account state, not an
      // agent failure: idle the session for goal-bearing and goal-less runs
      // alike (a failed session would reject the user's next message after a
      // top-up). An active goal pauses visibly with reason "limits" at the
      // next continuation evaluation, without consuming continuation budget.
      if (error instanceof BudgetExhaustedError && publish && turnId && turnStartedPublished) {
        await batcher?.flush().catch(() => undefined);
        await reconcileConversationTruth();
        const runStateSaved = Boolean(error.serializedRunState) && settings.sessionHistorySource !== "items";
        if (error.serializedRunState && settings.sessionHistorySource !== "items") {
          await saveRunState(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            serializedRunState: error.serializedRunState,
            pendingApprovals: [],
          });
        }
        await publish([
          { type: "turn.completed", payload: { output: "", segmentLimit: "budget_exhausted", detail: error.message, runStateSaved } },
          { type: "session.status.changed", payload: { status: "idle" } },
        ], true);
        await finishTurn(db, input.workspaceId, turnId, "idle");
        await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
        await recordUsageEvent(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: "agent_run.completed",
          quantity: 1,
          unit: "run",
          sourceResourceType: "session_turn",
          sourceResourceId: turnId,
          idempotencyKey: `usage:agent_run.completed:${turnId}`,
        });
        activityStatus = "idle";
        return { status: "idle" };
      }
      // A retryable provider failure (rate limit) is transient backpressure,
      // not a session failure: the in-client retry budget is already
      // exhausted by the time the error reaches here, so fail the turn
      // truthfully but idle the session. With an active goal the continuation
      // loop resumes after a pacing delay; without one the session simply
      // waits for the next user message. Long-lived sessions (a per-customer
      // ops channel between goals) must never go terminal because the
      // provider had a bad minute -- a failed session would reject the very
      // retry message the failure asks for.
      const failure = agentRunFailurePayload(error);
      if (failure.retryable && publish && turnId && turnStartedPublished) {
        const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(() => null);
        const goalActive = Boolean(goal && goal.status === "active");
        await batcher?.flush().catch(() => undefined);
        // Provider errors rarely carry SDK run state; a null falls back to
        // the previous snapshot, same degraded-context contract as the
        // max-turns path above.
        await reconcileConversationTruth();
        const serializedRunState = agentsErrorRunState(error);
        const runStateSaved = Boolean(serializedRunState) && settings.sessionHistorySource !== "items";
        if (serializedRunState && settings.sessionHistorySource !== "items") {
          await saveRunState(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            serializedRunState,
            pendingApprovals: [],
          });
        }
        await publish([
          { type: "turn.failed", payload: { ...failure, recovery: goalActive ? "goal_continuation" : "user_message", runStateSaved } },
          { type: "session.status.changed", payload: { status: "idle" } },
        ], true);
        await finishTurn(db, input.workspaceId, turnId, "failed");
        await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
        activityStatus = "idle";
        activityError = error;
        return goalActive ? { status: "idle", continueDelayMs: PROVIDER_BACKPRESSURE_DELAY_MS } : { status: "idle" };
      }
      activityStatus = "failed";
      activityError = error;
      if (!publish || !turnId || !turnStartedPublished) {
        throw error;
      }
      await publish([
        { type: "turn.failed", payload: failure },
        { type: "session.status.changed", payload: { status: "failed" } },
      ], true);
      await finishTurn(db, input.workspaceId, turnId, "failed");
      await setSessionStatus(db, input.workspaceId, input.sessionId, "failed", null);
      // The common failure path ends here: runAgentTurn marks the session
      // failed and returns "failed", and the session workflow then exits
      // WITHOUT calling failSession/markSessionIdle. Wake a spawned worker's
      // parent here too, so a manager learns of a worker that died inside its
      // turn (not just one failed by the workflow's failSession path). Deduped
      // per terminal episode by the child's lastSequence, so it never
      // double-fires with the workflow-level wake.
      await notifyParentOfChildTerminal({ db, bus, settings, observability, wakeSessionWorkflow }, input.workspaceId, input.sessionId, "failed", `turn:${turnId}`);
      return { status: "failed" };
    } finally {
      const durationSeconds = (performance.now() - activityStarted) / 1000;
      observability.recordWorkerActivity({
        activity: "runAgentTurn",
        status: activityStatus,
        durationSeconds,
      });
      activitySpan.end({
        attributes: {
          "opengeni.turn_id": turnId ?? "",
          "opengeni.status": activityStatus,
          "opengeni.environment_id": environmentId,
          "opengeni.duration_ms": Math.round(durationSeconds * 1000),
        },
        error: activityError,
      });
      await preparedTools?.close().catch(() => undefined);
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    }
  };
}

export function agentRunFailurePayload(error: unknown): { error: string; code?: string; retryable?: boolean; detail?: string } {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
  if (status === 429 || code === "rate_limit_exceeded" || /(?:too many requests|rate.?limit|\b429\b)/i.test(message)) {
    return {
      error: "Model provider rate limit hit. Try again in a minute or lower the reasoning effort.",
      code: "provider_rate_limited",
      retryable: true,
      ...(message && message !== "Too Many Requests" ? { detail: message } : {}),
    };
  }
  return { error: message };
}

/**
 * Budget/limit exhaustion detected between model calls. This is account
 * state, not an agent failure: the segment ends gracefully (session idles,
 * run state preserved) so a top-up or limit reset lets the same session
 * continue — a failed session would reject the user's next message. An
 * active goal pauses visibly (reason "limits") at the next continuation
 * evaluation without consuming continuation budget.
 */
class BudgetExhaustedError extends Error {
  constructor(message: string, readonly serializedRunState: string | null) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

async function ensureRunAllowed(settings: Settings, db: ActivityServices["db"], accountId: string, workspaceId: string): Promise<void> {
  if (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed") {
    const balance = await getBillingBalance(db, accountId);
    if (balance.balanceMicros <= 0) {
      throw new Error("insufficient OpenGeni credits");
    }
  }
  if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
    const limits = configuredStaticUsageLimits(settings);
      if (limits.maxMonthlyAgentRunsPerWorkspace) {
        const used = await sumUsageQuantity(db, {
          workspaceId,
          eventType: "agent_run.created",
          since: startOfUtcMonth(),
        });
        // Agent turns are admitted and recorded before this worker activity starts.
        // Equality means this accepted turn is exactly at the cap; greater-than is
        // the race/backstop case where another admission already exceeded the cap.
        if (used > limits.maxMonthlyAgentRunsPerWorkspace) {
          throw new Error(`monthly agent run limit reached (${limits.maxMonthlyAgentRunsPerWorkspace})`);
        }
    }
    if (limits.maxMonthlyTokensPerWorkspace) {
      const used = await sumUsageQuantity(db, {
        workspaceId,
        eventType: "model.tokens",
        since: startOfUtcMonth(),
      });
      if (used >= limits.maxMonthlyTokensPerWorkspace) {
        throw new Error(`monthly token limit reached (${limits.maxMonthlyTokensPerWorkspace})`);
      }
    }
  }
}

async function recordModelUsageAndDebitCredits(settings: Settings, db: ActivityServices["db"], input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  model: string;
  usage?: ModelUsageInput | null;
  sourceKey: string;
}): Promise<void> {
  if (!input.usage) {
    return;
  }
  const inputTokens = positiveInt(input.usage.inputTokens);
  const outputTokens = positiveInt(input.usage.outputTokens);
  const totalTokens = positiveInt(input.usage.totalTokens) || inputTokens + outputTokens;
  if (totalTokens > 0) {
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "model.tokens",
      quantity: totalTokens,
      unit: "tokens",
      sourceResourceType: "model_response",
      sourceResourceId: `${input.turnId}:${input.sourceKey}`,
      idempotencyKey: `usage:model.tokens:${input.turnId}:${input.sourceKey}`,
    });
  }
  const shouldDebit = settings.billingMode === "stripe" || settings.usageLimitsMode === "managed";
  if (!shouldDebit || totalTokens === 0) {
    return;
  }
  if (!configuredModelPricing(settings)[input.model]) {
    throw new Error(`Missing model pricing for ${input.model}`);
  }
  const costMicros = calculateModelUsageCostMicros(settings, input.model, input.usage);
  await recordUsageEvent(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    eventType: "model.cost",
    quantity: costMicros,
    unit: "usd_micros",
    sourceResourceType: "model_response",
    sourceResourceId: `${input.turnId}:${input.sourceKey}`,
    idempotencyKey: `usage:model.cost:${input.turnId}:${input.sourceKey}`,
  });
  if (costMicros > 0) {
    await applyCreditDebitUpToBalance(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      type: "model_usage_debit",
      requestedAmountMicros: costMicros,
      sourceType: "model_response",
      sourceId: `${input.turnId}:${input.sourceKey}`,
      idempotencyKey: `credit:model_usage_debit:${input.turnId}:${input.sourceKey}`,
      metadata: {
        model: input.model,
        sessionId: input.sessionId,
        turnId: input.turnId,
        sourceKey: input.sourceKey,
        inputTokens,
        outputTokens,
        totalTokens,
      },
    });
  }
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function sandboxFileDownloadsForRun(
  settings: Settings,
  db: ActivityServices["db"],
  objectStorage: ObjectStorage | null,
  workspaceId: string,
  resources: ResourceRef[],
): Promise<SandboxFileDownload[]> {
  if (settings.sandboxBackend === "none" || !requiresSignedFileResourceDownloads(settings)) {
    return [];
  }
  const fileResources = resources.filter((resource): resource is Extract<ResourceRef, { kind: "file" }> => resource.kind === "file");
  if (fileResources.length === 0) {
    return [];
  }
  if (!objectStorage) {
    throw new Error(`${settings.objectStorageBackend} file resources require configured object storage`);
  }
  const downloadStorage = objectStorageForSandboxDownloads(settings, objectStorage);
  const downloads: SandboxFileDownload[] = [];
  for (const resource of fileResources) {
    const file = await requireFile(db, workspaceId, resource.fileId);
    const url = await downloadStorage.createGetUrl({ key: file.objectKey });
    downloads.push({
      fileId: file.id,
      mountPath: resource.mountPath ?? `files/${file.id}`,
      filename: file.safeFilename,
      url: url.url,
      expiresAt: url.expiresAt,
      sizeBytes: file.sizeBytes,
    });
  }
  return downloads;
}

function requiresSignedFileResourceDownloads(settings: Settings): boolean {
  // A nativeBucketMount backend (modal) cannot mount Azure Blob entries, so it
  // needs pre-signed downloads for that store. Keying on the descriptor (not the
  // "modal" literal) keeps this correct as bucket-mount backends are added.
  const nativeBucketMount = CAPABILITY_DESCRIPTORS[settings.sandboxBackend].nativeBucketMount;
  return (settings.sandboxBackend === "docker" && settings.objectStorageBackend === "s3-compatible")
    || settings.objectStorageBackend === "aws-s3"
    || settings.objectStorageBackend === "gcs"
    || (nativeBucketMount && settings.objectStorageBackend === "azure-blob");
}

function objectStorageForSandboxDownloads(settings: Settings, objectStorage: ObjectStorage): ObjectStorage {
  if (settings.objectStorageBackend !== "s3-compatible" || !settings.objectStorageSandboxEndpoint) {
    return objectStorage;
  }
  return createObjectStorage({
    ...settings,
    objectStorageEndpoint: settings.objectStorageSandboxEndpoint,
  }) ?? objectStorage;
}
