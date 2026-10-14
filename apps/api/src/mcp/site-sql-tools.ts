import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SiteSqlExportFormat,
  SiteSqlImportRequest,
  SiteSqlParams,
  SiteSqlQueryDefinitionRequest,
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
  runSiteSqlStatement,
  setSiteSqlSettings,
  SiteSqlError,
} from "../site-sql/service";

type JsonResult = (value: unknown) => {
  content: Array<{ type: "text"; text: string }>;
};

const SiteIdInput = z4.string().uuid().describe("The Site (published artifact) id.");
const NameInput = z4
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .describe("A letter, then letters, digits, - or _ (up to 64).");
const StatementInput = z4
  .string()
  .min(1)
  .max(64 * 1024)
  .describe("Exactly one SQLite statement; use :name parameters for values.");

/**
 * First-party Site SQL tools: optional per-Site Cloudflare storage (one SQLite
 * database per Site). Only the Site's managers (its owner, a workspace admin,
 * or an agent acting for them) can use them; Site pages call named queries
 * with site.sql.run. The tools act with the agent's own authority, through
 * the same service as the HTTP routes.
 */
export function registerSiteSqlTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  authorize: () => Promise<void>,
  json: JsonResult,
): void {
  const call =
    <A>(fn: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      await authorize();
      try {
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
      if (!described.available || !described.enabled) return { ...described, database: null };
      return { ...described, database: await inspectSiteSql(deps, grant, siteId) };
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
        'Create, replace or delete a named query a Site page runs with site.sql.run(name, params). Exactly one SELECT, INSERT, UPDATE, DELETE or REPLACE statement with :name parameters; pages pass values only, never SQL. :viewer (the viewer\'s principal, such as user:<id> or guest:<id>), :viewer_kind and :viewer_signed_in are bound by OpenGeni, so a query can keep rows per viewer: e.g. INSERT INTO votes (voter, choice) VALUES (:viewer, :choice). audience: everyone (including anonymous guests of public Sites), signed_in (default) or managers (agents and the console only). Set action to "delete" to remove the query.',
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
    z4.object({
      siteId: SiteIdInput,
      sql: StatementInput,
      params: SiteSqlParams.optional(),
      maxRows: z4.number().int().min(1).max(5_000).optional().describe("Most rows to return."),
    }),
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
        "Export a Site's database so its data can always leave Cloudflare: sql (schema and INSERT statements, ready for site_sql_import or any SQLite), csv (one table) or json (schema and rows per table). Bounded at 16 MB; check truncated.",
      inputSchema: {
        siteId: SiteIdInput,
        format: SiteSqlExportFormat.optional().describe("sql (default), csv or json."),
        table: z4
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
          .optional()
          .describe("Only this table (required for csv)."),
      },
    },
    call(
      async (args: {
        siteId: string;
        format?: "sql" | "csv" | "json" | undefined;
        table?: string | undefined;
      }) => {
        const exported = await exportSiteSql(deps, grant, args.siteId, {
          format: args.format ?? "sql",
          ...(args.table ? { table: args.table } : {}),
        });
        return {
          format: args.format ?? "sql",
          filename: exported.filename,
          truncated: exported.truncated,
          content: exported.content,
        };
      },
    ),
  );

  server.registerTool(
    "site_sql_import",
    {
      description:
        "Import data into a Site's database. sql: statements run together; any schema statements in it (CREATE TABLE ...) are recorded as a migration first. csv: a header row of column names, then rows, into an existing table (an empty cell is NULL). json: rows as objects keyed by column, into an existing table. onConflict (csv, json): fail (default), replace or ignore.",
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
      inputSchema: {
        siteId: SiteIdInput,
        schema: z4.enum(["keep", "drop"]).optional(),
        confirm: z4.literal(true).describe("Must be true."),
      },
    },
    call((args: { siteId: string; schema?: "keep" | "drop" | undefined; confirm: true }) =>
      resetSiteSql(deps, grant, args.siteId, { schema: args.schema }),
    ),
  );
}
