import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AppSyncMode,
  ScheduledTaskEventsInput,
  ScheduledTaskScheduleSpec,
  ScheduledTaskStatus,
  type AccessGrant,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { SiteDataError } from "@opengeni/db";
import * as z4 from "zod/v4";
import {
  createAppSync,
  deleteAppSync,
  listAppSyncs,
  runAppSyncNow,
  setAppSyncOptIn,
  updateAppSync,
} from "../app-sync/service";
import {
  SITE_AGENT_MANAGEMENT_MESSAGE,
  type SiteAgentDataResolution,
} from "../site-publishing/agent-data-tools";

type JsonResult = (value: unknown) => {
  content: Array<{ type: "text"; text: string }>;
};

const AppIdInput = z4.string().uuid().describe("The App (published Site) id.");
const SyncIdInput = z4.string().uuid().describe("The sync's id, from app_sync_list.");
const Path = z4.string().min(1).max(256);

const SAVE_FIELDS = {
  name: z4.string().min(1).max(200).optional().describe("A short name people recognize."),
  collection: z4
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
    .optional()
    .describe(
      "The App data collection to fill. Define it first with app_data_define_collection: shared or shared_read for a shared sync, per_viewer (ideally privateRecords) for a personal one.",
    ),
  mode: AppSyncMode.optional().describe(
    "shared (default): runs on your connection and fills data everyone in the App shares. personal: each person opts in with app_sync_opt_in and it fills only their own records, from their own account.",
  ),
  tool: z4
    .object({
      serverId: z4
        .string()
        .min(1)
        .max(256)
        .describe("The tool's server id, as in your tool catalog."),
      toolName: z4.string().min(1).max(256).describe("The tool's name on that server."),
    })
    .optional()
    .describe(
      "The connected tool to call on every run. Read-only tools that list records fit best.",
    ),
  arguments: z4
    .record(z4.string(), z4.unknown())
    .optional()
    .describe("Fixed arguments passed to the tool on every run."),
  recordsPath: Path.nullable()
    .optional()
    .describe(
      "Dot path to the list of records in the tool's JSON result (for example data.items). Omit to use the result itself when it is a list, or its only list.",
    ),
  key: Path.optional().describe(
    "Dot path to each record's unique key (for example id). A record with a known key is updated, not added again.",
  ),
  fields: z4
    .array(Path)
    .max(100)
    .nullable()
    .optional()
    .describe(
      "Dot paths of the fields to keep, stored under the same path. Omit to keep whole records.",
    ),
  schedule: ScheduledTaskScheduleSpec.optional().describe(
    'When it runs, like any automation: {"type":"interval","everySeconds":3600} (at least 300), {"type":"calendar","hour":7,"minute":0,"timeZone":"Europe/Oslo"}, or {"type":"manual"} for event triggers or app_sync_run only.',
  ),
  events: ScheduledTaskEventsInput.optional().describe(
    "Event triggers that also start a run, as on any automation (workspace event sources only).",
  ),
  status: ScheduledTaskStatus.optional().describe("active (default) or paused."),
};

/**
 * App data sync tools (docs/app-sync.md). Prefer a sync over a model-run
 * automation when an App only needs data refreshed from a connected tool:
 * nothing reasons, so it is cheaper, faster and repeatable.
 */
export function registerAppSyncTools(
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
        if (!(error instanceof SiteDataError)) throw error;
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
    "app_sync_save",
    {
      description:
        "Create or change an App data sync: on a schedule or event, call one connected tool with fixed arguments, keep chosen fields of each returned record and upsert them by key into a collection of the App's data. No model runs, so prefer it over an agent automation for plain data refresh. Without syncId it creates a sync (name, collection, tool, key and schedule are required); with syncId only the given fields change. Whoever saves a sync owns it: a shared sync runs on their connection. Tools that ask for approval first can't run unattended; a run of one fails with a readable error. Try it with app_sync_run.",
      inputSchema: {
        siteId: AppIdInput,
        syncId: SyncIdInput.optional().describe("Change this sync instead of creating one."),
        ...SAVE_FIELDS,
      },
    },
    call(
      async (args: { siteId: string; syncId?: string | undefined } & Record<string, unknown>) => {
        const { siteId, syncId, ...fields } = args;
        const body = Object.fromEntries(
          Object.entries(fields).filter(([, value]) => value !== undefined),
        );
        return syncId
          ? await updateAppSync(deps, grant, siteId, syncId, body)
          : await createAppSync(deps, grant, siteId, body);
      },
    ),
  );

  server.registerTool(
    "app_sync_list",
    {
      description:
        "List an App's data syncs: tool, collection, schedule, owner, opted-in people and each one's last run (time, status, error, counts). Needs a manager of the App.",
      inputSchema: { siteId: AppIdInput },
    },
    call(async ({ siteId }: { siteId: string }) => ({
      syncs: await listAppSyncs(deps, grant, siteId),
    })),
  );

  server.registerTool(
    "app_sync_delete",
    {
      description: "Delete an App data sync. Records it already wrote stay.",
      inputSchema: { siteId: AppIdInput, syncId: SyncIdInput },
    },
    call(async ({ siteId, syncId }: { siteId: string; syncId: string }) =>
      deleteAppSync(deps, grant, siteId, syncId),
    ),
  );

  server.registerTool(
    "app_sync_run",
    {
      description:
        "Run an App data sync now (even while paused) and return its result: records read and written, or the error. Use it to check a new sync.",
      inputSchema: { siteId: AppIdInput, syncId: SyncIdInput },
    },
    call(async ({ siteId, syncId }: { siteId: string; syncId: string }) =>
      runAppSyncNow(deps, grant, siteId, syncId),
    ),
  );

  server.registerTool(
    "app_sync_opt_in",
    {
      description:
        "Opt the person you act for in to a personal App data sync, or out with optedIn: false. Each run then fills only their own records, from their own account. Only do this when they ask.",
      inputSchema: {
        siteId: AppIdInput,
        syncId: SyncIdInput,
        optedIn: z4.boolean().optional().describe("false opts out. Default true."),
      },
    },
    call(
      async ({
        siteId,
        syncId,
        optedIn,
      }: {
        siteId: string;
        syncId: string;
        optedIn?: boolean | undefined;
      }) => setAppSyncOptIn(deps, grant, siteId, syncId, optedIn ?? true),
    ),
  );
}
