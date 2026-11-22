import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { SiteDataError } from "@opengeni/db";
import * as z4 from "zod/v4";
import {
  AppServerError,
  appServerRun,
  appServerRuns,
  appServerStatus,
  testAppServer,
} from "../app-server/service";
import {
  SITE_AGENT_MANAGEMENT_MESSAGE,
  type SiteAgentDataResolution,
} from "../site-publishing/agent-data-tools";

type JsonResult = (value: unknown) => {
  content: Array<{ type: "text"; text: string }>;
};

const AppIdInput = z4.string().uuid().describe("The app (published Site) id.");

/** The most response body `app_server_run` hands the agent; the page gets all of it. */
const RUN_BODY_PREVIEW_CHARS = 16_000;

/**
 * App server code tools (docs/app-server-code.md): read an app's server code
 * runs and errors, and try the code. Code itself ships with the app's files
 * (artifacts_prepare_upload's server bundle), so it versions with the app.
 */
export function registerAppServerTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  authorize: () => Promise<void>,
  json: JsonResult,
  siteAgent?: () => Promise<SiteAgentDataResolution>,
): void {
  const call =
    <A>(fn: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      await authorize();
      try {
        const site = siteAgent ? await siteAgent() : null;
        if (site && site.kind !== "ordinary")
          throw new SiteDataError(
            "forbidden",
            site.kind === "refused" ? site.message : SITE_AGENT_MANAGEMENT_MESSAGE,
          );
        return json(await fn(args));
      } catch (error) {
        if (!(error instanceof SiteDataError) && !(error instanceof AppServerError)) throw error;
        const envelope = {
          error: { code: error.code, message: error.message, details: error.details },
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
          structuredContent: envelope,
          isError: true as const,
        };
      }
    };

  server.registerTool(
    "app_server_runs",
    {
      description:
        "An app's server code status (has code, available here, today's runs and errors, allowed hosts and secrets) and its recent runs with logs and errors, newest first. Needs a manager of the app.",
      inputSchema: {
        siteId: AppIdInput,
        status: z4
          .enum(["running", "ok", "error"])
          .optional()
          .describe("Only runs with this outcome."),
        limit: z4.number().int().min(1).max(100).optional(),
        before: z4
          .string()
          .datetime()
          .optional()
          .describe("Only runs started before this time (to page)."),
      },
    },
    call(
      async (args: {
        siteId: string;
        status?: "running" | "ok" | "error" | undefined;
        limit?: number | undefined;
        before?: string | undefined;
      }) => ({
        status: await appServerStatus(deps, grant, args.siteId),
        ...(await appServerRuns(deps, grant, args.siteId, {
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.status ? { status: args.status } : {}),
          ...(args.before ? { before: args.before } : {}),
        })),
      }),
    ),
  );

  server.registerTool(
    "app_server_run",
    {
      description:
        "Try an app's published server code: sends one request (as site.server.fetch would) and returns the response (body cut to 16,000 characters), logs and error. Runs as the app with the workspace's shared accounts, recorded as a manual run. Needs a manager of the app.",
      inputSchema: {
        siteId: AppIdInput,
        path: z4
          .string()
          .min(1)
          .max(2048)
          .describe("Path and query the code receives, for example /issues?team=ENG."),
        method: z4.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
        headers: z4.record(z4.string(), z4.string()).optional(),
        body: z4.string().optional().describe("A text body, for example JSON."),
      },
    },
    call(
      async (args: {
        siteId: string;
        path: string;
        method?: string | undefined;
        headers?: Record<string, string> | undefined;
        body?: string | undefined;
      }) => {
        const response = await testAppServer(deps, grant, args.siteId, {
          path: args.path,
          method: args.method ?? "GET",
          ...(args.headers ? { headers: args.headers } : {}),
          ...(args.body === undefined ? {} : { body: args.body }),
        });
        const run = await appServerRun(deps, grant, args.siteId, response.runId);
        const cut = response.body.length > RUN_BODY_PREVIEW_CHARS;
        return {
          response: {
            ...response,
            body: cut ? response.body.slice(0, RUN_BODY_PREVIEW_CHARS) : response.body,
            ...(cut ? { bodyTruncated: true, bodyLength: response.body.length } : {}),
          },
          logs: run?.logs ?? "",
          error: run?.error ?? null,
          durationMs: run?.durationMs ?? null,
        };
      },
    ),
  );
}
