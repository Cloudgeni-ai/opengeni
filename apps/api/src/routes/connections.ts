import {
  ConnectionResponse,
  CreateConnectionRequest,
  IntegrationClientMetadata,
  ListConnectionsResponse,
  OAuthStartRequest,
  OAuthStartResponse,
  UpdateConnectionRequest,
} from "@opengeni/contracts";
import { Buffer } from "node:buffer";
import { requireAccessGrant, requireEnvironmentEncryption } from "@opengeni/core";
import {
  createConnection,
  encryptEnvironmentValue,
  getConnectionMetadata,
  listConnectionsMetadata,
  revokeConnection,
  updateConnection,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import type { ApiRouteDeps } from "@opengeni/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const oauthStateTtlMs = 10 * 60 * 1000;

export function registerConnectionRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings } = deps;

  app.get("/v1/workspaces/:workspaceId/connections", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:read");
    return c.json(ListConnectionsResponse.parse({
      connections: await listConnectionsMetadata(db, workspaceId, grant.subjectId),
    }));
  });

  app.post("/v1/workspaces/:workspaceId/connections", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const payload = CreateConnectionRequest.parse(await c.req.json());
    const key = requireEnvironmentEncryption(settings);
    const subjectId = writableSubjectId(payload.subjectId, grant.subjectId);
    const connection = await createConnection(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId,
      providerDomain: payload.providerDomain,
      kind: payload.kind,
      credentialEncrypted: encryptCredentialBundle(key, payload.credential),
      grantedScopes: payload.grantedScopes,
      expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
      metadata: payload.metadata,
      createdBySubjectId: grant.subjectId,
    });
    return c.json(ConnectionResponse.parse({ connection }), 201);
  });

  app.get("/v1/workspaces/:workspaceId/connections/:connectionId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:read");
    const connection = await getConnectionMetadata(db, workspaceId, c.req.param("connectionId"), grant.subjectId);
    if (!connection) {
      throw new HTTPException(404, { message: "connection not found" });
    }
    return c.json(ConnectionResponse.parse({ connection }));
  });

  app.patch("/v1/workspaces/:workspaceId/connections/:connectionId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const payload = UpdateConnectionRequest.parse(await c.req.json());
    // Status is not a free-form field: revocation goes through DELETE, and the
    // broker owns needs_reauth/error. Reactivating a connection is only
    // meaningful together with a fresh credential bundle — otherwise a PATCH
    // could clear the broker's re-auth signal while stale tokens stay in place.
    if (payload.status !== undefined) {
      if (payload.status !== "active") {
        throw new HTTPException(400, { message: "status can only be set to \"active\"; use DELETE to revoke" });
      }
      if (payload.credential === undefined) {
        throw new HTTPException(400, { message: "reactivating a connection requires a new credential" });
      }
    }
    const key = payload.credential === undefined ? null : requireEnvironmentEncryption(settings);
    const subjectId = payload.subjectId === undefined ? undefined : writableSubjectId(payload.subjectId, grant.subjectId);
    const connection = await updateConnection(db, {
      workspaceId,
      connectionId: c.req.param("connectionId"),
      visibleToSubjectId: grant.subjectId,
      updatedBySubjectId: grant.subjectId,
      ...(payload.providerDomain !== undefined ? { providerDomain: payload.providerDomain } : {}),
      ...(subjectId !== undefined ? { subjectId } : {}),
      ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
      ...(payload.status !== undefined ? { status: payload.status } : {}),
      ...(payload.credential !== undefined && key ? { credentialEncrypted: encryptCredentialBundle(key, payload.credential) } : {}),
      ...(payload.grantedScopes !== undefined ? { grantedScopes: payload.grantedScopes } : {}),
      ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null } : {}),
      ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    });
    if (!connection) {
      throw new HTTPException(404, { message: "connection not found" });
    }
    return c.json(ConnectionResponse.parse({ connection }));
  });

  app.delete("/v1/workspaces/:workspaceId/connections/:connectionId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const connection = await revokeConnection(db, workspaceId, c.req.param("connectionId"), grant.subjectId);
    if (!connection) {
      throw new HTTPException(404, { message: "connection not found" });
    }
    return c.json(ConnectionResponse.parse({ connection }));
  });

  app.post("/v1/workspaces/:workspaceId/connections/oauth/start", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const payload = OAuthStartRequest.parse(await c.req.json());
    const key = requireEnvironmentEncryption(settings);
    const state = createSignedState(requireIntegrationsStateSecret(settings), {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      providerDomain: payload.providerDomain,
      requestedScopes: payload.requestedScopes,
      encryptedPkceVerifier: encryptEnvironmentValue(key, randomBase64Url(32)),
      ...(payload.resource !== undefined ? { resource: payload.resource } : {}),
      ...(payload.returnPath !== undefined ? { returnPath: payload.returnPath } : {}),
      ...(payload.connectionId !== undefined ? { connectionId: payload.connectionId } : {}),
    });
    return c.json(OAuthStartResponse.parse({
      state,
      authorizationUrl: null,
      expiresAt: new Date(Date.now() + oauthStateTtlMs).toISOString(),
    }), 501);
  });

  app.get("/v1/integrations/oauth/callback", async (c) => {
    const state = c.req.query("state");
    if (!state) {
      throw new HTTPException(400, { message: "missing OAuth state" });
    }
    const payload = readSignedState(state, requireIntegrationsStateSecret(settings));
    if (!payload) {
      throw new HTTPException(400, { message: "invalid or expired OAuth state" });
    }
    if (!c.req.query("code")) {
      throw new HTTPException(400, { message: "missing OAuth code" });
    }
    return c.json({ error: "OAuth callback is not implemented until integrations I2" }, 501);
  });

  app.get("/v1/integrations/oauth/client-metadata.json", (c) => {
    const baseUrl = integrationBaseUrl(settings.publicBaseUrl, c.req.url);
    const metadataUrl = `${baseUrl}/v1/integrations/oauth/client-metadata.json`;
    return c.json(IntegrationClientMetadata.parse({
      client_id: metadataUrl,
      client_name: "OpenGeni",
      redirect_uris: [`${baseUrl}/v1/integrations/oauth/callback`],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }));
  });
}

function writableSubjectId(requested: string | null | undefined, grantSubjectId: string): string | null {
  if (requested == null) {
    return null;
  }
  if (requested !== grantSubjectId) {
    throw new HTTPException(403, { message: "cannot write a connection for another subject" });
  }
  return requested;
}

function encryptCredentialBundle(key: Uint8Array, credential: Record<string, unknown>): string {
  return encryptEnvironmentValue(key, JSON.stringify(credential));
}

function requireIntegrationsStateSecret(settings: ApiRouteDeps["settings"]): string {
  const secret = settings.integrationsStateSecret?.trim();
  if (!secret) {
    throw new HTTPException(503, { message: "integrations OAuth requires OPENGENI_INTEGRATIONS_STATE_SECRET" });
  }
  return secret;
}

function integrationBaseUrl(publicBaseUrl: string | undefined, requestUrl: string): string {
  return (publicBaseUrl ?? new URL(requestUrl).origin).replace(/\/+$/, "");
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}
