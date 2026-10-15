import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SiteSqlExportFormat,
  SiteSqlImportRequest,
  SiteSqlQueryDefinitionRequest,
  SiteSqlResetRequest,
  SiteSqlRunRequest,
  SiteSqlStatementRequest,
  type AccessGrant,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import * as z4 from "zod/v4";
import { contractToolInput } from "./contract-input";
import {
  defineSiteSqlQuery,
  describeSiteSql,
  exportSiteSql,
  importSiteSql,
  inspectSiteSql,
  migrateSiteSql,
  resetSiteSql,
  runSiteSqlQuery,
  runSiteSqlStatement,
  setSiteSqlSettings,
  SiteSqlError,
} from "../site-sql/service";
import {
  SITE_AGENT_MANAGEMENT_MESSAGE,
  SITE_AGENT_OTHER_SITE_MESSAGE,
  type SiteAgentDataContext,
  type SiteAgentDataResolution,
} from "../site-publishing/agent-data-tools";

type JsonResult = (value: unknown) => {
  content: Array<{ type: "text"; text: string }>;
};

const SiteIdInput = z4.string().uuid().describe("The Site (published artifact) id.");
const NameInput = z4
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .describe("A letter, then letters, digits, - or _ (up to 64).");
/** Export pieces through the tool stay small, so they fit in an agent's context. */
const SITE_SQL_TOOL_EXPORT_DEFAULT_BYTES = 512 * 1024;
const SITE_SQL_TOOL_EXPORT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * First-party Site SQL tools: optional per-Site Cloudflare storage (one SQLite
 * database per Site). Only the Site's managers (its owner, a workspace admin,
 * or an agent acting for them) can manage it; Site pages call named queries
 * with site.sql.run, and so can agents with site_sql_run. The tools act with
 * the agent's own authority, through the same service as the HTTP routes. An
 * agent started from a Site page gets that page's reach (resolveSiteDataAccess):
 * every management tool refuses it, and site_sql_run runs only the named
 * queries the page itself could run, on that Site.
 *
 * A published Site's own agent (`siteAgent` resolves a Site context) gets
 * `site_sql_run` as the conversation's viewer (audiences and `:viewer` as on
 * the page) and, for workspace members, read-only `site_sql_query`; both are
 * pinned to that Site and every other tool refuses it.
 */
export function registerSiteSqlTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  authorize: () => Promise<void>,
  json: JsonResult,
  siteAgent?: () => Promise<SiteAgentDataResolution>,
): void {
  const call =
    <A extends { siteId: string }>(
      fn: (args: A) => Promise<unknown>,
      forSiteAgent?: (site: SiteAgentDataContext, args: A) => Promise<unknown>,
    ) =>
    async (args: A) => {
      await authorize();
      try {
        const site = siteAgent ? await siteAgent() : null;
        if (site && site.kind !== "ordinary") {
          if (site.kind === "refused") throw new SiteSqlError("forbidden", site.message);
          if (!forSiteAgent) throw new SiteSqlError("forbidden", SITE_AGENT_MANAGEMENT_MESSAGE);
          if (args.siteId !== site.siteId)
            throw new SiteSqlError("forbidden", SITE_AGENT_OTHER_SITE_MESSAGE);
          return json(await forSiteAgent(site, args));
        }
        return json(await fn(args));
      } catch (error) {
        if (!(error instanceof SiteSqlError)) throw error;
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
    "site_sql_inspect",
    {
      description:
        "Describe a Site's SQL database (optional Cloudflare storage, one SQLite database per Site): whether it is available and turned on, its migrations, named queries, usage and limits, and, when it exists, its tables, columns, row counts and indexes. Only the Site's managers can use Site SQL tools.",
      inputSchema: { siteId: SiteIdInput },
    },
    call(async ({ siteId }: { siteId: string }) => {
      const described = await describeSiteSql(deps, grant, siteId);
      // The database is inspectable whenever it exists and the gateway is
      // configured, also while Site SQL is off or no longer offered.
      try {
        return { ...described, database: await inspectSiteSql(deps, grant, siteId) };
      } catch (error) {
        if (
          error instanceof SiteSqlError &&
          (error.code === "unavailable" || error.code === "disabled")
        )
          return { ...described, database: null };
        throw error;
      }
    }),
  );

  server.registerTool(
    "site_sql_enable",
    {
      description:
        "Turn a Site's SQL database on or off. Turn it on before adding migrations or queries. Turning it off stops Site pages and SQL tools from using it but keeps its data, migrations and queries (export still works).",
      inputSchema: { siteId: SiteIdInput, enabled: z4.boolean() },
    },
    call((args: { siteId: string; enabled: boolean }) =>
      setSiteSqlSettings(deps, grant, args.siteId, { enabled: args.enabled }),
    ),
  );

  server.registerTool(
    "site_sql_migrate",
    {
      description:
        "Change a Site's database schema with a named migration (CREATE TABLE, CREATE INDEX, ALTER TABLE, and optional seed INSERTs). Migrations are kept in order and replayed when the database is rebuilt; a name can be used once. Any earlier migration the database is missing is applied first.",
      inputSchema: {
        siteId: SiteIdInput,
        name: NameInput.describe("A unique migration name, such as create_votes."),
        sql: z4
          .string()
          .min(1)
          .max(2 * 1024 * 1024)
          .describe("One or more statements, separated by semicolons. No :parameters."),
      },
    },
    call((args: { siteId: string; name: string; sql: string }) =>
      migrateSiteSql(deps, grant, args.siteId, { name: args.name, sql: args.sql }),
    ),
  );

  server.registerTool(
    "site_sql_define_query",
    {
      description:
        'Create, replace or delete a named query a Site page runs with site.sql.run(name, params). Exactly one SELECT, INSERT, UPDATE, DELETE or REPLACE statement with :name parameters; pages pass values only, never SQL. :viewer (the viewer\'s principal, such as user:<id> or guest:<id>), :viewer_kind and :viewer_signed_in are bound by Opengeni, so a query can keep rows per viewer: e.g. INSERT INTO votes (voter, choice) VALUES (:viewer, :choice). audience: everyone (including anonymous guests of public Sites), signed_in (default) or managers (agents and the console only). Set action to "delete" to remove the query.',
      inputSchema: contractToolInput(
        z4.object({
          siteId: SiteIdInput,
          name: NameInput,
          action: z4
            .enum(["upsert", "delete"])
            .optional()
            .describe("upsert (default) creates or replaces; delete removes the query."),
          ...SiteSqlQueryDefinitionRequest.shape,
          sql: SiteSqlQueryDefinitionRequest.shape.sql.optional().describe("Required for upsert."),
        }),
      ),
    },
    call(
      async (args: {
        siteId: string;
        name: string;
        action?: "upsert" | "delete" | undefined;
        sql?: string | undefined;
        audience?: "everyone" | "signed_in" | "managers" | undefined;
        description?: string | undefined;
        maxRows?: number | undefined;
      }) => {
        if (args.action === "delete") {
          await defineSiteSqlQuery(deps, grant, args.siteId, args.name, null);
          return { deleted: args.name };
        }
        if (!args.sql) throw new SiteSqlError("validation", "Give sql to define a query");
        const result = await defineSiteSqlQuery(deps, grant, args.siteId, args.name, {
          sql: args.sql,
          ...(args.audience ? { audience: args.audience } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.maxRows !== undefined ? { maxRows: args.maxRows } : {}),
        });
        return { query: result.query, created: result.created };
      },
    ),
  );

  const statementInput = contractToolInput(
    z4.object({ siteId: SiteIdInput, ...SiteSqlStatementRequest.shape }),
  );

  server.registerTool(
    "site_sql_query",
    {
      description:
        "Run one read-only statement (SELECT, WITH, read-only PRAGMA or EXPLAIN) on a Site's database and return its rows. A statement that writes is refused.",
      inputSchema: statementInput,
    },
    call(
      (args: {
        siteId: string;
        sql: string;
        params?: Record<string, string | number | boolean | null> | undefined;
        maxRows?: number | undefined;
      }) =>
        runSiteSqlStatement(
          deps,
          grant,
          args.siteId,
          {
            sql: args.sql,
            ...(args.params ? { params: args.params } : {}),
            ...(args.maxRows ? { maxRows: args.maxRows } : {}),
          },
          "read",
        ),
      async (site, args) => {
        // Workspace members only, read-only, as that member.
        if (site.viewerKind !== "member")
          throw new SiteSqlError(
            "forbidden",
            "Only workspace members can query this Site's database through its assistant",
          );
        return await runSiteSqlStatement(
          deps,
          site.viewer,
          site.siteId,
          {
            sql: args.sql,
            ...(args.params ? { params: args.params } : {}),
            ...(args.maxRows ? { maxRows: args.maxRows } : {}),
          },
          "read",
          { asSiteMember: true },
        );
      },
    ),
  );

  server.registerTool(
    "site_sql_run",
    {
      description:
        "Run one of a Site's named queries by name, as a Site page does with site.sql.run(name, params). The query's audience applies to you as it would to the page's viewer; :viewer and the other principal parameters are bound from you, not from params. Use site_sql_inspect to list the queries.",
      inputSchema: contractToolInput(
        z4.object({
          siteId: SiteIdInput,
          name: NameInput.describe("The named query, as defined with site_sql_define_query."),
          ...SiteSqlRunRequest.shape,
        }),
      ),
    },
    call(
      (args: {
        siteId: string;
        name: string;
        params?: Record<string, string | number | boolean | null> | undefined;
      }) => runSiteSqlQuery(deps, grant, args.siteId, args.name, args.params ?? {}),
      (site, args) =>
        runSiteSqlQuery(
          deps,
          site.viewer,
          site.siteId,
          args.name,
          args.params ?? {},
          { frameSiteId: site.siteId },
          {
            profileKind: site.profileKind,
            beforeWrite: async () => {
              // Guests' write queries count against the guest write limit.
              const wait = await site.guestWrite();
              if (wait !== null)
                throw new SiteSqlError("rate_limited", "Too many writes; try again shortly", {
                  retryAfterSeconds: wait,
                });
            },
          },
        ),
    ),
  );

  server.registerTool(
    "site_sql_execute",
    {
      description:
        "Run one statement that changes data (INSERT, UPDATE, DELETE, REPLACE) on a Site's database. Schema changes go through site_sql_migrate so the database can be rebuilt.",
      inputSchema: statementInput,
    },
    call(
      (args: {
        siteId: string;
        sql: string;
        params?: Record<string, string | number | boolean | null> | undefined;
        maxRows?: number | undefined;
      }) =>
        runSiteSqlStatement(
          deps,
          grant,
          args.siteId,
          {
            sql: args.sql,
            ...(args.params ? { params: args.params } : {}),
            ...(args.maxRows ? { maxRows: args.maxRows } : {}),
          },
          "write",
        ),
    ),
  );

  server.registerTool(
    "site_sql_export",
    {
      description:
        "Export a Site's database so its data can always leave Cloudflare: sql (schema, multi-row INSERT statements, then triggers; ready for site_sql_import or any SQLite), csv (one table; values become text) or json (schema and rows per table). SQL and JSON keep every value. One call returns at most maxBytes (default 512 KB); when nextCursor is set, call again with it as cursor and append the pieces in order (only the first piece has the schema or CSV header, only the last SQL piece has the triggers). Works while Site SQL is off.",
      inputSchema: {
        siteId: SiteIdInput,
        format: SiteSqlExportFormat.optional().describe("sql (default), csv or json."),
        table: z4
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
          .optional()
          .describe("Only this table (required for csv)."),
        cursor: z4
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe("nextCursor from the previous piece, to continue the export."),
        maxBytes: z4
          .number()
          .int()
          .min(1024)
          .max(SITE_SQL_TOOL_EXPORT_MAX_BYTES)
          .optional()
          .describe("Most bytes of this piece (default 512 KB, at most 2 MB)."),
      },
    },
    call(
      async (args: {
        siteId: string;
        format?: "sql" | "csv" | "json" | undefined;
        table?: string | undefined;
        cursor?: string | undefined;
        maxBytes?: number | undefined;
      }) => {
        const exported = await exportSiteSql(deps, grant, args.siteId, {
          format: args.format ?? "sql",
          ...(args.table ? { table: args.table } : {}),
          ...(args.cursor ? { cursor: args.cursor } : {}),
          maxBytes: Math.min(
            args.maxBytes ?? SITE_SQL_TOOL_EXPORT_DEFAULT_BYTES,
            SITE_SQL_TOOL_EXPORT_MAX_BYTES,
          ),
        });
        return {
          format: args.format ?? "sql",
          filename: exported.filename,
          truncated: exported.truncated,
          nextCursor: exported.nextCursor,
          content: exported.content,
        };
      },
    ),
  );

  server.registerTool(
    "site_sql_import",
    {
      description:
        "Import data into a Site's database (at most 2 MB per call). sql: schema statements (CREATE TABLE, INDEX, VIEW) are recorded as a migration first, the data statements run in batches, and triggers are recorded as a second migration after the data so they do not fire on imported rows; import the pieces of a large site_sql_export in order. csv: a header row of column names, then rows, into an existing table (an empty cell is NULL). json: rows as objects keyed by column, into an existing table. onConflict (csv, json): fail (default), replace or ignore. When a batch fails, earlier batches stay; the error says how much landed and which migration was recorded.",
      inputSchema: contractToolInput(
        z4.object({ siteId: SiteIdInput, ...SiteSqlImportRequest.shape }),
      ),
    },
    call((args: { siteId: string } & Record<string, unknown>) => {
      const { siteId, ...rest } = args;
      const parsed = SiteSqlImportRequest.safeParse(rest);
      if (!parsed.success)
        throw new SiteSqlError(
          "validation",
          parsed.error.issues[0]?.message ?? "Give sql for sql, or table plus csv or rows",
        );
      return importSiteSql(deps, grant, siteId, parsed.data);
    }),
  );

  server.registerTool(
    "site_sql_reset",
    {
      description:
        'Empty a Site\'s database. schema "keep" (default) deletes every row and rebuilds the tables from the migrations; "drop" deletes the database and forgets every migration and named query. Export first if the data matters. Needs confirm: true.',
      inputSchema: contractToolInput(
        z4.object({ siteId: SiteIdInput, ...SiteSqlResetRequest.shape }),
      ),
    },
    call((args: { siteId: string; schema?: "keep" | "drop" | undefined; confirm: true }) =>
      resetSiteSql(deps, grant, args.siteId, { schema: args.schema }),
    ),
  );
}
