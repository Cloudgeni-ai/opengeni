import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { organizationAccessPresetPermissions, type AccessGrant } from "@opengeni/contracts";
import { resolveSessionAdminAuthority, type Database } from "@opengeni/db";
import * as z4 from "zod/v4";

import { callOrganizationAction, describeActionResult, searchActions } from "../organization-mcp";

/**
 * How a session with admin access reaches the organization's actions: the
 * same actions as the organization MCP server, run in this process as the
 * owner or admin who gave the session its access.
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
 * Register the admin tools. The server admits them only while the session
 * has admin access; every call checks it again, live, so turning it off,
 * the organization stopping it, or the person losing their role takes effect
 * on the very next call.
 */
export function registerSessionAdminAccessTools(input: {
  server: McpServer;
  db: Database;
  grant: AccessGrant;
  sessionId: string;
  access: SessionAdminAccessDispatch;
  authorize: () => Promise<void>;
}): void {
  const { server, db, grant, sessionId, access, authorize } = input;
  const currentAuthority = async () => {
    await authorize();
    return await resolveSessionAdminAuthority(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
    });
  };
  const ended = () =>
    failure(
      "This session no longer has admin access. An owner or admin can give it again from the session's menu in Opengeni.",
    );

  server.registerTool(
    "admin_actions_search",
    {
      title: "Find organization actions",
      description:
        "This session has admin access: it can do what the person who gave it can manage across the whole organization. Search every Opengeni action (sessions and chats in every workspace, workspaces, people, connections and capabilities, knowledge, files, schedules, models, keys, billing and settings). Returns action ids for admin_action_describe and admin_action_call. An empty query lists everything, page by page.",
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
      if (!(await currentAuthority())) return ended();
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
      if (!(await currentAuthority())) return ended();
      return describeActionResult(id);
    },
  );

  server.registerTool(
    "admin_action_call",
    {
      title: "Run an organization action",
      description:
        "Run one Opengeni action as the owner or admin who gave this session admin access, with exactly what they can manage right now, in any workspace of the organization. Pass path parameters (for example workspaceId), query parameters and a JSON body. Returns the HTTP status and response. Changes are real: confirm the target first.",
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
      const authority = await currentAuthority();
      if (!authority) return ended();
      return await callOrganizationAction(
        {
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
        },
        { id, pathParameters, query, ...(body !== undefined ? { body } : {}) },
      );
    },
  );
}
