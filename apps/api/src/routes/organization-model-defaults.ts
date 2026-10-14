import { canonicalizeConfiguredModelId } from "@opengeni/config";
import {
  OrganizationModelDefaults,
  UpdateOrganizationModelDefaultsRequest,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  getOrganizationModelDefaultsForAdministrator,
  nestedPostgresSqlState,
  updateOrganizationModelDefaults,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { requireOrganizationCodexHuman, requireSameOriginBrowserMutation } from "./codex";

const OrganizationId = z.string().uuid();

function parseOrganizationId(value: string | undefined): string {
  const parsed = OrganizationId.safeParse(value);
  if (!parsed.success) throw new HTTPException(404, { message: "organization not found" });
  return parsed.data;
}

function refused(error: unknown): never {
  if (nestedPostgresSqlState(error) === "42501") {
    throw new HTTPException(403, {
      message: "Only organization owners and admins can change model defaults",
    });
  }
  if (error instanceof RangeError) throw new HTTPException(422, { message: error.message });
  throw error;
}

/**
 * Organization model defaults: what every workspace follows until it saves
 * its own default model, allowed models or compaction trigger. Owners and
 * admins read and change them; workspaces read them through their own model
 * routes, which report where each value comes from.
 */
export function registerOrganizationModelDefaultsRoutes(app: Hono, deps: ApiRouteDeps): void {
  const path = "/v1/organizations/:organizationId/model-defaults";
  app.get(path, async (c) => {
    c.header("cache-control", "private, no-store");
    const organizationId = parseOrganizationId(c.req.param("organizationId"));
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    try {
      return c.json(
        OrganizationModelDefaults.parse(
          await getOrganizationModelDefaultsForAdministrator(deps.db, {
            organizationId,
            actorSubjectId: human.subjectId,
          }),
        ),
      );
    } catch (error) {
      refused(error);
    }
  });

  app.patch(path, async (c) => {
    requireSameOriginBrowserMutation(c, deps);
    const organizationId = parseOrganizationId(c.req.param("organizationId"));
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    const parsed = UpdateOrganizationModelDefaultsRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new HTTPException(422, { message: "invalid organization model defaults" });
    }
    const { settings } = await deps.resolveCatalogSettings();
    const canonical = (id: string) => canonicalizeConfiguredModelId(settings, id);
    const patch = parsed.data;
    try {
      return c.json(
        OrganizationModelDefaults.parse(
          await updateOrganizationModelDefaults(deps.db, {
            organizationId,
            actorSubjectId: human.subjectId,
            patch: {
              ...(patch.sessionDefaults === undefined
                ? {}
                : {
                    sessionDefaults: patch.sessionDefaults
                      ? { ...patch.sessionDefaults, model: canonical(patch.sessionDefaults.model) }
                      : null,
                  }),
              ...(patch.modelPolicy === undefined
                ? {}
                : {
                    modelPolicy: {
                      allowedProviders: patch.modelPolicy?.allowedProviders ?? null,
                      allowedModels: patch.modelPolicy?.allowedModels
                        ? [...new Set(patch.modelPolicy.allowedModels.map(canonical))]
                        : null,
                    },
                  }),
              ...(patch.modelCompactionThresholds === undefined
                ? {}
                : { modelCompactionThresholds: patch.modelCompactionThresholds }),
            },
          }),
        ),
      );
    } catch (error) {
      refused(error);
    }
  });
}
