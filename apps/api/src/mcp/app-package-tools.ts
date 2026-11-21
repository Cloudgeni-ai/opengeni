import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  APP_PACKAGE_MAX_BYTES,
  AppPackageExportRequest,
  type AccessGrant,
  type AppPackageExportResponse,
} from "@opengeni/contracts";
import { fileOwnerContextForAgent, type ApiRouteDeps } from "@opengeni/core";
import { requireFileForSubject, withSessionRlsActorContext } from "@opengeni/db";
import * as z4 from "zod/v4";
import {
  AppPackageError,
  appInstallOperationKey,
  appPackageHttpError,
  exportAppPackage,
  installAppPackage,
} from "../app-packages/service";
import { appUpgradeOperationKey, upgradeAppFromPackage } from "../app-packages/upgrade";
import { recordAppPackageExport } from "../app-packages/exports";
import { userContentSignedGetUrlOptions } from "../http/user-content";
import { exactAgentAttemptClaims } from "../sandbox/agent-fleet-context";
import {
  SITE_AGENT_MANAGEMENT_MESSAGE,
  type SiteAgentDataResolution,
} from "../site-publishing/agent-data-tools";
import { contractToolInput } from "./contract-input";

type JsonResult = (value: unknown) => {
  content: Array<{ type: "text"; text: string }>;
};

const DOWNLOAD_SECONDS = 15 * 60;

/** A short account of what a package holds, for the agent to tell the person. */
function contents(exported: AppPackageExportResponse) {
  const pkg = exported.package;
  return {
    title: pkg.app.title,
    tools: pkg.tools.length,
    collections: pkg.data.collections.map((collection) => collection.name),
    migrations: pkg.sql.migrations.map((migration) => migration.name),
    queries: pkg.sql.queries.map((query) => query.name),
    syncs: pkg.syncs.length,
    sidebar: pkg.sidebar?.length ?? 0,
    demoData: pkg.demoData
      ? {
          records: Object.fromEntries(
            Object.entries(pkg.demoData.records).map(([name, rows]) => [name, rows.length]),
          ),
          sqlRows: Object.fromEntries(
            Object.entries(pkg.demoData.sqlRows).map(([name, rows]) => [name, rows.length]),
          ),
        }
      : null,
  };
}

/**
 * app_export, app_install and app_upgrade: carry an app (a Site) to another
 * workspace as one package file, and upgrade an installed copy from a newer
 * one. They act with the agent's own authority through the same service as
 * the HTTP routes: exporting needs the manager role on the app, installing
 * needs artifacts:publish here, upgrading both. A published Site's own
 * visitor assistant is refused, as for every management tool.
 */
export function registerAppPackageTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  authorize: () => Promise<void>,
  json: JsonResult,
  siteAgent: () => Promise<SiteAgentDataResolution>,
): void {
  const call =
    <A>(fn: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      await authorize();
      try {
        const site = await siteAgent();
        if (site.kind !== "ordinary")
          throw new AppPackageError(
            "validation",
            site.kind === "refused" ? site.message : SITE_AGENT_MANAGEMENT_MESSAGE,
          );
        return json(await fn(args));
      } catch (error) {
        const mapped = appPackageHttpError(error);
        if (!mapped) throw error;
        const envelope = {
          error: { code: mapped.code, message: mapped.message, details: mapped.details ?? {} },
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
          structuredContent: envelope,
          isError: true as const,
        };
      }
    };

  server.registerTool(
    "app_export",
    {
      description:
        "Export an app as one package file another workspace can install with app_install: its current version, the tools it uses, its data collections, database migrations and named queries, its syncs and its sidebar links. It carries no data unless you set demoData (only when the person asks for sample data). Returns a download URL for the file (fetch it with curl, then share it with sandbox_file_publish) and what the package holds. Only the app's managers can export it.",
      inputSchema: contractToolInput(
        z4.object({
          appId: z4.string().uuid().describe("The app (Site) id."),
          ...AppPackageExportRequest.shape,
        }),
      ),
    },
    call(async ({ appId, demoData }: { appId: string; demoData?: unknown }) => {
      const request = AppPackageExportRequest.safeParse({ demoData });
      if (!request.success) throw new AppPackageError("validation", "Invalid demoData");
      const exported = await exportAppPackage(deps, grant, appId, request.data);
      const storage = deps.objectStorage!;
      const bytes = new TextEncoder().encode(JSON.stringify(exported.package));
      const key = `workspaces/${grant.workspaceId}/app-packages/${crypto.randomUUID()}/${exported.filename}`;
      // Recorded first, so the sweeper deletes it once it expires (24 hours).
      await recordAppPackageExport(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        objectKey: key,
      });
      await storage.putObject({ key, contentType: "application/json", body: bytes });
      const signed = await storage.createGetUrl({
        key,
        expiresInSeconds: DOWNLOAD_SECONDS,
        audience: "sandbox",
        ...userContentSignedGetUrlOptions("application/json", exported.filename),
      });
      return {
        filename: exported.filename,
        sizeBytes: bytes.byteLength,
        downloadUrl: { url: signed.url, expiresAt: signed.expiresAt.toISOString() },
        contents: contents(exported),
        notExported: exported.notExported,
      };
    }),
  );

  server.registerTool(
    "app_install",
    {
      description:
        "Install an app package (a file made by app_export or the app's Export) into this workspace as a new app. The app starts with empty data (or the package's demo data unless demoData is false), its collections and database are set up, and its syncs are added paused until the person confirms the account they use. Give fileId (a file in this workspace, such as an attachment or a file you published with sandbox_file_publish) or the package JSON. Returns the new app and anything that couldn't be installed. Retrying with the same idempotencyKey returns the same app.",
      inputSchema: {
        fileId: z4.string().uuid().optional().describe("The package file's id in this workspace."),
        package: z4
          .record(z4.string(), z4.unknown())
          .optional()
          .describe("The package JSON itself, instead of fileId."),
        title: z4.string().min(1).max(120).optional().describe("A title instead of the package's."),
        visibility: z4
          .enum(["private", "workspace"])
          .optional()
          .describe("Who can see the app; omitted follows this chat."),
        demoData: z4
          .boolean()
          .optional()
          .describe("false installs the app without the package's demo data."),
        idempotencyKey: z4.string().min(1).max(200),
      },
    },
    call(
      async (args: {
        fileId?: string | undefined;
        package?: Record<string, unknown> | undefined;
        title?: string | undefined;
        visibility?: "private" | "workspace" | undefined;
        demoData?: boolean | undefined;
        idempotencyKey: string;
      }) => {
        if ((args.fileId === undefined) === (args.package === undefined))
          throw new AppPackageError("validation", "Give exactly one of fileId or package");
        const claims = exactAgentAttemptClaims(grant);
        if (!claims) throw new AppPackageError("validation", "Installing needs a live agent turn");
        const pkg = args.package ?? (await readPackageFile(deps, grant, args.fileId!));
        const result = await installAppPackage(deps, grant, {
          package: pkg,
          title: args.title,
          visibility: args.visibility,
          demoData: args.demoData,
          provenance: {
            operationKey: appInstallOperationKey(
              "attempt",
              `${claims.sessionId}:${claims.turnId}`,
              args.idempotencyKey,
              pkg,
            ),
            actorSubjectId: grant.subjectId,
            sourceSessionId: claims.sessionId,
            sourceTurnId: claims.turnId,
            sourceAttemptId: claims.attemptId,
            sourceExecutionGeneration: claims.executionGeneration,
            sourceToolName: "app_install",
          },
        });
        return {
          ...result,
          artifactReference: `[Open app](artifact:${result.app.id})`,
          ...(result.app && result.installed.tools > 0
            ? {
                nextStep:
                  "When the person opens the app, it asks them to connect the accounts its tools use.",
              }
            : {}),
        };
      },
    ),
  );

  server.registerTool(
    "app_upgrade",
    {
      description:
        "Upgrade an existing app from a newer package of it (made by app_export): its version becomes the app's new version, and only what is new runs (new collections, new migrations, query and sync changes). The app's data stays; nothing is deleted. Call with dryRun: true first and tell the person the plan. Changes marked destructive need allowDestructive: true and the person's explicit agreement; conflicts stop the upgrade. Give fileId or the package JSON. Retrying with the same idempotencyKey applies it once.",
      inputSchema: {
        appId: z4.string().uuid().describe("The app (Site) to upgrade."),
        fileId: z4.string().uuid().optional().describe("The package file's id in this workspace."),
        package: z4
          .record(z4.string(), z4.unknown())
          .optional()
          .describe("The package JSON itself, instead of fileId."),
        dryRun: z4.boolean().optional().describe("Only return the plan; nothing changes."),
        allowDestructive: z4
          .boolean()
          .optional()
          .describe("Apply changes the plan marks destructive, after the person agreed."),
        idempotencyKey: z4.string().min(1).max(200),
      },
    },
    call(
      async (args: {
        appId: string;
        fileId?: string | undefined;
        package?: Record<string, unknown> | undefined;
        dryRun?: boolean | undefined;
        allowDestructive?: boolean | undefined;
        idempotencyKey: string;
      }) => {
        if ((args.fileId === undefined) === (args.package === undefined))
          throw new AppPackageError("validation", "Give exactly one of fileId or package");
        const claims = exactAgentAttemptClaims(grant);
        if (!claims) throw new AppPackageError("validation", "Upgrading needs a live agent turn");
        const pkg = args.package ?? (await readPackageFile(deps, grant, args.fileId!));
        const result = await upgradeAppFromPackage(deps, grant, args.appId, {
          package: pkg,
          dryRun: args.dryRun,
          allowDestructive: args.allowDestructive,
          provenance: {
            operationKey: appUpgradeOperationKey(
              "attempt",
              `${claims.sessionId}:${claims.turnId}`,
              args.appId,
              args.idempotencyKey,
              pkg,
            ),
            actorSubjectId: grant.subjectId,
            sourceSessionId: claims.sessionId,
            sourceTurnId: claims.turnId,
            sourceAttemptId: claims.attemptId,
            sourceExecutionGeneration: claims.executionGeneration,
            sourceToolName: "app_upgrade",
          },
        });
        return {
          ...result,
          artifactReference: `[Open app](artifact:${result.app.id})`,
        };
      },
    ),
  );
}

async function readPackageFile(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  fileId: string,
): Promise<unknown> {
  const storage = deps.objectStorage;
  if (!storage) throw new AppPackageError("unavailable", "File storage isn't configured");
  let actor;
  try {
    actor = await fileOwnerContextForAgent(deps, grant, "files:read");
  } catch (error) {
    throw new AppPackageError(
      "validation",
      `This chat can't read workspace files (${error instanceof Error ? error.message : "no access"}); pass the package JSON instead`,
    );
  }
  const file = await withSessionRlsActorContext(actor, () =>
    requireFileForSubject(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      fileId,
    }),
  ).catch(() => {
    throw new AppPackageError("validation", `No file ${fileId} in this workspace`);
  });
  if (file.status !== "ready")
    throw new AppPackageError("validation", `The file is ${file.status}`);
  if (file.sizeBytes > APP_PACKAGE_MAX_BYTES)
    throw new AppPackageError("too_large", "This file is too large to be an app package");
  const bytes = await storage.getFileBytes(file);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppPackageError("validation", "This file isn't an app package (not JSON)");
  }
}
