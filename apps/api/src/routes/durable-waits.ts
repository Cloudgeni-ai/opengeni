import {
  DurableIngressEvent,
  DurableWaitState,
  FileDownloadUrlResponse,
  ResolveAskUserRequest,
} from "@opengeni/contracts";
import {
  DurableIngressEventConflictError,
  getBackgroundJobArtifact,
  getBackgroundJob,
  getDurableWait,
  getSessionForSubject,
  ingestDurableEvent,
  listBackgroundJobArtifacts,
  listBackgroundJobLogs,
  listBackgroundJobs,
  listDurableWaits,
  requestBackgroundJobCancel,
  resolveAskUserWait,
} from "@opengeni/db";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import { publishDurableSessionEvents } from "@opengeni/events";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { boundedLimit } from "../http/common";

const Uuid = z.string().uuid();

async function requireVisibleSession(
  deps: ApiRouteDeps,
  workspaceId: string,
  sessionId: string,
  subjectId: string,
): Promise<void> {
  if (
    !Uuid.safeParse(sessionId).success ||
    !(await getSessionForSubject(deps.db, workspaceId, sessionId, subjectId))
  ) {
    throw new HTTPException(404, { message: "session not found" });
  }
}

async function requireVisibleBackgroundJob(
  deps: ApiRouteDeps,
  workspaceId: string,
  jobId: string,
  subjectId: string,
) {
  if (!Uuid.safeParse(jobId).success) {
    throw new HTTPException(404, { message: "background job not found" });
  }
  const job = await getBackgroundJob(deps.db, workspaceId, jobId);
  if (!job || !(await getSessionForSubject(deps.db, workspaceId, job.originSessionId, subjectId))) {
    throw new HTTPException(404, { message: "background job not found" });
  }
  return job;
}

async function publishAndSignalDelivery(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    workflowId: string;
    workflowWakeRevision: number | null;
    eventId: string;
    events: Parameters<typeof publishDurableSessionEvents>[3];
  },
): Promise<void> {
  await publishDurableSessionEvents(deps.bus, input.workspaceId, input.sessionId, input.events);
  if (input.workflowWakeRevision === null) return;
  await deps.workflowClient.signalApprovalDecision({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    eventId: input.eventId,
    workflowId: input.workflowId,
    workflowWakeRevision: input.workflowWakeRevision,
  });
}

/**
 * Existing-session durable waits and one-shot background jobs. Recurring task
 * definitions intentionally remain owned by registerScheduledTaskRoutes.
 */
export function registerDurableWaitRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/durable-waits", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const sessionId = c.req.param("sessionId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    await requireVisibleSession(deps, workspaceId, sessionId, grant.subjectId);
    const parsedState = c.req.query("state")
      ? DurableWaitState.safeParse(c.req.query("state"))
      : null;
    if (parsedState && !parsedState.success) {
      throw new HTTPException(400, { message: "invalid durable wait state" });
    }
    return c.json(
      await listDurableWaits(deps.db, workspaceId, sessionId, {
        ...(parsedState?.success ? { state: parsedState.data } : {}),
        limit: boundedLimit(c.req.query("limit")),
      }),
    );
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/durable-waits/:waitId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const sessionId = c.req.param("sessionId");
    const waitId = c.req.param("waitId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    await requireVisibleSession(deps, workspaceId, sessionId, grant.subjectId);
    const wait = Uuid.safeParse(waitId).success
      ? await getDurableWait(deps.db, workspaceId, sessionId, waitId)
      : null;
    if (!wait) throw new HTTPException(404, { message: "durable wait not found" });
    return c.json(wait);
  });

  app.post(
    "/v1/workspaces/:workspaceId/sessions/:sessionId/durable-waits/:waitId/resolve",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const sessionId = c.req.param("sessionId");
      const waitId = c.req.param("waitId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
      await requireVisibleSession(deps, workspaceId, sessionId, grant.subjectId);
      if (!Uuid.safeParse(waitId).success) {
        throw new HTTPException(404, { message: "durable wait not found" });
      }
      const parsed = ResolveAskUserRequest.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new HTTPException(400, { message: "invalid ask_user resolution" });
      }
      const result = await resolveAskUserWait(
        deps.db,
        parsed.data.outcome === "answered"
          ? {
              accountId: grant.accountId,
              workspaceId,
              sessionId,
              waitId,
              outcome: "answered",
              answers: parsed.data.answers,
              clientEventId: parsed.data.clientEventId,
            }
          : {
              accountId: grant.accountId,
              workspaceId,
              sessionId,
              waitId,
              outcome: "cancelled",
              clientEventId: parsed.data.clientEventId,
              ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
            },
      );
      if (result.action === "conflict") {
        return c.json(
          { message: "ask_user wait could not be resolved", reason: result.reason },
          409,
        );
      }
      await publishAndSignalDelivery(deps, {
        accountId: grant.accountId,
        workspaceId,
        sessionId,
        workflowId: result.temporalWorkflowId,
        workflowWakeRevision: result.workflowWakeRevision,
        eventId: result.event.id,
        events: result.events,
      });
      return c.json(
        { action: result.action, wait: result.wait, event: result.event },
        result.action === "accepted" ? 202 : 200,
      );
    },
  );

  app.post("/v1/workspaces/:workspaceId/durable-events", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "events:ingest");
    const parsed = DurableIngressEvent.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid durable event" });
    }
    try {
      const result = await ingestDurableEvent(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        authenticatedSourceIdentity: grant.subjectId,
        event: parsed.data,
      });
      const delivery = result.delivery;
      if (delivery && "events" in delivery) {
        await publishAndSignalDelivery(deps, {
          accountId: grant.accountId,
          workspaceId,
          sessionId: delivery.update.sessionId,
          workflowId: delivery.temporalWorkflowId ?? `session-${delivery.update.sessionId}`,
          workflowWakeRevision: delivery.workflowWakeRevision,
          eventId: delivery.wakeEventId,
          events: delivery.events,
        });
      }
      return c.json(
        {
          action: result.action,
          ingressEventId: result.ingressEventId,
          matchedWaitId: result.matchedWaitId,
        },
        result.action === "replay" ? 200 : 202,
      );
    } catch (error) {
      if (error instanceof DurableIngressEventConflictError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/background-jobs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const sessionId = c.req.param("sessionId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    await requireVisibleSession(deps, workspaceId, sessionId, grant.subjectId);
    return c.json(
      await listBackgroundJobs(deps.db, workspaceId, {
        sessionId,
        limit: boundedLimit(c.req.query("limit")),
      }),
    );
  });

  app.get("/v1/workspaces/:workspaceId/background-jobs/:jobId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    return c.json(
      await requireVisibleBackgroundJob(deps, workspaceId, c.req.param("jobId"), grant.subjectId),
    );
  });

  app.get("/v1/workspaces/:workspaceId/background-jobs/:jobId/logs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    await requireVisibleBackgroundJob(deps, workspaceId, jobId, grant.subjectId);
    const after = Math.max(0, Math.floor(Number(c.req.query("after") ?? 0) || 0));
    return c.json(
      await listBackgroundJobLogs(
        deps.db,
        workspaceId,
        jobId,
        after,
        boundedLimit(c.req.query("limit")),
      ),
    );
  });

  app.get("/v1/workspaces/:workspaceId/background-jobs/:jobId/artifacts", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    await requireVisibleBackgroundJob(deps, workspaceId, jobId, grant.subjectId);
    return c.json(await listBackgroundJobArtifacts(deps.db, workspaceId, jobId));
  });

  app.post(
    "/v1/workspaces/:workspaceId/background-jobs/:jobId/artifacts/:artifactId/download-url",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const jobId = c.req.param("jobId");
      const artifactId = c.req.param("artifactId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
      await requireVisibleBackgroundJob(deps, workspaceId, jobId, grant.subjectId);
      if (!deps.objectStorage) {
        throw new HTTPException(503, { message: "object storage is not configured" });
      }
      const artifact = Uuid.safeParse(artifactId).success
        ? await getBackgroundJobArtifact(deps.db, workspaceId, jobId, artifactId)
        : null;
      if (!artifact) {
        throw new HTTPException(404, { message: "background job artifact not found" });
      }
      const signed = await deps.objectStorage.createGetUrl({ key: artifact.storageKey });
      return c.json(
        FileDownloadUrlResponse.parse({
          url: signed.url,
          expiresAt: signed.expiresAt.toISOString(),
        }),
      );
    },
  );

  app.post("/v1/workspaces/:workspaceId/background-jobs/:jobId/cancel", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    await requireVisibleBackgroundJob(deps, workspaceId, jobId, grant.subjectId);
    return c.json(await requestBackgroundJobCancel(deps.db, workspaceId, jobId), 202);
  });
}
