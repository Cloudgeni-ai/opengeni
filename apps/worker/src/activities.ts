import {
  collectGitIdentityEnvironment,
  collectSandboxEnvironment,
  getSettings,
  type Settings,
} from "@infra-agents/config";
import type { ResourceRef, ReasoningEffort } from "@infra-agents/contracts";
import type { SessionEventType } from "@infra-agents/contracts";
import {
  createDb,
  createTurn,
  finishTurn,
  getLatestRunState,
  getSessionEvent,
  requireSession,
  saveRunState,
  setSessionStatus,
  type AppendEventInput,
  type Database,
} from "@infra-agents/db";
import { appendAndPublishEvents, createNatsEventBus, type EventBus } from "@infra-agents/events";
import {
  createGitHubAppInstallationToken,
  githubAppBotIdentity,
} from "@infra-agents/github";
import {
  createProductionAgentRuntime,
  normalizeSdkEvent,
  type InfraAgentRuntime,
} from "@infra-agents/runtime";
import { CancelledFailure, Context } from "@temporalio/activity";

type Services = {
  settings: Settings;
  db: Database;
  bus: EventBus;
  runtime: InfraAgentRuntime;
};

export type ActivityDependencies = Partial<Services>;

type RunAgentSegmentInput = {
  sessionId: string;
  triggerEventId: string;
  workflowId: string;
};

export type RunAgentSegmentResult = {
  status: "idle" | "requires_action" | "failed" | "cancelled";
};

export function createActivities(dependencies: ActivityDependencies = {}) {
  let servicesPromise: Promise<Services> | null = null;

  async function services(): Promise<Services> {
    servicesPromise ??= (async () => {
      const settings = dependencies.settings ?? getSettings();
      const dbClient = dependencies.db ? null : createDb(settings.databaseUrl);
      return {
        settings,
        db: dependencies.db ?? dbClient!.db,
        bus: dependencies.bus ?? await createNatsEventBus(settings.natsUrl),
        runtime: dependencies.runtime ?? createProductionAgentRuntime(),
      };
    })();
    return servicesPromise;
  }

  async function runAgentSegment(input: RunAgentSegmentInput): Promise<RunAgentSegmentResult> {
    const { settings, db, bus, runtime } = await services();
    runtime.configure(settings);
    const session = await requireSession(db, input.sessionId);
    const trigger = await getSessionEvent(db, input.triggerEventId);
    if (!trigger) {
      throw new Error(`Trigger event not found: ${input.triggerEventId}`);
    }
    const turnId = await createTurn(db, {
      sessionId: input.sessionId,
      triggerEventId: input.triggerEventId,
      temporalWorkflowId: input.workflowId,
    });
    const activityContext = currentActivityContext();
    const heartbeatTimer = startActivityHeartbeat(activityContext, {
      phase: "running",
      sessionId: input.sessionId,
      turnId,
    });
    let producerSeq = 0;
    const producerId = `${input.workflowId}:${turnId}`;
    const publish = async (events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>, immediate = false) => {
      const inputs = events.map((event) => ({
        ...event,
        turnId,
        producerId,
        producerSeq: ++producerSeq,
      }));
      await appendAndPublishEvents(db, bus, input.sessionId, inputs);
      activityContext?.heartbeat({ phase: "events_published", sessionId: input.sessionId, turnId, producerSeq });
      if (immediate) {
        await Bun.sleep(0);
      }
    };
    activityContext?.heartbeat({ phase: "turn_started", sessionId: input.sessionId, turnId });

    let batcher: ReturnType<typeof createRuntimeBatcher> | null = null;
    await publish([
      { type: "session.status.changed", payload: { status: "running" } },
      { type: "turn.started", payload: { triggerEventId: input.triggerEventId } },
    ], true);

    try {
      const runSettings = {
        ...settings,
        openaiModel: session.model,
        sandboxBackend: session.sandboxBackend,
      };
      const sandboxEnvironment = await sandboxEnvironmentForRun(runSettings, session.resources);
      const reasoningEffort = reasoningEffortForSession(session.metadata, runSettings.openaiReasoningEffort);
      const agent = runtime.buildAgent(runSettings, session.resources, {
        reasoningEffort,
        sandboxEnvironment,
      });
      const runInput = await segmentInput(db, runtime, agent, trigger);
      const stream = await runtime.runStream(agent, runInput, runSettings, {
        sandboxEnvironment,
        onRuntimeEvent: async (event) => {
          await publish([{ type: event.type, payload: event.payload }], true);
        },
      });
      batcher = createRuntimeBatcher(async (events) => {
        await publish(events);
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

      if (stream.interruptions.length > 0) {
        const approvals = runtime.serializeApprovals(stream.interruptions);
        await saveRunState(db, {
          sessionId: input.sessionId,
          turnId,
          serializedRunState: stream.state.toString(),
          pendingApprovals: approvals,
        });
        await publish([
          { type: "session.requiresAction", payload: { approvals } },
          { type: "session.status.changed", payload: { status: "requires_action" } },
        ], true);
        await finishTurn(db, turnId, "requires_action");
        await setSessionStatus(db, input.sessionId, "requires_action", turnId);
        return { status: "requires_action" };
      }

      const finalOutput = String(stream.finalOutput ?? "");
      await saveRunState(db, {
        sessionId: input.sessionId,
        turnId,
        serializedRunState: stream.state.toString(),
        pendingApprovals: [],
      });
      await publish([
        { type: "agent.message.completed", payload: { text: finalOutput } },
        { type: "turn.completed", payload: { output: finalOutput } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ], true);
      await finishTurn(db, turnId, "idle");
      await setSessionStatus(db, input.sessionId, "idle", null);
      return { status: "idle" };
    } catch (error) {
      if (error instanceof CancelledFailure) {
        await batcher?.flush().catch(() => undefined);
        await finishTurn(db, turnId, "cancelled").catch(() => undefined);
        await setSessionStatus(db, input.sessionId, "cancelled", null).catch(() => undefined);
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      await publish([
        { type: "turn.failed", payload: { error: message } },
        { type: "session.status.changed", payload: { status: "failed" } },
      ], true);
      await finishTurn(db, turnId, "failed");
      await setSessionStatus(db, input.sessionId, "failed", null);
      return { status: "failed" };
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    }
  }

  async function failSession(input: RunAgentSegmentInput & { error?: string }): Promise<void> {
    const { db, bus } = await services();
    const session = await requireSession(db, input.sessionId);
    const trigger = await getSessionEvent(db, input.triggerEventId);
    const turnId = session.activeTurnId ?? null;
    await appendAndPublishEvents(db, bus, input.sessionId, [
      {
        type: "turn.failed",
        turnId,
        payload: {
          triggerEventId: input.triggerEventId,
          trigger: trigger?.payload ?? null,
          error: input.error ?? "Agent activity failed before it could report a terminal state.",
        },
      },
      {
        type: "session.status.changed",
        turnId,
        payload: { status: "failed" },
      },
    ]);
    if (turnId) {
      await finishTurn(db, turnId, "failed");
    }
    await setSessionStatus(db, input.sessionId, "failed", null);
  }

  async function cancelSession(input: RunAgentSegmentInput): Promise<void> {
    const { db, bus } = await services();
    const session = await requireSession(db, input.sessionId);
    const trigger = await getSessionEvent(db, input.triggerEventId);
    await appendAndPublishEvents(db, bus, input.sessionId, [
      {
        type: "turn.cancelled",
        payload: { triggerEventId: input.triggerEventId, reason: trigger?.payload ?? null },
      },
      {
        type: "session.status.changed",
        payload: { status: "cancelled" },
      },
    ]);
    if (session.activeTurnId) {
      await finishTurn(db, session.activeTurnId, "cancelled");
    }
    await setSessionStatus(db, input.sessionId, "cancelled", null);
  }

  return {
    runAgentSegment,
    failSession,
    cancelSession,
  };
}

const defaultActivities = createActivities();

export const runAgentSegment = defaultActivities.runAgentSegment;
export const failSession = defaultActivities.failSession;
export const cancelSession = defaultActivities.cancelSession;

async function segmentInput(db: Database, runtime: InfraAgentRuntime, agent: any, trigger: Awaited<ReturnType<typeof getSessionEvent>>) {
  if (!trigger) {
    throw new Error("Missing trigger event");
  }
  if (trigger.type === "user.message") {
    const payload = trigger.payload as { text?: unknown };
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      throw new Error("user.message payload is missing text");
    }
    const latestState = await getLatestRunState(db, trigger.sessionId);
    return await runtime.prepareInput(agent, {
      kind: "message",
      text: payload.text,
      serializedRunState: latestState?.serializedRunState ?? null,
    });
  }
  if (trigger.type === "user.approvalDecision") {
    const payload = trigger.payload as {
      approvalId?: unknown;
      decision?: unknown;
      message?: unknown;
    };
    const state = await getLatestRunState(db, trigger.sessionId);
    if (!state) {
      throw new Error("No saved run state is available for approval decision");
    }
    return await runtime.prepareInput(agent, {
      kind: "approval",
      serializedRunState: state.serializedRunState,
      approvalId: String(payload.approvalId ?? ""),
      decision: payload.decision === "approve" ? "approve" : "reject",
      ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    });
  }
  throw new Error(`Unsupported trigger event type: ${trigger.type}`);
}

async function sandboxEnvironmentForRun(settings: Settings, resources: ResourceRef[]): Promise<Record<string, string>> {
  const environment = {
    ...collectSandboxEnvironment(settings),
    ...collectGitIdentityEnvironment(settings),
  };
  const selection = githubRepositorySelection(resources);
  if (!selection) {
    return environment;
  }
  const token = await createGitHubAppInstallationToken(settings, {
    installationId: selection.installationId,
    repositoryIds: selection.repositoryIds,
  });
  const identity = githubAppBotIdentity(settings);
  const authHeader = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  environment.GH_TOKEN = token;
  environment.GITHUB_TOKEN = token;
  environment.GIT_ASKPASS = "/usr/local/bin/infra-agent-git-askpass";
  environment.GIT_CONFIG_COUNT = "1";
  environment.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
  environment.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${authHeader}`;
  environment.GIT_TERMINAL_PROMPT = "0";
  if (identity) {
    environment.GIT_AUTHOR_NAME = environment.GIT_AUTHOR_NAME || identity.name;
    environment.GIT_AUTHOR_EMAIL = environment.GIT_AUTHOR_EMAIL || identity.email;
    environment.GIT_COMMITTER_NAME = environment.GIT_COMMITTER_NAME || identity.name;
    environment.GIT_COMMITTER_EMAIL = environment.GIT_COMMITTER_EMAIL || identity.email;
  }
  return environment;
}

function githubRepositorySelection(resources: ResourceRef[]): { installationId: number; repositoryIds: number[] } | null {
  const selected = resources.flatMap((resource) => {
    if (resource.kind !== "repository") {
      return [];
    }
    const installationId = positiveInteger(resource.metadata.github_installation_id);
    const repositoryId = positiveInteger(resource.metadata.github_repository_id);
    return installationId && repositoryId ? [{ installationId, repositoryId }] : [];
  });
  if (selected.length === 0) {
    return null;
  }
  const installationId = selected[0]!.installationId;
  if (selected.some((item) => item.installationId !== installationId)) {
    throw new Error("GitHub App repository resources must belong to one installation");
  }
  return {
    installationId,
    repositoryIds: selected.map((item) => item.repositoryId),
  };
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Number(value);
  }
  return null;
}

function reasoningEffortForSession(metadata: Record<string, unknown>, fallback: ReasoningEffort): ReasoningEffort {
  const value = metadata.reasoningEffort;
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : fallback;
}

function createRuntimeBatcher(flushEvents: (events: AppendEventInput[]) => Promise<void>) {
  let pending: AppendEventInput[] = [];
  let lastFlush = Date.now();
  const structural = new Set<SessionEventType>([
    "agent.message.delta",
    "agent.reasoning.delta",
    "sandbox.command.output.delta",
    "agent.toolCall.created",
    "agent.toolCall.output",
    "agent.message.completed",
    "session.requiresAction",
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
  ]);
  return {
    push: async (event: { type: SessionEventType; payload: unknown }) => {
      pending.push({ type: event.type, payload: event.payload });
      const elapsed = Date.now() - lastFlush;
      if (pending.length >= 50 || elapsed >= 33 || structural.has(event.type)) {
        await flush();
      }
    },
    flush,
  };

  async function flush() {
    if (pending.length === 0) {
      return;
    }
    const events = pending;
    pending = [];
    lastFlush = Date.now();
    await flushEvents(events);
  }
}

function currentActivityContext(): Context | null {
  try {
    return Context.current();
  } catch {
    return null;
  }
}

function startActivityHeartbeat(context: Context | null, details: Record<string, unknown>): ReturnType<typeof setInterval> | null {
  if (!context) {
    return null;
  }
  const timer = setInterval(() => {
    context.heartbeat({ ...details, at: new Date().toISOString() });
  }, 10_000);
  if ("unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

async function nextStreamEvent<T>(iterator: AsyncIterator<T>, context: Context | null): Promise<IteratorResult<T>> {
  if (!context) {
    return await iterator.next();
  }
  return await Promise.race([
    iterator.next(),
    context.cancelled,
  ]);
}
