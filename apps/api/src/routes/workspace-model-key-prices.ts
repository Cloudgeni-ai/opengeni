import {
  connectedModelPriceBasisModelIds,
  workspaceModelKeyListPriceKnown,
  type Settings,
} from "@opengeni/config";
import {
  ConnectionResponse,
  ModelPriceBasisModelsResponse,
  SetWorkspaceModelKeyListPriceRequest,
} from "@opengeni/contracts";
import { requireAccessGrantAuthorization, type ApiRouteDeps } from "@opengeni/core";
import {
  setWorkspaceModelKeyListPrice,
  type ConnectionMetadataWithVerification,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { parseRequestJson } from "../http/request-body";
import { requireWorkspaceIntegrationAdministration } from "./connections";
import { acceptedListPrice } from "./organization-model-providers";

// What a workspace's own OpenAI, Azure OpenAI or OpenAI-compatible model key
// costs. Their providers report no cost, so usage estimates, Insights and
// spend limits price the key's calls from this: the catalogue model whose
// list rate it shares (an Azure deployment's base model, read from Azure's
// answer when the key is connected) or the administrator's own rate. The same
// fields and the same resolver as an organization's models; the price is not
// part of the key's version, so setting it never changes the model's id.

/** A workspace connection as listed, with whether its model's usage is priced. */
export function withModelKeyListPriceKnown(
  settings: Settings,
  connection: ConnectionMetadataWithVerification,
): ConnectionMetadataWithVerification {
  const known = workspaceModelKeyListPriceKnown(settings, connection);
  return known === undefined ? connection : { ...connection, listPriceKnown: known };
}

export function registerWorkspaceModelKeyPriceRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings } = deps;

  app.get("/v1/workspaces/:workspaceId/model-price-basis-models", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:read");
    c.header("cache-control", "private, no-store");
    return c.json(
      ModelPriceBasisModelsResponse.parse({
        priceBasisModelIds: connectedModelPriceBasisModelIds(settings),
      }),
    );
  });

  app.put("/v1/workspaces/:workspaceId/connections/:connectionId/list-price", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const connectionId = z.string().uuid().safeParse(c.req.param("connectionId"));
    if (!connectionId.success) throw new HTTPException(404, { message: "connection not found" });
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    // A workspace model key decides what the workspace's usage costs: a
    // settings action, like connecting it.
    requireWorkspaceIntegrationAdministration(access.grant);
    const payload = await parseRequestJson(c, SetWorkspaceModelKeyListPriceRequest);
    const connection = await setWorkspaceModelKeyListPrice(db, {
      accountId: access.grant.accountId,
      workspaceId,
      connectionId: connectionId.data,
      actorSubjectId: access.grant.subjectId,
      price: acceptedListPrice(settings, payload.listPrice),
    });
    if (!connection) throw new HTTPException(404, { message: "model key not found" });
    return c.json(
      ConnectionResponse.parse({ connection: withModelKeyListPriceKnown(settings, connection) }),
    );
  });
}
