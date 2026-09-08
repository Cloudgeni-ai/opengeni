import { OpenGeniClient, OpenGeniApiError, proxySessionEventStream } from "@opengeni/sdk";
import {
  artifactEditInstructions,
  artifactEditOpeningMessage,
  ARTIFACT_EDIT_PERMISSIONS,
  ARTIFACT_EDIT_TOOLS,
} from "./site-authoring";
import {
  AdvanceConnectRequest,
  BeginConnectRequest,
  ConnectOperationRequest,
} from "@opengeni/contracts/connect";
import {
  RollbackWorkspaceArtifactRequest,
  SetWorkspaceArtifactStatusRequest,
  ClientSessionEvent,
  SessionControlRequest,
  SaveComposerDraftRequest,
  SubmitComposerDraftRequest,
  MoveSessionQueueItemRequest,
  EditSessionQueueItemRequest,
  SteerSessionQueueItemRequest,
  DeleteSessionQueueItemRequest,
  ScheduledTaskScheduleSpec,
} from "@opengeni/contracts";
import { z } from "zod";

export type HostActor = { externalId: string; source: string; workspaceId: string };
export type HostHandlerOptions = {
  service: OpenGeniClient;
  /** Real deployments verify their own cookie/session and tenant membership. */
  authenticate: (request: Request) => Promise<HostActor | null>;
  /** Host's existing CSRF/session policy. Never derived from an upstream URL. */
  authorizeMutation: (request: Request) => Promise<boolean>;
  returnUrl: (actor: HostActor) => string;
  /** Host route for the existing Site, never a browser-supplied destination. */
  siteHref?: (actor: HostActor, siteId: string) => string;
};

/** Explicit operation dispatch, not an arbitrary upstream proxy. Never trusts
 * browser actor/workspace headers and never falls back to service authority. */
export function createHostHandler(options: HostHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    try {
      const actor = await options.authenticate(request);
      if (!actor) return Response.json({ error: "Authentication required" }, { status: 401 });
      const method = request.method;
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
        return new Response(null, { status: 405 });
      if (method !== "GET" && !(await options.authorizeMutation(request)))
        return Response.json({ error: "Request denied" }, { status: 403 });
      const url = new URL(request.url);
      const path = url.pathname.split("/").slice(2).map(decodeURIComponent);
      const client = options.service.asUser(actor.externalId, { source: actor.source });
      const workspaceId = actor.workspaceId;
      const transport = client.connectTransport();
      const call = { signal: request.signal };
      const readBody = async () => {
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > 65_536) throw new Error("Body too large");
        return JSON.parse(new TextDecoder().decode(bytes));
      };
      let result: unknown;
      if (url.pathname === "/api/context" && method === "GET")
        result = { workspaceId, returnUrl: options.returnUrl(actor) };
      else if (
        path[0] === "files" &&
        path[1] === "upload" &&
        path.length === 2 &&
        method === "POST"
      ) {
        const input = z
          .object({
            filename: z.string().min(1).max(255),
            contentType: z.string().min(1).max(255),
            base64: z
              .string()
              .max(43_692)
              .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
          })
          .strict()
          .parse(await readBody());
        const data = Buffer.from(input.base64, "base64");
        if (data.byteLength > 32_768)
          return Response.json({ error: "Example uploads are limited to 32 KiB" }, { status: 413 });
        result = await client.uploadFile(workspaceId, {
          filename: input.filename,
          contentType: input.contentType,
          data,
          timeoutMs: 30_000,
        });
      } else if (path[0] === "schedules") {
        if (path.length === 1 && method === "GET")
          result = await client.listScheduledTasks(workspaceId, { limit: 100 });
        else if (path.length === 1 && method === "POST") {
          const input = z
            .object({
              name: z.string().min(1).max(200),
              prompt: z.string().min(1).max(16_384),
              model: z.string().min(1).max(256),
              schedule: ScheduledTaskScheduleSpec,
            })
            .strict()
            .parse(await readBody());
          result = await client.createScheduledTask(workspaceId, {
            name: input.name,
            schedule: input.schedule,
            agentConfig: { prompt: input.prompt, model: input.model },
            status: "paused",
          });
        } else if (path[1] && path.length === 2 && method === "DELETE") {
          await client.deleteScheduledTask(workspaceId, path[1]);
          result = {};
        } else if (path[1] && path.length === 3 && path[2] === "runs" && method === "GET")
          result = await client.listScheduledTaskRuns(workspaceId, path[1], { limit: 20 });
        else if (path[1] && path.length === 3 && method === "POST") {
          if (path[2] === "pause") result = await client.pauseScheduledTask(workspaceId, path[1]);
          else if (path[2] === "resume")
            result = await client.resumeScheduledTask(workspaceId, path[1]);
          else if (path[2] === "trigger") {
            const input = z
              .object({ triggerId: z.string().uuid() })
              .strict()
              .parse(await readBody());
            result = await client.triggerScheduledTask(workspaceId, path[1], input);
          } else return new Response(null, { status: 404 });
        } else return new Response(null, { status: 404 });
      } else if (path[0] === "connect") {
        if (path.length === 2 && method === "GET" && path[1] === "catalog")
          result = await transport.catalog(workspaceId, call);
        else if (path.length === 2 && method === "GET" && path[1] === "accounts")
          result = await transport.accounts(workspaceId, call);
        else if (path.length === 2 && method === "GET" && path[1] === "attempts")
          result = await transport.pending(workspaceId, call);
        else if (path.length === 2 && method === "POST" && path[1] === "attempts") {
          const input = BeginConnectRequest.parse({
            ...(await readBody()),
            returnUrl: options.returnUrl(actor),
          });
          const { reconnectAccountId, installationTarget, ...required } = input;
          result = await transport.begin(
            workspaceId,
            {
              ...required,
              ...(reconnectAccountId ? { reconnectAccountId } : {}),
              ...(installationTarget
                ? {
                    installationTarget: {
                      instanceKey: installationTarget.instanceKey,
                      displayName: installationTarget.displayName,
                      ...(installationTarget.expectedInstanceVersion !== undefined
                        ? { expectedInstanceVersion: installationTarget.expectedInstanceVersion }
                        : {}),
                    },
                  }
                : {}),
            },
            call,
          );
        } else if (path[1] === "attempts" && path[2] && path.length === 3 && method === "GET")
          result = await transport.get(workspaceId, path[2], call);
        else if (
          path[1] === "attempts" &&
          path[2] &&
          path.length === 4 &&
          path[3] === "advance" &&
          method === "POST"
        )
          result = await transport.advance(
            workspaceId,
            path[2],
            AdvanceConnectRequest.parse(await readBody()),
            call,
          );
        else if (
          path[1] === "attempts" &&
          path[2] &&
          path.length === 4 &&
          path[3] === "cancel" &&
          method === "POST"
        )
          result = await transport.cancel(
            workspaceId,
            path[2],
            ConnectOperationRequest.parse(await readBody()),
            call,
          );
        else if (path[1] === "accounts" && path[2] && path.length === 3 && method === "DELETE") {
          const expectedVersion = z.coerce
            .number()
            .int()
            .positive()
            .safe()
            .parse(url.searchParams.get("expectedVersion"));
          await transport.disconnect(workspaceId, path[2], { ...call, expectedVersion });
          result = {};
        } else return new Response(null, { status: 404 });
      } else if (path[0] === "sessions" && path[1]) {
        const sessionId = path[1];
        if (path.length === 2 && method === "GET")
          result = await client.getSession(workspaceId, sessionId, call);
        else if (path.length === 3 && path[2] === "queue" && method === "GET")
          result = await client.getQueue(workspaceId, sessionId);
        else if (path.length === 3 && path[2] === "composer-draft" && method === "GET")
          result = await client.getComposerDraft(workspaceId, sessionId, call);
        else if (path.length === 3 && path[2] === "composer-draft" && method === "PUT")
          result = await client.saveComposerDraft(
            workspaceId,
            sessionId,
            SaveComposerDraftRequest.parse(await readBody()),
          );
        else if (
          path.length === 4 &&
          path[2] === "composer-draft" &&
          path[3] === "submit" &&
          method === "POST"
        ) {
          const {
            controlEtag,
            modelContext,
            mcpCredentialUpdates,
            personalResourceAttachment,
            ...input
          } = SubmitComposerDraftRequest.parse(await readBody());
          result = await client.submitComposerDraft(workspaceId, sessionId, {
            ...input,
            ...(controlEtag !== undefined ? { controlEtag } : {}),
            ...(modelContext !== undefined ? { modelContext } : {}),
            ...(mcpCredentialUpdates !== undefined ? { mcpCredentialUpdates } : {}),
            ...(personalResourceAttachment !== undefined ? { personalResourceAttachment } : {}),
          });
        } else if (path.length === 5 && path[2] === "queue" && path[3] && method === "POST") {
          const input = await readBody();
          if (path[4] === "move")
            result = await client.moveQueueItem(
              workspaceId,
              sessionId,
              path[3],
              MoveSessionQueueItemRequest.parse(input),
            );
          else if (path[4] === "edit")
            result = await client.editQueueItem(
              workspaceId,
              sessionId,
              path[3],
              EditSessionQueueItemRequest.parse(input),
            );
          else if (path[4] === "steer") {
            const { controlEtag, ...required } = SteerSessionQueueItemRequest.parse(input);
            result = await client.steerQueueItem(workspaceId, sessionId, path[3], {
              ...required,
              ...(controlEtag !== undefined ? { controlEtag } : {}),
            });
          } else if (path[4] === "delete") {
            const { reason, ...required } = DeleteSessionQueueItemRequest.parse(input);
            result = await client.deleteQueueItem(workspaceId, sessionId, path[3], {
              ...required,
              ...(reason !== undefined ? { reason } : {}),
            });
          } else return new Response(null, { status: 404 });
        } else if (path.length === 3 && path[2] === "control" && method === "POST") {
          const input = SessionControlRequest.parse(await readBody());
          result = await client.controlSession(workspaceId, sessionId, {
            action: input.action,
            clientEventId: input.clientEventId,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            ...(input.expectedControlEtag !== undefined
              ? { expectedControlEtag: input.expectedControlEtag }
              : {}),
          });
        } else if (path.length === 3 && path[2] === "human-input-requests" && method === "GET")
          result = {
            requests: await client.listHumanInputRequests(workspaceId, sessionId, {
              status: "pending",
            }),
          };
        else if (
          path.length === 4 &&
          path[2] === "events" &&
          path[3] === "stream" &&
          method === "GET"
        ) {
          await client.getSession(workspaceId, sessionId, call);
          return proxySessionEventStream(client, workspaceId, sessionId, {
            after: request,
            signal: request.signal,
            heartbeatMs: 15_000,
          });
        } else if (path.length === 3 && path[2] === "events" && method === "GET") {
          const after = z.coerce
            .number()
            .int()
            .nonnegative()
            .safe()
            .parse(url.searchParams.get("after") ?? "0");
          result = await client.listEvents(workspaceId, sessionId, { after });
        } else if (path.length === 3 && path[2] === "events" && method === "POST") {
          result = await client.sendEvent(
            workspaceId,
            sessionId,
            ClientSessionEvent.parse(await readBody()),
          );
        } else return new Response(null, { status: 404 });
      } else if (path[0] === "sites") {
        if (path[1] && path.length === 3 && path[2] === "edit-session" && method === "POST") {
          const input = z
            .object({
              expectedCurrentVersionId: z.string().uuid(),
              idempotencyKey: z.string().uuid(),
            })
            .strict()
            .parse(await readBody());
          const { artifact } = await client.getWorkspaceArtifact(workspaceId, path[1], call);
          if (
            artifact.status !== "active" ||
            artifact.currentVersion?.id !== input.expectedCurrentVersionId
          )
            return Response.json(
              { error: "Site changed. Reload before editing." },
              { status: 409 },
            );
          const preference = await client.getNewSessionDraft(workspaceId, call);
          result = await client.createSession(workspaceId, {
            initialMessage: artifactEditOpeningMessage(artifact.title),
            instructions: artifactEditInstructions({
              artifactId: artifact.id,
              title: artifact.title,
              currentVersionId: artifact.currentVersion.id,
              ...(options.siteHref ? { completionHref: options.siteHref(actor, artifact.id) } : {}),
            }),
            firstPartyMcpPermissions: [...ARTIFACT_EDIT_PERMISSIONS],
            firstPartyMcpTools: [...ARTIFACT_EDIT_TOOLS],
            model: preference.model,
            reasoningEffort: preference.reasoningEffort,
            idempotencyKey: input.idempotencyKey,
          });
        } else if (path.length === 1 && method === "GET")
          result = await client.listWorkspaceArtifacts(workspaceId, {
            ...call,
            status: z
              .enum(["active", "archived"])
              .parse(url.searchParams.get("status") ?? "active"),
            ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
          });
        else if (path[1] && path.length === 2 && method === "GET")
          result = await client.getWorkspaceArtifact(workspaceId, path[1], call);
        else if (path[1] && path.length === 3 && path[2] === "html" && method === "GET")
          result = await client.getWorkspaceArtifactHtml(workspaceId, path[1], {
            ...call,
            versionId: z.string().uuid().parse(url.searchParams.get("versionId")),
          });
        else if (path[1] && path.length === 3 && path[2] === "rollback" && method === "POST")
          result = await client.rollbackWorkspaceArtifact(
            workspaceId,
            path[1],
            RollbackWorkspaceArtifactRequest.parse(await readBody()),
            call,
          );
        else if (path[1] && path.length === 3 && path[2] === "status" && method === "PATCH")
          result = await client.setWorkspaceArtifactStatus(
            workspaceId,
            path[1],
            SetWorkspaceArtifactStatusRequest.parse(await readBody()),
            call,
          );
        else return new Response(null, { status: 404 });
      } else return new Response(null, { status: 404 });
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const status =
        error instanceof OpenGeniApiError
          ? error.status
          : error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError
            ? 400
            : 502;
      return Response.json(
        { error: "Request could not be completed. Reload live state before retrying a mutation." },
        { status, headers: { "cache-control": "no-store" } },
      );
    }
  };
}
