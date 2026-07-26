import { CreateSocialConnectionRequest, CreateSocialPostRequest } from "@opengeni/contracts";
import {
  createSocialConnection,
  createSocialPost,
  listSocialConnections,
  listSocialPosts,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireAccessGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { boundedLimit } from "../http/common";

export function registerSocialRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db } = deps;

  app.get("/v1/workspaces/:workspaceId/social/connections", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json(await listSocialConnections(db, workspaceId, boundedLimit(c.req.query("limit"))));
  });

  app.post("/v1/workspaces/:workspaceId/social/connections", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const payload = CreateSocialConnectionRequest.parse(await c.req.json());
    try {
      return c.json(
        await createSocialConnection(db, {
          accountId: grant.accountId,
          workspaceId,
          provider: payload.provider,
          accountHandle: payload.accountHandle,
          accountName: payload.accountName ?? null,
          externalAccountId: payload.externalAccountId ?? null,
          status: payload.status,
          scopes: payload.scopes,
          credentialRef: payload.credentialRef ?? null,
          tokenMetadata: payload.tokenMetadata,
          metadata: payload.metadata,
        }),
        201,
      );
    } catch (error) {
      throw socialHttpException(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/social/posts", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const since = parseSince(c.req.query("since"));
    const connectionIds = parseConnectionIds(
      c.req.query("connectionIds") ?? c.req.query("connectionId"),
    );
    return c.json(
      await listSocialPosts(db, {
        workspaceId,
        ...(connectionIds?.length ? { connectionIds } : {}),
        ...(since ? { since } : {}),
        limit: boundedLimit(c.req.query("limit")),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/social/posts", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const payload = CreateSocialPostRequest.parse(await c.req.json());
    try {
      return c.json(
        await createSocialPost(db, {
          accountId: grant.accountId,
          workspaceId,
          connectionId: payload.connectionId,
          externalPostId: payload.externalPostId ?? null,
          url: payload.url ?? null,
          authorHandle: payload.authorHandle ?? null,
          text: payload.text,
          publishedAt: new Date(payload.publishedAt),
          metrics: payload.metrics,
          raw: payload.raw,
        }),
        201,
      );
    } catch (error) {
      throw socialHttpException(error);
    }
  });
}

function parseSince(raw: string | undefined): Date | undefined {
  if (!raw) {
    return undefined;
  }
  const since = new Date(raw);
  if (Number.isNaN(since.getTime())) {
    throw new HTTPException(422, { message: "since must be an ISO date-time" });
  }
  return since;
}

function parseConnectionIds(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const parsed = z.array(z.string().uuid()).safeParse(values);
  if (!parsed.success) {
    throw new HTTPException(422, {
      message: "connectionIds must be a comma-separated list of UUIDs",
    });
  }
  const ids = parsed.data;
  return [...new Set(ids)];
}

function socialHttpException(error: unknown): HTTPException {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not found")) {
    return new HTTPException(404, { message });
  }
  if (message.includes("duplicate key")) {
    return new HTTPException(409, { message: "social connection or post already exists" });
  }
  return new HTTPException(500, { message });
}
