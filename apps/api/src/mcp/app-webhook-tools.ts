import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { SiteDataError } from "@opengeni/db";
import * as z4 from "zod/v4";
import type { AppWebhook } from "@opengeni/contracts";
import {
  APP_WEBHOOK_PATH_PREFIX,
  createAppWebhook,
  deleteAppWebhook,
  listAppWebhooks,
  updateAppWebhook,
} from "../app-webhooks/service";
import {
  SITE_AGENT_MANAGEMENT_MESSAGE,
  type SiteAgentDataResolution,
} from "../site-publishing/agent-data-tools";

type JsonResult = (value: unknown) => {
  content: Array<{ type: "text"; text: string }>;
};

const AppIdInput = z4.string().uuid().describe("The app (published Site) id.");
const WebhookIdInput = z4.string().uuid().describe("The webhook's id, from app_webhook_list.");
const Path = z4.string().min(1).max(256);

/**
 * App webhook tools (docs/app-webhooks.md): inbound addresses that turn each
 * delivery from another service into records of the app's data.
 */
export function registerAppWebhookTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  authorize: () => Promise<void>,
  json: JsonResult,
  siteAgent?: () => Promise<SiteAgentDataResolution>,
): void {
  // Tool calls carry no request address: the API's own public MCP address
  // gives its origin. Without any public address, say where senders post.
  const apiAddress = deps.settings.opengeniMcpUrl ?? null;
  const addressed = (webhook: AppWebhook) =>
    webhook.url
      ? webhook
      : {
          ...webhook,
          path: `${APP_WEBHOOK_PATH_PREFIX}${grant.workspaceId}/${webhook.id}`,
          note: "This deployment has no public address set (OPENGENI_WEBHOOK_BASE_URL or OPENGENI_PUBLIC_BASE_URL): senders post to this path on the API's public address.",
        };
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
    "app_webhook_save",
    {
      description:
        "Create or change an app webhook: an address another service posts JSON to, and each delivery becomes records in a shared collection of the app's data at once (live updates, automations and workspace webhooks see the change). With key a delivery upserts by that key; without, it inserts. Without webhookId it creates one (name and collection required) and returns its url and secret once; tell the person to keep the secret, it isn't shown again. With webhookId only the given fields change; rotateSecret returns a new secret. Senders authenticate with the secret as a bearer token or an HMAC signature.",
      inputSchema: {
        siteId: AppIdInput,
        webhookId: WebhookIdInput.optional().describe(
          "Change this webhook instead of creating one.",
        ),
        name: z4.string().min(1).max(200).optional().describe("A short name people recognize."),
        collection: z4
          .string()
          .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
          .optional()
          .describe(
            "The shared, shared_read or append_only collection to fill; define it first with app_data_define_collection.",
          ),
        recordsPath: Path.nullable()
          .optional()
          .describe(
            "Dot path to the record or list of records in the body (for example data). Omit to use the body itself.",
          ),
        key: Path.nullable()
          .optional()
          .describe("Dot path to each record's unique key (for example id). Omit to insert."),
        fields: z4
          .array(Path)
          .max(100)
          .nullable()
          .optional()
          .describe("Dot paths of the fields to keep. Omit to keep whole records."),
        status: z4
          .enum(["active", "paused"])
          .optional()
          .describe("A paused webhook refuses deliveries."),
        rotateSecret: z4
          .boolean()
          .optional()
          .describe("Replace the secret (existing webhooks only)."),
      },
    },
    call(
      async (
        args: { siteId: string; webhookId?: string | undefined } & Record<string, unknown>,
      ) => {
        const { siteId, webhookId, rotateSecret, ...fields } = args;
        const body = Object.fromEntries(
          Object.entries(fields).filter(([, value]) => value !== undefined),
        );
        const saved = webhookId
          ? await updateAppWebhook(
              deps,
              grant,
              siteId,
              webhookId,
              { ...body, ...(rotateSecret === true ? { rotateSecret: true } : {}) },
              apiAddress,
            )
          : await createAppWebhook(deps, grant, siteId, body, apiAddress);
        return { ...saved, webhook: addressed(saved.webhook) };
      },
    ),
  );

  server.registerTool(
    "app_webhook_list",
    {
      description:
        "List an app's webhooks: address, collection, mapping, status and last delivery (time, status, error). Secrets are never listed. Needs a manager of the app.",
      inputSchema: { siteId: AppIdInput },
    },
    call(async ({ siteId }: { siteId: string }) => ({
      webhooks: (await listAppWebhooks(deps, grant, siteId, apiAddress)).map(addressed),
    })),
  );

  server.registerTool(
    "app_webhook_delete",
    {
      description:
        "Delete an app webhook; its address stops accepting deliveries. Records it wrote stay.",
      inputSchema: { siteId: AppIdInput, webhookId: WebhookIdInput },
    },
    call(async ({ siteId, webhookId }: { siteId: string; webhookId: string }) =>
      deleteAppWebhook(deps, grant, siteId, webhookId),
    ),
  );
}
