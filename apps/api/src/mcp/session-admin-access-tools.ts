import { isDeepStrictEqual } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  normalizeOrganizationAccessPolicy,
  organizationAccessPresetPermissions,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import {
  APP_ACTION_CALL_TOOL_NAME,
  appActionChangesState,
  appActionCallCarriesSecrets,
  findAppAction,
  type ActionCatalogEntry,
} from "@opengeni/contracts/app-actions";
import { hasPermission } from "@opengeni/core";
import {
  listConfirmedAppActionChanges,
  resolveSessionAppActionAuthority,
  type Database,
  type SessionAppActionUnavailableReason,
} from "@opengeni/db";
import * as z4 from "zod/v4";

import {
  actionInOneWorkspace,
  callOrganizationAction,
  describeAction,
  describeActionResult,
  searchActions,
  type OrganizationActionContext,
} from "../organization-mcp";

/**
 * How a session reaches the app's actions: the same actions as the
 * organization MCP server, run in this process as a person, with exactly what
 * they can do.
 */
export type SessionAdminAccessDispatch = {
  /** This API's own origin; calls never leave the process. */
  origin: string;
  /**
   * Runs one request through the API. It must run outside the calling
   * agent's request context, so nothing of the agent's own database or
   * billing scope carries into the action.
   */
  dispatch: (request: Request) => Promise<Response>;
  signal?: AbortSignal;
};

function text(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Fixed texts, whatever the session's access: what the model reads never
// changes mid-session. Every refusal says nothing ran.
const UNAVAILABLE: Record<SessionAppActionUnavailableReason, string> = {
  organization_off:
    "Nothing was run: this organization has turned off app actions in chat. The person can do it in the app, or an owner or admin can turn them on again under Security.",
  not_person_session:
    "Nothing was run: app actions run only in a chat a person started themselves, never in a child or service session.",
  no_person_present:
    "Nothing was run: nobody sent this turn's message, so there is no one to act for or to confirm a change. Scheduled, goal and other unattended turns can't run app actions.",
  not_signed_in_person:
    "Nothing was run: this turn's message wasn't sent by a person signed in to a chat (for example it came from an API key or a service), so there is no one to act for.",
  not_member: "Nothing was run: the person who sent this message can no longer use this workspace.",
};
const NOT_CONFIRMED =
  "Nothing was run: this change needs a confirmation from the person who sent this turn's message, given in this chat where they are signed in; an Allow from anyone else, or sent through a key or another integration, doesn't count. Call it again once with the same arguments so they can allow it. If they declined, or someone else answered, tell them so and don't call it again.";
const READ_ONLY =
  "Nothing was run: this chat was opened through an embed or another integration, so app actions here can only read, not change anything. The person can make this change in the app itself.";
// For someone who uses Opengeni through another product, there is no
// Opengeni app page to send them to.
const EXTERNAL_PERSON_READ_ONLY =
  "Nothing was run: this person uses Opengeni through another product, and app actions here can only read, not change anything. Tell them plainly, without pointing them to a page.";
const SECRETS =
  "Nothing was run: this call creates, shows, copies or rotates a key, password, token or other secret, or carries one in its body, and secrets never go through the chat. The person can do it in the app's settings themselves.";
const EXTERNAL_PERSON_SECRETS =
  "Nothing was run: this call creates, shows, copies or rotates a key, password, token or other secret, or carries one in its body, and secrets never go through the chat. Tell the person plainly that this isn't available here, without pointing them to a page.";

const CallInput = z4.object({
  id: z4.string().min(1).max(300).describe("An action id from admin_actions_search."),
  pathParameters: z4
    .record(z4.string(), z4.string().min(1).max(1024))
    .default({})
    .describe("Values for the path's :parameters, for example { workspaceId }."),
  query: z4
    .record(
      z4.string(),
      z4.union([
        z4.string(),
        z4.number(),
        z4.boolean(),
        z4.array(z4.union([z4.string(), z4.number()])),
      ]),
    )
    .default({})
    .describe("Query string parameters."),
  body: z4
    .record(z4.string(), z4.unknown())
    .optional()
    .describe("The JSON request body, for actions that take one."),
});
type CallArgs = z4.infer<typeof CallInput>;

/** Whether a saved, confirmed call is exactly this one, after the same input parsing. */
function confirmedCall(saved: string, args: CallArgs): boolean {
  let value: unknown;
  try {
    value = JSON.parse(saved);
  } catch {
    return false;
  }
  const parsed = CallInput.safeParse(value);
  return parsed.success && isDeepStrictEqual(parsed.data, args);
}

/**
 * The path parameters a call may leave out: an action in one workspace runs
 * in this chat's workspace unless the call names another, so a question about
 * "my workspace" needs no lookup first. Shown in search and describe results
 * only; the tool descriptions stay as they are.
 */
function pathParameterDefaults(workspaceId: string): { workspaceId: string } {
  return { workspaceId };
}

function withPathParameterDefaults(
  entry: ActionCatalogEntry | undefined,
  pathParameters: CallArgs["pathParameters"],
  workspaceId: string,
): CallArgs["pathParameters"] {
  return entry?.path.includes(":workspaceId") && !pathParameters.workspaceId
    ? { ...pathParameters, workspaceId }
    : pathParameters;
}

/** As whom an app action in this turn runs (see `resolveSessionAppActionAuthority`). */
export type SessionAppActionAuthority = Awaited<
  ReturnType<typeof resolveSessionAppActionAuthority>
>;
type ActingAuthority = Exclude<SessionAppActionAuthority, { kind: "unavailable" }>;

/** Someone who uses Opengeni through another product, such as a person in an embedded chat. */
function isExternalPerson(subjectId: string): boolean {
  return subjectId.startsWith("external_user:");
}

/**
 * Whether an action can succeed for someone who uses Opengeni through another
 * product, as far as is known before asking the route: it works inside this
 * chat's one workspace, this turn may run it (a change, a secret), and their
 * access includes the permission the route checks first. The route's own
 * checks still decide everything else.
 */
function externalPersonCanRun(entry: ActionCatalogEntry, authority: ActingAuthority): boolean {
  if (!actionInOneWorkspace(entry)) return false;
  if (authority.kind === "full_access") return true;
  if (authority.kind === "read_only" && appActionChangesState(entry)) return false;
  if (appActionCallCarriesSecrets(entry, undefined)) return false;
  return (
    entry.permission === undefined ||
    hasPermission(authority.permissions, entry.permission as Permission, "explicit")
  );
}

/**
 * The one authority path for what a session does as a person: the app-action
 * tools, and the ordinary session tools when they reach a chat in another
 * workspace. Everything is checked live, on every call.
 */
export type SessionAdminReach = {
  /**
   * As whom an app action in this turn runs right now: with full access, the
   * person who gave it; otherwise the person who sent this turn's message,
   * whose changes need their confirmation; or nobody.
   */
  authority(): Promise<SessionAppActionAuthority>;
  /** How to run an organization action as that person, within what the authority allows. */
  actAs(authority: ActingAuthority): OrganizationActionContext;
  /**
   * Only full access reaches another workspace: how to run an action as the
   * person who gave it, or null when the session doesn't have full access
   * right now (turned off, expired, or that person lost the workspace).
   */
  fullAccessPerson(): Promise<OrganizationActionContext | null>;
};

export function createSessionAdminReach(input: {
  db: Database;
  grant: AccessGrant;
  sessionId: string;
  turnId: string;
  access: SessionAdminAccessDispatch;
  authorize: () => Promise<void>;
}): SessionAdminReach {
  const { db, grant, sessionId, turnId, access, authorize } = input;
  const authority = async (): Promise<SessionAppActionAuthority> => {
    await authorize();
    return await resolveSessionAppActionAuthority(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
      turnId,
    });
  };
  const actAs = (acting: ActingAuthority): OrganizationActionContext => ({
    caller: {
      kind: "person",
      accountId: grant.accountId,
      subjectId: acting.subjectId,
      // Each route still resolves this person's live role and workspace
      // access, exactly as in their browser. Full access reaches every
      // workspace they can use, as before. Otherwise the cap is what the
      // message itself could do when it was sent (frozen with the turn,
      // so an embed's narrower token stays narrow) in this chat's
      // workspace, so steps that widen an agent's access stay refused.
      // Someone who uses Opengeni through another product has exactly one
      // workspace, so full access for them means everything they can do in
      // this chat's workspace: every path then asks the same question.
      access:
        acting.kind === "full_access" && !isExternalPerson(acting.subjectId)
          ? {
              preset: "full",
              permissions: organizationAccessPresetPermissions("full"),
              workspaceScope: { kind: "all" },
            }
          : normalizeOrganizationAccessPolicy({
              preset: "custom",
              permissions:
                acting.kind === "full_access"
                  ? organizationAccessPresetPermissions("full")
                  : acting.permissions,
              workspaceScope: { kind: "selected", workspaceIds: [grant.workspaceId] },
            }),
    },
    origin: access.origin,
    dispatch: access.dispatch,
    ...(access.signal ? { signal: access.signal } : {}),
  });
  return {
    authority,
    actAs,
    async fullAccessPerson() {
      const current = await authority();
      return current.kind === "full_access" ? actAs(current) : null;
    },
  };
}

/**
 * Register the app-action tools. The server lists them in a chat a person
 * started (or one with full access); each call resolves, live, as whom it runs:
 * with full access, the person who gave it, as before; otherwise the person
 * who sent this turn's message, whose changes run only after they confirm
 * each one in the chat. The worker shows that confirmation; this checks it.
 */
export function registerSessionAdminAccessTools(input: {
  server: McpServer;
  db: Database;
  grant: AccessGrant;
  sessionId: string;
  attempt: { turnId: string; attemptId: string };
  reach: SessionAdminReach;
}): void {
  const { server, db, grant, sessionId, attempt, reach } = input;
  const currentAuthority = reach.authority;

  server.registerTool(
    "admin_actions_search",
    {
      title: "Find app actions",
      description:
        "Find what the person could do themselves in the app's pages and settings, so you can do it for them here instead of sending them there: switch or set models, invite people and share chats, check their plan, credits and usage, change workspace and organization settings, and manage sessions, connections, schedules, files, knowledge and keys. With full access this reaches every workspace the person who gave it can use, including reading, messaging or managing chats and sessions in another workspace; the ordinary session tools also reach such a chat when given its workspaceId. Returns action ids for admin_action_describe and admin_action_call. An empty query lists everything, page by page.",
      inputSchema: {
        query: z4
          .string()
          .max(200)
          .default("")
          .describe("Words to look for, for example 'invite', 'usage' or 'default model'."),
        limit: z4.number().int().min(1).max(50).default(20).describe("Results per page."),
        offset: z4.number().int().min(0).default(0).describe("Results to skip, for paging."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit, offset }) => {
      const authority = await currentAuthority();
      if (authority.kind === "unavailable") return failure(UNAVAILABLE[authority.reason]);
      // Offer only what can succeed: someone who uses Opengeni through another
      // product reaches this chat's workspace, within this turn's access.
      return text({
        pathParameterDefaults: pathParameterDefaults(grant.workspaceId),
        ...searchActions({
          query,
          limit,
          offset,
          ...(isExternalPerson(authority.subjectId)
            ? { reachable: (entry: ActionCatalogEntry) => externalPersonCanRun(entry, authority) }
            : {}),
        }),
      });
    },
  );

  server.registerTool(
    "admin_action_describe",
    {
      title: "Describe an app action",
      description:
        "Show an app action's method, path, path parameters, the JSON schema of its input and whether it changes anything, so admin_action_call can run it correctly.",
      inputSchema: {
        id: z4.string().min(1).max(300).describe("An action id from admin_actions_search."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const authority = await currentAuthority();
      if (authority.kind === "unavailable") return failure(UNAVAILABLE[authority.reason]);
      const entry = findAppAction(id);
      if (!entry || entry.browserOnly || entry.retired) return describeActionResult(id);
      return text({
        ...describeAction(entry),
        ...(entry.path.includes(":workspaceId")
          ? { pathParameterDefaults: pathParameterDefaults(grant.workspaceId) }
          : {}),
        changes: appActionChangesState(entry),
      });
    },
  );

  server.registerTool(
    APP_ACTION_CALL_TOOL_NAME,
    {
      title: "Run an app action",
      description:
        "Run one app action as the person, with exactly what they can do in the app and nothing more. A read (changes: false) runs right away. A change first shows the person a confirmation in this chat and runs only if they allow it, unless they gave this session full access; only the person who sent the message can allow it, and if they decline, don't ask again. Actions that create, show or rotate keys, passwords or other secrets are left to the app unless the session has full access. Pass path parameters (for example workspaceId), query parameters and a JSON body. Returns the HTTP status and response; 403 means the person can't do it. Tell them plainly what changed.",
      inputSchema: CallInput.shape,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      const authority = await currentAuthority();
      if (authority.kind === "unavailable") return failure(UNAVAILABLE[authority.reason]);
      const entry = findAppAction(args.id);
      if (
        authority.kind !== "full_access" &&
        entry &&
        appActionCallCarriesSecrets(entry, args.body)
      )
        return failure(isExternalPerson(authority.subjectId) ? EXTERNAL_PERSON_SECRETS : SECRETS);
      if (authority.kind === "read_only" && entry && appActionChangesState(entry))
        return failure(
          isExternalPerson(authority.subjectId) ? EXTERNAL_PERSON_READ_ONLY : READ_ONLY,
        );
      if (authority.kind === "confirm" && entry && appActionChangesState(entry)) {
        // Enforced here, not only in the chat: the change runs only if this
        // attempt is executing exactly these arguments, which this same
        // person approved.
        const confirmed = await listConfirmedAppActionChanges(db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId,
          turnId: attempt.turnId,
          attemptId: attempt.attemptId,
          subjectId: authority.subjectId,
          toolName: APP_ACTION_CALL_TOOL_NAME,
        });
        if (!confirmed.some((saved) => confirmedCall(saved, args))) return failure(NOT_CONFIRMED);
      }
      return await callOrganizationAction(reach.actAs(authority), {
        id: args.id,
        // After the confirmation check, which compares the call as the model made it.
        pathParameters: withPathParameterDefaults(entry, args.pathParameters, grant.workspaceId),
        query: args.query,
        ...(args.body !== undefined ? { body: args.body } : {}),
      });
    },
  );
}
