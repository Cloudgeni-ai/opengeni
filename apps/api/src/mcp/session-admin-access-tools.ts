import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { organizationAccessPresetPermissions, type AccessGrant } from "@opengeni/contracts";

import { resolveSessionAdminAuthority, type Database } from "@opengeni/db";
import * as z4 from "zod/v4";

import {
  callOrganizationAction,
  describeActionResult,
  searchActions,
  type OrganizationActionContext,
} from "../organization-mcp";

/**
 * How a session with admin access reaches the organization's actions: the
 * same actions as the organization MCP server, run in this process as the
 * person who gave the session their access, with exactly what they can do.
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

/**
 * The one authority path of a session with full access. Both the admin
 * action tools and the ordinary session tools, when they reach a chat in
 * another workspace, act through it.
 */
export type SessionAdminReach = {
  /**
   * How to run an organization action as the person who gave this session
   * full access, checked live: null once the session no longer has it (the
   * person or organization turned it off, it expired, or the person lost
   * access to the workspace). Call it again for every action.
   */
  actingPerson(): Promise<OrganizationActionContext | null>;
};

export function createSessionAdminReach(input: {
  db: Database;
  grant: AccessGrant;
  sessionId: string;
  access: SessionAdminAccessDispatch;
  authorize: () => Promise<void>;
}): SessionAdminReach {
  const { db, grant, sessionId, access, authorize } = input;
  return {
    async actingPerson() {
      await authorize();
      const authority = await resolveSessionAdminAuthority(db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
      });
      if (!authority) return null;
      return {
        caller: {
          kind: "person",
          accountId: grant.accountId,
          subjectId: authority.subjectId,
          // The cap is everything: each route still resolves this person's
          // live role and workspace access, exactly as in their browser.
          access: {
            preset: "full",
            permissions: organizationAccessPresetPermissions("full"),
            workspaceScope: { kind: "all" },
          },
        },
        origin: access.origin,
        dispatch: access.dispatch,
        ...(access.signal ? { signal: access.signal } : {}),
      };
    },
  };
}

/**
 * Register the admin tools. The server admits them only while the session
 * has admin access; every call checks it again, live, so turning it off,
 * the organization stopping it, or the person losing their role takes effect
 * on the very next call.
 */
export function registerSessionAdminAccessTools(input: {
  server: McpServer;
  reach: SessionAdminReach;
}): void {
  const { server, reach } = input;
  const ended = () =>
    failure(
      "This session no longer has full access. The person who started it can give it again from the session's menu in the app.",
    );

  server.registerTool(
    "admin_actions_search",
    {
      title: "Find organization actions",
      description:
        "Read, message or manage chats and sessions in another workspace as the person who gave this session full access. Also every other action they can take, in every workspace they can use: workspaces and their settings, people, connections and capabilities, knowledge, files, schedules, models, keys, billing and organization settings. It can do what that person can do in the app, and nothing more; actions beyond their own access are refused when called. The ordinary session tools also reach a chat in another workspace when given its workspaceId. Returns action ids for admin_action_describe and admin_action_call. An empty query lists everything, page by page.",
      inputSchema: {
        query: z4
          .string()
          .max(200)
          .default("")
          .describe("Words to look for, for example 'list sessions' or 'connections'."),
        limit: z4.number().int().min(1).max(50).default(20).describe("Results per page."),
        offset: z4.number().int().min(0).default(0).describe("Results to skip, for paging."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit, offset }) => {
      if (!(await reach.actingPerson())) return ended();
      return text(searchActions({ query, limit, offset }));
    },
  );

  server.registerTool(
    "admin_action_describe",
    {
      title: "Describe an organization action",
      description:
        "Show an organization action's method, path, path parameters and the JSON schema of its input, so admin_action_call can run it correctly.",
      inputSchema: {
        id: z4.string().min(1).max(300).describe("An action id from admin_actions_search."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      if (!(await reach.actingPerson())) return ended();
      return describeActionResult(id);
    },
  );

  server.registerTool(
    "admin_action_call",
    {
      title: "Run an organization action",
      description:
        "Run one action as the person who gave this session full access, with exactly what they can do right now, in any workspace they can use. Pass path parameters (for example workspaceId), query parameters and a JSON body. Returns the HTTP status and response; 403 means that person can't do it. Changes are real: confirm the target first.",
      inputSchema: {
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
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ id, pathParameters, query, body }) => {
      const actingPerson = await reach.actingPerson();
      if (!actingPerson) return ended();
      return await callOrganizationAction(actingPerson, {
        id,
        pathParameters,
        query,
        ...(body !== undefined ? { body } : {}),
      });
    },
  );
}
