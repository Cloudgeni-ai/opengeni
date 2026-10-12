import {
  ModelAccountPreferences,
  SessionModelAccountChoiceResponse,
  SetSessionModelAccountChoiceRequest,
  SetSessionModelAccountChoiceResponse,
  UpdateModelAccountPreferencesRequest,
} from "@opengeni/contracts";
import { requireAccessContext, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  chooseSubscriptionCoreSessionAccount,
  deliverSubscriptionCoreProviderWakes,
  readSubscriptionCoreSessionAccountChoice,
  readSubscriptionPersonPreferences,
  writeSubscriptionPersonPreferences,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { ApiHttpError } from "../http/api-error";
import { isAgentActingAsPerson, requireFullAccessIfAgent } from "../http/acting-person";
import { requireSameOriginBrowserMutation } from "./codex";

const Uuid = z.string().uuid();

function parseId(value: string | undefined, what: string): string {
  const parsed = Uuid.safeParse(value);
  if (!parsed.success) throw new HTTPException(404, { message: `${what} not found` });
  return parsed.data;
}

async function jsonBody(c: Context): Promise<unknown> {
  return await c.req.json().catch(() => null);
}

/** The calling person in this organization (a human, or an agent acting as one). */
async function requireOrganizationPerson(
  c: Context,
  deps: ApiRouteDeps,
  mutation: boolean,
): Promise<{ organizationId: string; subjectId: string }> {
  const organizationId = parseId(c.req.param("organizationId"), "organization");
  if (mutation) {
    requireSameOriginBrowserMutation(c, deps);
    if (isAgentActingAsPerson(c)) requireFullAccessIfAgent(c, "Changing model account preferences");
  }
  const context = await requireAccessContext(c, deps);
  const grant = context.accountGrants.find((each) => each.accountId === organizationId);
  if (!grant || !context.subjectId.startsWith("user:")) {
    throw new HTTPException(404, { message: "organization not found" });
  }
  return { organizationId, subjectId: context.subjectId };
}

/**
 * Explicit model-account choice for a session and a person's own
 * preferences, for every provider on the shared subscription core
 * (SUB-SEL-02, SUB-SEL-04, SUB-ELIG-05, SUB-OWN-05, D-24, D-27, D-28).
 *
 * The session routes sit behind the session authorization middleware
 * (`session.read` to read, the account-choice operation to write), so a
 * private session is reachable only by its owner. The database enforces
 * which account a session may use; these routes translate its outcome.
 */
export function registerModelAccountChoiceRoutes(app: Hono, deps: ApiRouteDeps): void {
  const sessionPath = "/v1/workspaces/:workspaceId/sessions/:sessionId/model-account";

  app.get(sessionPath, async (c) => {
    c.header("cache-control", "private, no-store");
    const workspaceId = parseId(c.req.param("workspaceId"), "workspace");
    const sessionId = parseId(c.req.param("sessionId"), "session");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const choice = await readSubscriptionCoreSessionAccountChoice(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId,
      subjectId: grant.subjectId,
    });
    if (!choice) throw new HTTPException(404, { message: "session not found" });
    return c.json(
      SessionModelAccountChoiceResponse.parse({
        binding: choice.binding,
        accounts: choice.connections,
        personal: choice.personal,
      }),
    );
  });

  app.put(sessionPath, async (c) => {
    const workspaceId = parseId(c.req.param("workspaceId"), "workspace");
    const sessionId = parseId(c.req.param("sessionId"), "session");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const parsed = SetSessionModelAccountChoiceRequest.safeParse(await jsonBody(c));
    if (!parsed.success) {
      throw new HTTPException(422, { message: "connectionId must be an account id or null" });
    }
    const result = await chooseSubscriptionCoreSessionAccount(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId,
      connectionId: parsed.data.connectionId,
      subjectId: grant.subjectId,
    });
    switch (result.outcome) {
      case "not_found":
        throw new HTTPException(404, { message: "session or account not found" });
      case "refused":
        throw new ApiHttpError(409, {
          code: "conflict",
          message: "this account cannot be used for this session",
          retryable: false,
          outcomeUnknown: false,
          details: { reason: "account_not_eligible" },
        });
      case "conflict":
        // Defensive: the binding is locked before its version is compared.
        throw new ApiHttpError(409, {
          code: "conflict",
          message: "the session's account changed at the same time; try again",
          retryable: true,
          outcomeUnknown: false,
          details: { reason: "binding_busy" },
        });
      case "changed":
        // Waiters recheck on their own bounded timer; a lost wake only delays.
        await deliverSubscriptionCoreProviderWakes(deps.db, result.wakes);
        await publishDurableSessionEvents(deps.bus, workspaceId, sessionId, result.events);
        break;
      case "unchanged":
        break;
    }
    return c.json(
      SetSessionModelAccountChoiceResponse.parse({
        changed: result.outcome === "changed",
        appliedTo: result.appliedTo,
        provider: result.provider,
        connectionId: result.connectionId,
        choice: parsed.data.connectionId === null ? "automatic" : "explicit",
      }),
    );
  });

  const preferencesPath = "/v1/organizations/:organizationId/me/model-account-preferences";

  app.get(preferencesPath, async (c) => {
    c.header("cache-control", "private, no-store");
    const person = await requireOrganizationPerson(c, deps, false);
    const preferences = await readSubscriptionPersonPreferences(deps.db, {
      accountId: person.organizationId,
      subjectId: person.subjectId,
    });
    if (!preferences) throw new HTTPException(404, { message: "organization not found" });
    return c.json(ModelAccountPreferences.parse(preferences));
  });

  app.patch(preferencesPath, async (c) => {
    const person = await requireOrganizationPerson(c, deps, true);
    const parsed = UpdateModelAccountPreferencesRequest.safeParse(await jsonBody(c));
    if (!parsed.success) {
      throw new HTTPException(422, { message: "invalid model account preferences" });
    }
    const result = await writeSubscriptionPersonPreferences(deps.db, {
      accountId: person.organizationId,
      subjectId: person.subjectId,
      personalFallbackOptIn: parsed.data.personalFallbackOptIn,
      ...(parsed.data.expectedVersion === undefined
        ? {}
        : { expectedVersion: parsed.data.expectedVersion }),
    });
    if (result.outcome === "not_member") {
      throw new HTTPException(404, { message: "organization not found" });
    }
    if (result.outcome === "conflict") {
      throw new ApiHttpError(409, {
        code: "conflict",
        message: "your preferences changed in the meantime; reload and try again",
        retryable: false,
        outcomeUnknown: false,
        details: { reason: "version_conflict", currentVersion: result.preferences.version },
      });
    }
    // Waiters recheck on their own bounded timer; a lost wake only delays.
    await deliverSubscriptionCoreProviderWakes(deps.db, result.wakes);
    return c.json(ModelAccountPreferences.parse(result.preferences));
  });
}
