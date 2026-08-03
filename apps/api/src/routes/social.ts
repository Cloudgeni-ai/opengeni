import {
  CreateSocialConnectionRequest,
  CreateSocialPostRequest,
  OAuthStartResponse,
  SocialOAuthStartRequest,
} from "@opengeni/contracts";
import {
  createSocialConnection,
  createSocialPost,
  listSocialConnections,
  listSocialPosts,
  updateSocialConnectionCredential,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireAccessGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { boundedLimit } from "../http/common";
import { completeSocialOAuthCallback, startSocialOAuth } from "../integrations/social-oauth";

export function registerSocialRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings, observability } = deps;

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

  // Disconnect: drop the stored OAuth credential and disable the connection.
  // The row stays (posts reference it and the audit trail needs the identity);
  // reconnecting via the OAuth flow revives it.
  app.delete("/v1/workspaces/:workspaceId/social/connections/:connectionId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const connection = await updateSocialConnectionCredential(db, {
      workspaceId,
      connectionId: c.req.param("connectionId"),
      credentialEncrypted: null,
      status: "disabled",
      tokenMetadata: {},
    });
    if (!connection) {
      throw new HTTPException(404, { message: "social connection not found" });
    }
    return c.json(connection);
  });

  // First-party social OAuth (X / Reddit). Distinct from the MCP integrations
  // flow: providers are pinned, tokens land in social_connections, and the
  // callback is unauthenticated (browser redirect) but bound by signed state.
  app.post("/v1/workspaces/:workspaceId/social/oauth/start", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const parsed = SocialOAuthStartRequest.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: parsed.error.issues[0]?.message ?? "invalid social OAuth start request",
      });
    }
    const payload = parsed.data;
    const result = await startSocialOAuth(
      { db, settings, observability },
      {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        requestUrl: c.req.url,
        payload,
      },
    );
    return c.json(OAuthStartResponse.parse(result));
  });

  app.get("/v1/social/oauth/callback", async (c) => {
    const result = await completeSocialOAuthCallback(
      { db, settings, observability },
      {
        code: c.req.query("code"),
        state: c.req.query("state"),
        error: c.req.query("error"),
        requestUrl: c.req.url,
      },
    );
    return c.redirect(result.redirectTo, 302);
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
