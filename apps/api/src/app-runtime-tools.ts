import type {
  AccessGrant,
  CanonicalToolDescriptor,
  CanonicalToolResult,
  Permission,
} from "@opengeni/contracts";
import { CanonicalToolDescriptor as CanonicalToolDescriptorSchema } from "@opengeni/contracts";
import {
  allocateCanonicalToolProjections,
  assertCanonicalToolDescriptorUniqueness,
  digestCanonicalJson,
  sortCanonicalToolDescriptors,
} from "@opengeni/tool-runtime";
import {
  hasPermission,
  type ApiRouteDeps,
  type AppCurrentHumanAuthority,
  type AppRuntimeToolBinding,
  type AppRuntimeToolProvider,
} from "@opengeni/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { buildDocumentsMcpServer } from "./mcp/documents";
import { buildOpenGeniMcpServer } from "./mcp/server";

type AppSafeToolClassification = Readonly<{
  requiredPermissions:
    | readonly Permission[]
    | ((authority: AppCurrentHumanAuthority) => readonly Permission[]);
}>;

type AppMcpSource = Readonly<{
  serverId: "opengeni" | "docs";
  source: "opengeni" | "docs";
  classifications: Readonly<Record<string, AppSafeToolClassification>>;
  create(): McpServer;
}>;

const permission = (...requiredPermissions: Permission[]): AppSafeToolClassification => ({
  requiredPermissions,
});

const OPENGENI_APP_SAFE_TOOLS = Object.freeze({
  rig_list: permission("rigs:use"),
  rig_get: permission("rigs:use"),
  sessions_list: permission("sessions:read"),
  session_get: permission("sessions:read"),
  session_events: permission("sessions:read"),
  variable_set_list: permission("variable-sets:list", "secrets:list"),
  environment_list: permission("variable-sets:list", "secrets:list"),
  github_repositories_list: permission("github:use"),
  social_connections_list: permission("connections:read"),
  social_posts_recent: permission("connections:read"),
  social_daily_analysis_context: permission("connections:read"),
  x_accounts_list: permission("connections:read"),
  reddit_accounts_list: permission("connections:read"),
  scheduled_tasks_list: scheduledTaskReadPermission(),
  scheduled_tasks_get: scheduledTaskReadPermission(),
  scheduled_task_runs_list: scheduledTaskReadPermission(),
  slack_bot_list_channels: permission("connections:read"),
  slack_bot_search: permission("connections:read"),
  slack_bot_channel_history: permission("connections:read"),
  slack_bot_thread_replies: permission("connections:read"),
  slack_bot_list_users: permission("connections:read"),
  slack_bot_list_files: permission("connections:read"),
  slack_bot_file_info: permission("connections:read"),
  slack_bot_file_content: permission("connections:read"),
  fiken_companies_list: permission("connections:read"),
  fiken_contacts_list: permission("connections:read"),
  fiken_products_list: permission("connections:read"),
  fiken_invoices_list: permission("connections:read"),
  fiken_invoice_get: permission("connections:read"),
  fiken_bank_accounts_list: permission("connections:read"),
  fiken_purchases_list: permission("connections:read"),
  fiken_sales_list: permission("connections:read"),
  atlassian_sources_list: permission("connections:read"),
  atlassian_search: permission("connections:read"),
  atlassian_get: permission("connections:read"),
} satisfies Readonly<Record<string, AppSafeToolClassification>>);

const DOCS_APP_SAFE_TOOLS = Object.freeze({
  list_document_bases: permission("documents:search"),
  search_documents: permission("documents:search"),
  knowledge_search: permission("documents:search"),
  knowledge_get: permission("documents:search"),
  knowledge_browse: permission("documents:search"),
  list_indexed_documents: permission("documents:search"),
  fetch_document_chunk: permission("documents:search"),
  knowledge_fetch: permission("documents:search"),
  memory_search: permission("documents:search"),
} satisfies Readonly<Record<string, AppSafeToolClassification>>);

/**
 * Default Apps runtime provider for the standalone API.
 *
 * It reuses the same in-process MCP handlers as the authenticated human, but
 * exposes only an explicit server-owned allowlist of closed-world,
 * replay-safe reads. Provider annotations are retained as descriptions only;
 * they never decide App eligibility.
 */
export function createCurrentHumanAppRuntimeToolProvider(
  getDeps: () => ApiRouteDeps,
): AppRuntimeToolProvider {
  return Object.freeze({
    async resolve(input: Parameters<AppRuntimeToolProvider["resolve"]>[0]) {
      const deps = getDeps();
      const authority = freezeAuthority(input.authority);
      const grant = currentHumanGrant(authority);
      const sources = appMcpSources(deps, authority, grant);
      const listed = (
        await Promise.all(
          sources.map(async (source) => ({
            source,
            tools: await withMcpClient(source.create(), async (client) =>
              (await client.listTools()).tools.filter((tool) =>
                Object.hasOwn(source.classifications, tool.name),
              ),
            ),
          })),
        )
      ).flatMap(({ source, tools }) =>
        tools.map((tool) => ({
          source,
          tool,
          identity: { serverId: source.serverId, toolName: tool.name },
        })),
      );
      const projections = allocateCanonicalToolProjections(
        listed.map(({ identity }) => ({ identity })),
      );
      const descriptors = sortCanonicalToolDescriptors(
        listed.map(({ source, tool, identity }, index) => {
          const classification = source.classifications[tool.name]!;
          const requiredPermissions =
            typeof classification.requiredPermissions === "function"
              ? classification.requiredPermissions(authority)
              : classification.requiredPermissions;
          return CanonicalToolDescriptorSchema.parse({
            identity,
            modelName: projections[index]!.modelName,
            programmaticPath: projections[index]!.programmaticPath,
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
            ...(tool.icons ? { icons: tool.icons } : {}),
            source: source.source,
            effect: "read",
            replaySafety: "safe",
            openWorld: false,
            approval: "none",
            supportedSurfaces: ["app"],
            requiredPermissions,
          });
        }),
      );
      assertCanonicalToolDescriptorUniqueness(descriptors);
      const descriptorByIdentity = new Map(
        descriptors.map((descriptor) => [identityKey(descriptor.identity), descriptor]),
      );
      const sourceByIdentity = new Map(
        listed.map(({ source, identity }) => [identityKey(identity), source]),
      );
      const bindings: AppRuntimeToolBinding[] = descriptors.map((descriptor) => ({
        descriptor,
        invoke: async (argumentsValue, context) => {
          if (
            !input.releaseId ||
            context.caller.appId !== input.appId ||
            context.caller.releaseId !== input.releaseId ||
            !sameAuthority(context.caller.authority, authority)
          ) {
            throw new Error("App runtime authority changed before tool invocation");
          }
          const source = sourceByIdentity.get(identityKey(descriptor.identity));
          if (
            !source ||
            descriptorByIdentity.get(identityKey(descriptor.identity)) !== descriptor
          ) {
            throw new Error("App runtime tool binding is unavailable");
          }
          return await withMcpClient(
            source.create(),
            async (client) =>
              (await client.callTool(
                { name: descriptor.identity.toolName, arguments: argumentsValue },
                undefined,
                context.signal ? { signal: context.signal } : undefined,
              )) as CanonicalToolResult,
          );
        },
      }));
      return Object.freeze({
        catalogDigest: digestCanonicalJson(descriptors),
        bindings: Object.freeze(bindings),
      });
    },
  });
}

function appMcpSources(
  deps: ApiRouteDeps,
  authority: AppCurrentHumanAuthority,
  grant: AccessGrant,
): AppMcpSource[] {
  const sources: AppMcpSource[] = [
    {
      serverId: "opengeni",
      source: "opengeni",
      classifications: OPENGENI_APP_SAFE_TOOLS,
      create: () => buildOpenGeniMcpServer(deps, grant),
    },
  ];
  if (hasPermission(authority.permissions, "documents:search")) {
    sources.push({
      serverId: "docs",
      source: "docs",
      classifications: DOCS_APP_SAFE_TOOLS,
      create: () =>
        buildDocumentsMcpServer(
          deps.db,
          authority.accountId,
          authority.workspaceId,
          deps.getDocumentServices(),
          { initiatingSubjectId: authority.subjectId },
        ),
    });
  }
  return sources;
}

async function withMcpClient<T>(server: McpServer, operation: (client: Client) => Promise<T>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "opengeni-app-runtime", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await operation(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

function currentHumanGrant(authority: AppCurrentHumanAuthority): AccessGrant {
  return {
    accountId: authority.accountId,
    workspaceId: authority.workspaceId,
    subjectId: authority.subjectId,
    permissions: [...authority.permissions],
    principalKind: "human_session",
  };
}

function freezeAuthority(authority: AppCurrentHumanAuthority): AppCurrentHumanAuthority {
  return Object.freeze({ ...authority, permissions: Object.freeze([...authority.permissions]) });
}

function sameAuthority(left: AppCurrentHumanAuthority, right: AppCurrentHumanAuthority): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.subjectId === right.subjectId &&
    left.principalKind === right.principalKind &&
    left.canonicalManagedHumanSession === right.canonicalManagedHumanSession &&
    left.canonicalLocalHumanSession === right.canonicalLocalHumanSession &&
    left.sourceSessionId === right.sourceSessionId &&
    left.sourceTurnId === right.sourceTurnId &&
    left.sourceAttemptId === right.sourceAttemptId &&
    left.sourceExecutionGeneration === right.sourceExecutionGeneration &&
    left.managedActorEpoch === right.managedActorEpoch &&
    left.managedSessionSetAuthorityHash === right.managedSessionSetAuthorityHash &&
    left.currentHuman === right.currentHuman &&
    samePermissions(left.permissions, right.permissions)
  );
}

function samePermissions(left: readonly Permission[], right: readonly Permission[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return expected.size === left.length && left.every((value) => expected.has(value));
}

function identityKey(identity: CanonicalToolDescriptor["identity"]): string {
  return `${identity.serverId}\0${identity.toolName}`;
}

function scheduledTaskReadPermission(): AppSafeToolClassification {
  return {
    requiredPermissions: (authority) =>
      hasPermission(authority.permissions, "scheduled_tasks:manage")
        ? ["scheduled_tasks:manage"]
        : ["scheduled_tasks:run"],
  };
}
