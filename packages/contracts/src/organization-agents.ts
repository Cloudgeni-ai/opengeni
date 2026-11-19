import { z } from "zod";
import { defineSchema } from "./define-schema";
import {
  AgentCapabilities,
  AgentConfigRequest,
  AgentIdentity,
  AgentRenderer,
  AgentTitleInstructions,
} from "./agent-config";
import { ConsoleEndUser } from "./console";
import { McpElicitationContent } from "./mcp-elicitation";
import { ReasoningEffort } from "./reasoning-effort";
import { secretValue } from "./secret-value";
import { SessionStatus } from "./session-topology-primitives";

/**
 * Console agents (organization agents, docs/agents.md "Console agents").
 *
 * An organization agent belongs to the organization, not to a workspace. Its
 * settings live in numbered, immutable versions: Instructions plus an
 * {@link OrgAgentVersionConfig} (model, built-ins, tool servers and their
 * tools and approvals). One version is published; new chats that name the
 * agent run it, and each chat is pinned to the version it started on until a
 * publish moves it.
 *
 * There are three setups:
 * - Console agent (`managedBy: "console"`): edited, published and rolled back
 *   in Console.
 * - Code agent (`managedBy: "code"`): one YAML file per agent, deployed with
 *   `npx opengeni agents deploy`, the GitHub Action or `PUT .../apply`.
 *   Read-only in Console.
 * - No agent: a chat that names no organization agent behaves exactly as
 *   before; nothing here runs for it.
 *
 * A chat that names an agent can still change settings for itself (model,
 * extra instructions, tool servers, tools, approvals, built-ins). What it
 * changed is recorded on the session and shown in Console as "Changed by
 * this chat".
 *
 * This module must not import `./index`.
 */

export const ORG_AGENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const ORG_AGENT_NAME_MAX_LENGTH = 120;
export const ORG_AGENT_DESCRIPTION_MAX_LENGTH = 280;
/** Same bound as a workspace agent's Instructions. */
export const ORG_AGENT_INSTRUCTIONS_MAX_LENGTH = 20_000;
export const ORG_AGENT_TOOL_SERVERS_MAX = 32;
export const ORG_AGENT_TOOL_NAMES_MAX = 2_000;
/** Stored version config bound (`agent_revisions.config`, `pg_column_size`). */
export const ORG_AGENT_CONFIG_MAX_BYTES = 262_144;
/** Agents one organization keeps. */
export const ORG_AGENTS_PER_ORGANIZATION_MAX = 1_000;
export const ORG_TOOL_SERVERS_PER_ORGANIZATION_MAX = 200;
/** Chats one publish moves per batch. */
export const ORG_AGENT_PUBLISH_MOVE_BATCH_SIZE = 500;

export const ORG_AGENT_ERROR_CODES = [
  /** No such agent here: unknown, archived, not available in this workspace, or Console agents are off. */
  "agent_not_found",
  /** The agent has no published version yet. */
  "agent_not_published",
  /** The agent is edited in Console; code deploys and inline config are refused. */
  "agent_managed_in_console",
  /** The agent is managed by code; Console edits are refused. */
  "agent_managed_by_code",
  /** `agentOverrides: "reject"` and the request changed the agent's settings. */
  "agent_override_rejected",
  /** `expectedVersion` is stale; `details.currentVersion` has the current one. */
  "agent_version_conflict",
  /** Another agent in this organization already uses the key. */
  "agent_key_taken",
  /** The version does not exist. */
  "agent_version_not_found",
  /** The config names a tool server this organization does not have. */
  "tool_server_not_found",
  /** Another tool server in this organization already uses the key. */
  "tool_server_key_taken",
  /** The organization keeps the most agents or tool servers it can. */
  "organization_agent_limit_reached",
  /** End-user logins are stored only for workspaces the organization manages. */
  "workspace_not_managed",
  /** Only an organization owner can change who manages an agent. */
  "agent_management_requires_owner",
  /**
   * The change reaches every workspace of the organization (tool servers, or
   * moving running chats to a published version): it needs an organization
   * key for all workspaces, not one limited to selected workspaces.
   */
  "organization_key_workspace_limited",
  /** A create names both `agentId` (a workspace agent) and an organization agent. */
  "agent_ref_conflict",
  /**
   * Saving an agent version from inline config, or giving a chat more than its
   * agent (tools the agent left off, less "Ask first", replacing one of its tool
   * servers), needs `agents:manage` for the organization.
   */
  "agents_manage_required",
  /** A workspace named in the request is not one of this organization's shared workspaces. */
  "workspace_not_found",
  /** The tool server settings do not fit together (for example a shared key on a `per_user` server). */
  "tool_server_invalid",
  /** The version's settings are larger than an agent version can store. */
  "agent_config_too_large",
  /**
   * Runs on: no organization machine has this id or name. Personal (Only me)
   * and workspace machines never run organization agents.
   */
  "machine_not_found",
  /** Runs on: no organization sandbox environment has this id or name. */
  "environment_not_found",
  /** A chat with an organization agent named a Personal (Only me) machine. */
  "personal_machine_not_allowed",
  /**
   * Runs on: the machine or sandbox environment does not work in this
   * workspace, or this deployment has no cloud sandboxes.
   */
  "runs_on_unavailable",
] as const;
export type OrgAgentErrorCode = (typeof ORG_AGENT_ERROR_CODES)[number];

export const OrgAgentKey = /* @__PURE__ */ defineSchema(() =>
  z.string().regex(ORG_AGENT_KEY_PATTERN, {
    message: "Use 1 to 64 lowercase letters, digits, '-' or '_', starting with a letter or digit.",
  }),
);
export type OrgAgentKey = z.infer<typeof OrgAgentKey>;

/** Tool server keys follow the agent key rule; a key is also the chat's MCP server id. */
export const OrgToolServerKey = OrgAgentKey;
export type OrgToolServerKey = z.infer<typeof OrgToolServerKey>;

const ToolName = /* @__PURE__ */ defineSchema(() => z.string().min(1).max(200));
const ToolNames = /* @__PURE__ */ defineSchema(() =>
  z.array(ToolName).max(ORG_AGENT_TOOL_NAMES_MAX),
);

export const OrgAgentName = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().min(1, { message: "Give the agent a name." }).max(ORG_AGENT_NAME_MAX_LENGTH),
);
export const OrgAgentDescription = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().max(ORG_AGENT_DESCRIPTION_MAX_LENGTH),
);
export const OrgAgentInstructions = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .trim()
    .max(ORG_AGENT_INSTRUCTIONS_MAX_LENGTH, {
      message: `Instructions can be at most ${ORG_AGENT_INSTRUCTIONS_MAX_LENGTH} characters.`,
    }),
);

/** Which of a server's tools the agent has: the listed ones, or every tool the server offers. */
export const OrgAgentToolSelection = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      mode: z.enum(["selected", "all"]).default("selected"),
      enabled: ToolNames.default([]),
    })
    .strict(),
);
export type OrgAgentToolSelection = z.infer<typeof OrgAgentToolSelection>;

/** Tools that ask a person before they run: a list of tool names, or `true` for every tool. */
export const OrgAgentToolApproval = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      ask: z.union([z.literal(true), ToolNames]).default([]),
    })
    .strict(),
);
export type OrgAgentToolApproval = z.infer<typeof OrgAgentToolApproval>;

/**
 * What happens to a tool the server starts offering after this version was
 * saved (not in the version's tool catalog): `off` (default) leaves it off,
 * `on` turns it on, `on_with_approval` turns it on behind "Ask first".
 */
export const OrgAgentNewToolsPolicy = /* @__PURE__ */ defineSchema(() =>
  z.enum(["off", "on", "on_with_approval"]),
);
export type OrgAgentNewToolsPolicy = z.infer<typeof OrgAgentNewToolsPolicy>;

export const OrgAgentToolServerConfig = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** The organization tool server's key. */
      server: OrgToolServerKey,
      tools: OrgAgentToolSelection.default({ mode: "selected", enabled: [] }),
      approval: OrgAgentToolApproval.default({ ask: [] }),
      /** Tools loaded before the first model request (no tool search needed). */
      eager: ToolNames.default([]),
      newTools: OrgAgentNewToolsPolicy.default("off"),
    })
    .strict(),
);
export type OrgAgentToolServerConfig = z.infer<typeof OrgAgentToolServerConfig>;
export type OrgAgentToolServerConfigInput = z.input<typeof OrgAgentToolServerConfig>;

export const OrgAgentWorkersConfig = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /**
       * Workers a chat starts always inherit its tools, approvals and logins.
       * They get the agent's Instructions only when this is on.
       */
      shareInstructions: z.boolean().default(false),
    })
    .strict(),
);
export type OrgAgentWorkersConfig = z.infer<typeof OrgAgentWorkersConfig>;

/** Where a chat with the agent runs: no computer, its own cloud sandbox, or one organization machine. */
export const ORG_AGENT_RUNS_ON_KINDS = ["none", "sandbox", "machine"] as const;
export const OrgAgentRunsOnKind = /* @__PURE__ */ defineSchema(() =>
  z.enum(ORG_AGENT_RUNS_ON_KINDS),
);
export type OrgAgentRunsOnKind = z.infer<typeof OrgAgentRunsOnKind>;

const ComputeRef = /* @__PURE__ */ defineSchema(() => z.string().trim().min(1).max(200));

/**
 * Runs on (`runsOn`). Omitted: chats are placed as any chat in that workspace
 * is today (its default machine, else a cloud sandbox).
 *
 * - `none` (No computer): tools and API only; the chat has no sandbox
 *   (`sandboxBackend: "none"`).
 * - `sandbox` (Cloud sandbox): each chat gets its own isolated cloud sandbox,
 *   optionally built from an organization sandbox environment
 *   (`environment`: its name or id).
 * - `machine` (Organization machine): every chat runs on one organization
 *   Connected Machine (`machine`: its name, machine id or sandbox id), shared
 *   by all chats. Personal (Only me) and workspace machines are refused.
 *
 * The machine or environment must work in the workspaces the agent's chats
 * run in (its reach, for example "All product-managed workspaces"). A request
 * may still pass `sandboxBackend`, `targetSandboxId` or `rigId` for one chat;
 * the same reach and machine-access checks apply.
 */
export const OrgAgentRunsOn = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: OrgAgentRunsOnKind,
      /** `sandbox` only: the organization sandbox environment's name or id. */
      environment: ComputeRef.optional(),
      /** `machine` only: the organization machine's name, machine id or sandbox id. */
      machine: ComputeRef.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.kind === "machine" && value.machine === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["machine"],
          message: "Name the organization machine the agent runs on.",
        });
      }
      if (value.kind !== "machine" && value.machine !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["machine"],
          message: 'machine is only for kind "machine".',
        });
      }
      if (value.kind !== "sandbox" && value.environment !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["environment"],
          message: 'environment is only for kind "sandbox".',
        });
      }
    }),
);
export type OrgAgentRunsOn = z.infer<typeof OrgAgentRunsOn>;

/**
 * What Console suggests when `runsOn` is omitted: `sandbox` when the built-ins
 * that use a computer can be on (Browser or Workspace files, which includes
 * omitted built-ins and `"all"`), otherwise `none`. A suggestion only:
 * omitted `runsOn` always keeps today's placement.
 */
export function suggestedOrgAgentRunsOnKind(
  capabilities: z.input<typeof AgentCapabilities> | undefined,
): "none" | "sandbox" {
  if (capabilities === undefined || capabilities === "all") return "sandbox";
  if (capabilities === "none") return "none";
  const startsOn = capabilities.from === "all";
  const on = (value: boolean | undefined) => value ?? startsOn;
  return on(capabilities.browser) || on(capabilities.workspaceFiles) ? "sandbox" : "none";
}

/** Settings of one agent version (Instructions are stored beside it). */
export const OrgAgentVersionConfig = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      model: z.string().min(1).max(200).optional(),
      reasoningEffort: ReasoningEffort.optional(),
      /** Built-ins; omitted keeps the workspace default. */
      capabilities: AgentCapabilities.optional(),
      identity: AgentIdentity.nullable().optional(),
      renderer: AgentRenderer.optional(),
      titleInstructions: AgentTitleInstructions.nullable().optional(),
      toolServers: z.array(OrgAgentToolServerConfig).max(ORG_AGENT_TOOL_SERVERS_MAX).default([]),
      workers: OrgAgentWorkersConfig.default({ shareInstructions: false }),
      /** Where chats run; omitted keeps today's placement (see {@link OrgAgentRunsOn}). */
      runsOn: OrgAgentRunsOn.optional(),
    })
    .strict()
    .superRefine((config, context) => {
      const seen = new Set<string>();
      config.toolServers.forEach((server, index) => {
        if (seen.has(server.server)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["toolServers", index, "server"],
            message: `Tool server '${server.server}' is listed twice.`,
          });
        }
        seen.add(server.server);
      });
    }),
);
export type OrgAgentVersionConfig = z.infer<typeof OrgAgentVersionConfig>;
export type OrgAgentVersionConfigInput = z.input<typeof OrgAgentVersionConfig>;

/**
 * The whole definition of one agent version, as a YAML file, `PUT .../apply`
 * or inline `agent.config` carries it. The JSON Schema for the YAML format is
 * generated from this (with `key`).
 */
export const OrgAgentDefinition = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: OrgAgentName,
      description: OrgAgentDescription.default(""),
      instructions: OrgAgentInstructions.default(""),
      config: OrgAgentVersionConfig.default({
        toolServers: [],
        workers: { shareInstructions: false },
      }),
    })
    .strict(),
);
export type OrgAgentDefinition = z.infer<typeof OrgAgentDefinition>;
export type OrgAgentDefinitionInput = z.input<typeof OrgAgentDefinition>;

/**
 * One agent file (`agents/<key>.yaml`). `instructions` may name a Markdown file
 * next to it (`instructions: ./support.md`); the CLI reads it before deploying.
 * Settings sit at the top level of the file, beside the name.
 */
export const OrgAgentFile = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      key: OrgAgentKey,
      name: OrgAgentName,
      description: OrgAgentDescription.optional(),
      instructions: z.string().max(ORG_AGENT_INSTRUCTIONS_MAX_LENGTH).optional(),
      model: z.string().min(1).max(200).optional(),
      reasoningEffort: ReasoningEffort.optional(),
      capabilities: AgentCapabilities.optional(),
      identity: AgentIdentity.nullable().optional(),
      renderer: AgentRenderer.optional(),
      titleInstructions: AgentTitleInstructions.nullable().optional(),
      toolServers: z.array(OrgAgentToolServerConfig).max(ORG_AGENT_TOOL_SERVERS_MAX).optional(),
      workers: OrgAgentWorkersConfig.optional(),
      runsOn: OrgAgentRunsOn.optional(),
    })
    .strict(),
);
export type OrgAgentFile = z.infer<typeof OrgAgentFile>;
export type OrgAgentFileInput = z.input<typeof OrgAgentFile>;

/** Splits a parsed agent file into its key and definition (instructions already read). */
export function orgAgentFileToDefinition(file: OrgAgentFile): {
  key: OrgAgentKey;
  definition: OrgAgentDefinition;
} {
  const { key, name, description, instructions, workers, toolServers, ...settings } = file;
  return {
    key,
    definition: OrgAgentDefinition.parse({
      name,
      description: description ?? "",
      instructions: instructions ?? "",
      config: {
        ...settings,
        toolServers: toolServers ?? [],
        workers: workers ?? { shareInstructions: false },
      },
    }),
  };
}

/** The agent file for a definition: the inverse of {@link orgAgentFileToDefinition}. */
export function orgAgentDefinitionToFile(
  key: string,
  definition: OrgAgentDefinition,
): OrgAgentFile {
  const { toolServers, workers, ...settings } = definition.config;
  return {
    key,
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.instructions ? { instructions: definition.instructions } : {}),
    ...settings,
    ...(toolServers.length > 0 ? { toolServers } : {}),
    ...(workers.shareInstructions ? { workers } : {}),
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalJsonValue(entry)]));
  }
  return value;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * The canonical form of a definition: defaults filled, tool lists sorted and
 * de-duplicated, tool servers sorted by key, object keys sorted. Two
 * definitions that behave the same have the same canonical JSON, so the
 * config hash (sha256 of this string) makes deploys idempotent and an
 * exported YAML file round-trips to the same hash.
 */
export function canonicalOrgAgentDefinitionJson(input: OrgAgentDefinitionInput): string {
  const definition = OrgAgentDefinition.parse(input);
  const toolServers = [...definition.config.toolServers]
    .map((server) => ({
      ...server,
      tools: { mode: server.tools.mode, enabled: sortedUnique(server.tools.enabled) },
      approval: {
        ask: server.approval.ask === true ? (true as const) : sortedUnique(server.approval.ask),
      },
      eager: sortedUnique(server.eager),
    }))
    .sort((left, right) => (left.server < right.server ? -1 : left.server > right.server ? 1 : 0));
  return JSON.stringify(
    canonicalJsonValue({ ...definition, config: { ...definition.config, toolServers } }),
  );
}

/** `sha256:` + hex. Computed by the server with {@link canonicalOrgAgentDefinitionJson}. */
export const OrgAgentConfigHash = /* @__PURE__ */ defineSchema(() =>
  z.string().regex(/^sha256:[0-9a-f]{64}$/),
);

export const OrgAgentManagedBy = /* @__PURE__ */ defineSchema(() => z.enum(["console", "code"]));
export type OrgAgentManagedBy = z.infer<typeof OrgAgentManagedBy>;

/** Where a version came from: Console, a code deploy, or a chat's inline `agent.config`. */
export const OrgAgentVersionSource = /* @__PURE__ */ defineSchema(() =>
  z.enum(["console", "deploy", "inline"]),
);
export type OrgAgentVersionSource = z.infer<typeof OrgAgentVersionSource>;

/** A tool the server offered when the version was saved (the baseline for `newTools`). */
export const OrgAgentToolCatalogEntry = /* @__PURE__ */ defineSchema(() =>
  z.object({ name: ToolName, description: z.string().max(4_000).optional() }).strict(),
);
export type OrgAgentToolCatalogEntry = z.infer<typeof OrgAgentToolCatalogEntry>;

export const OrgAgentToolCatalog = /* @__PURE__ */ defineSchema(() =>
  z.record(OrgToolServerKey, z.array(OrgAgentToolCatalogEntry).max(ORG_AGENT_TOOL_NAMES_MAX)),
);
export type OrgAgentToolCatalog = z.infer<typeof OrgAgentToolCatalog>;

export const OrgAgentVersion = /* @__PURE__ */ defineSchema(() =>
  z.object({
    version: z.number().int().positive(),
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    config: OrgAgentVersionConfig,
    /** Tools each server offered when this version was saved; null when not captured. */
    toolCatalog: OrgAgentToolCatalog.nullable(),
    source: OrgAgentVersionSource,
    configHash: OrgAgentConfigHash,
    createdBySubjectId: z.string().nullable(),
    createdAt: z.string(),
    /** When this version was last published; null if never. */
    publishedAt: z.string().nullable(),
  }),
);
export type OrgAgentVersion = z.infer<typeof OrgAgentVersion>;

export const OrgAgentSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    key: OrgAgentKey,
    name: z.string(),
    description: z.string(),
    managedBy: OrgAgentManagedBy,
    /** The published version new chats run; null until the first publish. */
    publishedVersion: z.number().int().positive().nullable(),
    /** The newest version (a draft when greater than `publishedVersion`). */
    latestVersion: z.number().int().positive(),
    /** Row version for `expectedVersion`. */
    rowVersion: z.number().int().positive(),
    archivedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type OrgAgentSummary = z.infer<typeof OrgAgentSummary>;

export const OrgAgent = /* @__PURE__ */ defineSchema(() =>
  OrgAgentSummary.extend({
    published: OrgAgentVersion.nullable(),
    /** The newest version when it is not published yet. */
    draft: OrgAgentVersion.nullable(),
    /**
     * Workspaces the agent is available in besides every workspace the
     * organization manages (those always have it).
     */
    workspaceIds: z.array(z.string().uuid()),
  }),
);
export type OrgAgent = z.infer<typeof OrgAgent>;

export const ListOrgAgentsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ agents: z.array(OrgAgentSummary) }),
);
export type ListOrgAgentsResponse = z.infer<typeof ListOrgAgentsResponse>;
export const OrgAgentResponse = /* @__PURE__ */ defineSchema(() => z.object({ agent: OrgAgent }));
export type OrgAgentResponse = z.infer<typeof OrgAgentResponse>;
export const ListOrgAgentVersionsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ versions: z.array(OrgAgentVersion) }),
);
export type ListOrgAgentVersionsResponse = z.infer<typeof ListOrgAgentVersionsResponse>;
export const OrgAgentVersionResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ version: OrgAgentVersion }),
);

/** `POST /v1/organizations/:organizationId/agents`: a Console agent with an unpublished first version. */
export const CreateOrgAgentRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      key: OrgAgentKey,
      name: OrgAgentName,
      description: OrgAgentDescription.optional(),
      instructions: OrgAgentInstructions.optional(),
      config: OrgAgentVersionConfig.optional(),
      workspaceIds: z.array(z.string().uuid()).max(1_000).optional(),
    })
    .strict(),
);
export type CreateOrgAgentRequest = z.input<typeof CreateOrgAgentRequest>;

/** `PATCH .../agents/:agentId`: directory fields and where the agent is available. */
export const UpdateOrgAgentRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      expectedVersion: z.number().int().positive(),
      workspaceIds: z.array(z.string().uuid()).max(1_000).optional(),
    })
    .strict(),
);
export type UpdateOrgAgentRequest = z.input<typeof UpdateOrgAgentRequest>;

/** `PUT .../agents/:agentId/draft`: saves a new version unless it equals the newest one. */
export const SaveOrgAgentDraftRequest = /* @__PURE__ */ defineSchema(() =>
  OrgAgentDefinition.extend({ expectedVersion: z.number().int().positive() }).strict(),
);
export type SaveOrgAgentDraftRequest = z.input<typeof SaveOrgAgentDraftRequest>;

/**
 * The saved version. `created` is false when the definition equals an
 * existing version (same config hash), which is returned instead.
 */
export const SaveOrgAgentDraftResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ agent: OrgAgent, version: OrgAgentVersion, created: z.boolean() }),
);
export type SaveOrgAgentDraftResponse = z.infer<typeof SaveOrgAgentDraftResponse>;

/** `POST .../agents/:agentId/archive`. */
export const ArchiveOrgAgentRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ expectedVersion: z.number().int().positive() }).strict(),
);
export type ArchiveOrgAgentRequest = z.input<typeof ArchiveOrgAgentRequest>;

/**
 * `POST .../agents/:agentId/publish`. Publishing an older version is a
 * rollback. `moveRunningChats` also moves chats pinned to other versions to
 * this one (their prompt cache starts over); otherwise only new chats get it.
 */
export const PublishOrgAgentRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      version: z.number().int().positive(),
      moveRunningChats: z.boolean().default(false),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
);
export type PublishOrgAgentRequest = z.input<typeof PublishOrgAgentRequest>;

export const OrgAgentPublishOperationStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["pending", "running", "succeeded", "failed"]),
);
export const OrgAgentPublishOperation = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    fromVersion: z.number().int().positive().nullable(),
    toVersion: z.number().int().positive(),
    moveRunningChats: z.boolean(),
    status: OrgAgentPublishOperationStatus,
    movedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    createdBySubjectId: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
    /**
     * Why a `moveRunningChats` operation is `failed` without moving anything:
     * `move_unavailable` (this deployment cannot move chats),
     * `move_start_failed` (the move could not be started; publish again to
     * retry) or `superseded` (a later publish came first). The version is
     * published either way; only running chats stayed where they were.
     */
    failureReason: z.string().nullable().optional(),
  }),
);
export type OrgAgentPublishOperation = z.infer<typeof OrgAgentPublishOperation>;
export const PublishOrgAgentResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ agent: OrgAgent, operation: OrgAgentPublishOperation }),
);
export type PublishOrgAgentResponse = z.infer<typeof PublishOrgAgentResponse>;
export const ListOrgAgentPublishOperationsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ operations: z.array(OrgAgentPublishOperation) }),
);
export type ListOrgAgentPublishOperationsResponse = z.infer<
  typeof ListOrgAgentPublishOperationsResponse
>;

/** Chats that would move if this publish also moved running chats. */
export const OrgAgentMovableChatsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ count: z.number().int().nonnegative() }),
);

/**
 * `PUT .../agents/by-key/:key/apply`: the code deploy. Creates a code-managed
 * agent for an unknown key, saves a version unless the newest one has the
 * same config hash, and publishes it when `publish` is set. `dryRun` reports
 * what would happen without writing.
 */
export const ApplyOrgAgentRequest = /* @__PURE__ */ defineSchema(() =>
  OrgAgentDefinition.extend({
    publish: z.boolean().default(false),
    moveRunningChats: z.boolean().default(false),
    dryRun: z.boolean().default(false),
    expectedVersion: z.number().int().positive().optional(),
  }).strict(),
);
export type ApplyOrgAgentRequest = z.input<typeof ApplyOrgAgentRequest>;

export const ApplyOrgAgentResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** `unchanged`: the newest version already has this config hash. */
    outcome: z.enum(["created", "updated", "unchanged"]),
    dryRun: z.boolean(),
    configHash: OrgAgentConfigHash,
    version: z.number().int().positive().nullable(),
    published: z.boolean(),
    agent: OrgAgent.nullable(),
    operation: OrgAgentPublishOperation.nullable(),
  }),
);
export type ApplyOrgAgentResponse = z.infer<typeof ApplyOrgAgentResponse>;

/** `POST .../agents/:agentId/management`: owner only, audit-logged. */
export const SetOrgAgentManagementRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      managedBy: OrgAgentManagedBy,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
);
export type SetOrgAgentManagementRequest = z.input<typeof SetOrgAgentManagementRequest>;

/** One setting a chat changed: the agent version's value and the chat's. */
export const OrgAgentOverrideChange = /* @__PURE__ */ defineSchema(() =>
  z.object({ agent: z.unknown(), chat: z.unknown() }),
);
/**
 * What a chat changed from its agent version, keyed by setting (`model`,
 * `reasoningEffort`, `instructions`, `capabilities`, `identity`, `renderer`,
 * `titleInstructions`, `toolServers.<key>`, `mcpServers.<id>`, `runsOn`). Null
 * or absent when the chat changed nothing.
 */
export const OrgAgentSessionOverrides = /* @__PURE__ */ defineSchema(() =>
  z.record(z.string(), OrgAgentOverrideChange),
);
export type OrgAgentSessionOverrides = z.infer<typeof OrgAgentSessionOverrides>;

/** The organization agent a chat runs (`Session.orgAgent`). */
export const SessionOrgAgent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    key: OrgAgentKey,
    version: z.number().int().positive(),
    overrides: OrgAgentSessionOverrides.nullable(),
  }),
);
export type SessionOrgAgent = z.infer<typeof SessionOrgAgent>;

export const OrgAgentSessionEntry = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    title: z.string().nullable(),
    status: z.string(),
    agentVersion: z.number().int().positive(),
    overrides: OrgAgentSessionOverrides.nullable(),
    /** The end user the chat belongs to (name, email, the product's id); absent on older servers. */
    endUser: ConsoleEndUser.nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type OrgAgentSessionEntry = z.infer<typeof OrgAgentSessionEntry>;
export const ListOrgAgentSessionsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ sessions: z.array(OrgAgentSessionEntry), nextCursor: z.string().nullable() }),
);
export type ListOrgAgentSessionsResponse = z.infer<typeof ListOrgAgentSessionsResponse>;
export const ListOrgAgentSessionsQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(512).optional(),
    version: z.coerce.number().int().positive().optional(),
  }),
);
export type ListOrgAgentSessionsQuery = z.infer<typeof ListOrgAgentSessionsQuery>;

/** `GET .../usage?from=&to=`: defaults to the last 30 days; at most 366 days. */
export const OrgAgentUsageQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  }),
);
export type OrgAgentUsageQuery = z.infer<typeof OrgAgentUsageQuery>;

export const OrgAgentUsageResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    from: z.string(),
    to: z.string(),
    sessions: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
    byVersion: z.array(
      z.object({
        version: z.number().int().positive(),
        sessions: z.number().int().nonnegative(),
        costMicros: z.number().int().nonnegative(),
      }),
    ),
  }),
);
export type OrgAgentUsageResponse = z.infer<typeof OrgAgentUsageResponse>;

/* ---------------------------------------------------------------- tool servers */

/**
 * Where a tool server's login comes from:
 * - `per_user`: each end user's own login (credential provider, then the
 *   end-user store, then the chat's own headers). Never a shared key.
 * - `shared_key`: one organization key for everyone.
 * - `none`: no login.
 */
export const OrgToolServerAuthMode = /* @__PURE__ */ defineSchema(() =>
  z.enum(["per_user", "shared_key", "none"]),
);
export type OrgToolServerAuthMode = z.infer<typeof OrgToolServerAuthMode>;

const ToolServerUrl = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          return new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "URL must use https" },
    ),
);
const CredentialHeaders = /* @__PURE__ */ defineSchema(() =>
  secretValue(z.record(z.string().min(1).max(256), z.string().max(16_384))),
);

/** OAuth refresh settings for end-user logins on a `per_user` server. */
export const OrgToolServerOAuthRefreshInput = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      tokenUrl: ToolServerUrl,
      clientId: z.string().min(1).max(1_024),
      clientSecret: secretValue(z.string().min(1).max(4_096)).optional(),
    })
    .strict(),
);
export type OrgToolServerOAuthRefreshInput = z.infer<typeof OrgToolServerOAuthRefreshInput>;

export const OrgToolServer = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    key: OrgToolServerKey,
    name: z.string(),
    url: z.string(),
    authMode: OrgToolServerAuthMode,
    /** A shared key is stored (never returned). */
    hasSharedKey: z.boolean(),
    sharedHeaderNames: z.array(z.string()),
    oauthRefresh: z
      .object({ tokenUrl: z.string(), clientId: z.string(), hasClientSecret: z.boolean() })
      .nullable(),
    rowVersion: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type OrgToolServer = z.infer<typeof OrgToolServer>;

export const ListOrgToolServersResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ toolServers: z.array(OrgToolServer) }),
);
export type ListOrgToolServersResponse = z.infer<typeof ListOrgToolServersResponse>;
export const OrgToolServerResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ toolServer: OrgToolServer }),
);

export const CreateOrgToolServerRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      key: OrgToolServerKey,
      name: z.string().trim().min(1).max(120),
      url: ToolServerUrl,
      authMode: OrgToolServerAuthMode,
      sharedHeaders: CredentialHeaders.optional(),
      oauthRefresh: OrgToolServerOAuthRefreshInput.optional(),
    })
    .strict(),
);
export type CreateOrgToolServerRequest = z.input<typeof CreateOrgToolServerRequest>;

export const UpdateOrgToolServerRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      expectedVersion: z.number().int().positive(),
      name: z.string().trim().min(1).max(120).optional(),
      url: ToolServerUrl.optional(),
      authMode: OrgToolServerAuthMode.optional(),
      /** null removes the shared key. */
      sharedHeaders: CredentialHeaders.nullable().optional(),
      oauthRefresh: OrgToolServerOAuthRefreshInput.nullable().optional(),
    })
    .strict(),
);
export type UpdateOrgToolServerRequest = z.input<typeof UpdateOrgToolServerRequest>;

/** `GET .../tool-servers/:key/tools`: the server's live tool list (cached briefly). */
export const OrgToolServerToolsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    tools: z.array(OrgAgentToolCatalogEntry),
    fetchedAt: z.string(),
    /** Set when the list could not be fetched; `tools` is then empty. */
    error: z.string().nullable(),
  }),
);
export type OrgToolServerToolsResponse = z.infer<typeof OrgToolServerToolsResponse>;

/* ------------------------------------------------------- end-user tool logins */

/**
 * `PUT /v1/workspaces/:workspaceId/end-users/:externalUserId/tool-credentials/:toolServerKey`.
 * Stored encrypted; never readable through the API.
 */
export const PutEndUserToolCredentialRequest = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("headers"), headers: CredentialHeaders }).strict(),
    z
      .object({
        kind: z.literal("oauth"),
        accessToken: secretValue(z.string().min(1).max(16_384)),
        refreshToken: secretValue(z.string().min(1).max(16_384)).optional(),
        /** When the access token expires; refreshed five minutes before. */
        expiresAt: z.string().datetime().optional(),
        tokenType: z.string().min(1).max(64).default("Bearer"),
      })
      .strict(),
  ]),
);
export type PutEndUserToolCredentialRequest = z.input<typeof PutEndUserToolCredentialRequest>;

export const EndUserToolCredential = /* @__PURE__ */ defineSchema(() =>
  z.object({
    toolServerKey: OrgToolServerKey,
    kind: z.enum(["headers", "oauth"]),
    expiresAt: z.string().nullable(),
    refreshFailedAt: z.string().nullable(),
    updatedAt: z.string(),
    lastUsedAt: z.string().nullable(),
  }),
);
export type EndUserToolCredential = z.infer<typeof EndUserToolCredential>;
export const EndUserToolCredentialResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ credential: EndUserToolCredential }),
);

/* ------------------------------------------------- workspace and Console test */

/**
 * `GET /v1/workspaces/:workspaceId/organization-agents`: the published
 * organization agents chats in this workspace can name (read-only).
 */
export const WorkspaceOrgAgent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    key: OrgAgentKey,
    name: z.string(),
    description: z.string(),
    managedBy: OrgAgentManagedBy,
    publishedVersion: z.number().int().positive(),
  }),
);
export type WorkspaceOrgAgent = z.infer<typeof WorkspaceOrgAgent>;
export const ListWorkspaceOrgAgentsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ agents: z.array(WorkspaceOrgAgent) }),
);
export type ListWorkspaceOrgAgentsResponse = z.infer<typeof ListWorkspaceOrgAgentsResponse>;

/** `POST .../agents/test-workspace`: the organization's Console test workspace. */
export const OrgAgentTestWorkspaceResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ workspaceId: z.string().uuid(), created: z.boolean() }),
);
export type OrgAgentTestWorkspaceResponse = z.infer<typeof OrgAgentTestWorkspaceResponse>;

/**
 * `POST .../agents/:agentId/test-chats`: a chat with one version (drafts
 * included) in the Console test workspace. `toolLogins` are bearer tokens for
 * this chat only, by tool server key; never stored beyond the chat.
 */
export const CreateOrgAgentTestChatRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      version: z.number().int().positive(),
      message: z.string().trim().min(1).max(100_000),
      toolLogins: secretValue(z.record(OrgToolServerKey, z.string().min(1).max(16_384))).optional(),
      /**
       * One start of a test chat: the same key again (a double click, a
       * retry) returns the chat it started instead of a second one.
       */
      idempotencyKey: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
);
export type CreateOrgAgentTestChatRequest = z.input<typeof CreateOrgAgentTestChatRequest>;
export const CreateOrgAgentTestChatResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ workspaceId: z.string().uuid(), sessionId: z.string().uuid() }),
);
export type CreateOrgAgentTestChatResponse = z.infer<typeof CreateOrgAgentTestChatResponse>;

/**
 * The subject prefix of a tester's Console test chat principal
 * (`console-test:<tester>`). Reserved for the server: no caller can name a
 * service initiator with it.
 */
export const CONSOLE_TEST_CHAT_SUBJECT_PREFIX = "console-test:";

/** Whether a subject is a Console test chat principal. */
export function isConsoleTestChatSubject(subjectId: string | null | undefined): boolean {
  return typeof subjectId === "string" && subjectId.startsWith(CONSOLE_TEST_CHAT_SUBJECT_PREFIX);
}

/**
 * `GET .../agents/:agentId/test-chats/:sessionId`: one of the caller's own
 * test chats. Test chats belong to the person (or key) who started them; no
 * one is a member of the test workspace, so these routes are the only way in.
 */
export const OrgAgentTestChatResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    workspaceId: z.string().uuid(),
    sessionId: z.string().uuid(),
    agentId: z.string().uuid(),
    version: z.number().int().positive().nullable(),
    status: SessionStatus,
    /** Stopped (`POST .../control` with `pause`) until resumed. */
    paused: z.boolean(),
  }),
);
export type OrgAgentTestChatResponse = z.infer<typeof OrgAgentTestChatResponse>;

/** `GET .../test-chats/:sessionId/events`: the chat's events after `after`, oldest first. */
export const OrgAgentTestChatEventsQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    after: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(1_000).optional(),
  }),
);
export type OrgAgentTestChatEventsQuery = z.infer<typeof OrgAgentTestChatEventsQuery>;

/** `POST .../test-chats/:sessionId/messages`: the next message in the caller's test chat. */
export const SendOrgAgentTestChatMessageRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ message: z.string().trim().min(1).max(100_000) }).strict(),
);
export type SendOrgAgentTestChatMessageRequest = z.input<typeof SendOrgAgentTestChatMessageRequest>;

/**
 * `POST .../test-chats/:sessionId/approvals/:approvalId`: approve or decline
 * one "Ask first" tool call waiting in the caller's test chat. `content` and
 * `elicitationRound` answer the tool server's questions, as in the app.
 */
export const DecideOrgAgentTestChatApprovalRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      decision: z.enum(["approve", "reject"]),
      message: z.string().max(100_000).optional(),
      content: McpElicitationContent.optional(),
      elicitationRound: z.number().int().positive().optional(),
      clientEventId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
);
export type DecideOrgAgentTestChatApprovalRequest = z.input<
  typeof DecideOrgAgentTestChatApprovalRequest
>;

/**
 * `POST .../test-chats/:sessionId/control`: stop the caller's test chat
 * (`pause`, which interrupts what runs) or let it go on (`resume`).
 */
export const ControlOrgAgentTestChatRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      action: z.enum(["pause", "resume"]),
      clientEventId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
);
export type ControlOrgAgentTestChatRequest = z.input<typeof ControlOrgAgentTestChatRequest>;
export const ControlOrgAgentTestChatResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ paused: z.boolean() }),
);
export type ControlOrgAgentTestChatResponse = z.infer<typeof ControlOrgAgentTestChatResponse>;

/* --------------------------------------------------------- session create input */

/** An organization agent's key, or its id (a UUID). */
export const OrgAgentRef = /* @__PURE__ */ defineSchema(() => z.string().min(1).max(64));
export type OrgAgentRef = z.infer<typeof OrgAgentRef>;

export function orgAgentRefIsId(ref: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
}

/**
 * A chat's change to one of its agent's tool servers, merged by `server`:
 * `enabled: false` drops the server for this chat, `tools` replaces the
 * selection, `disableTools` turns tools off, `approval` replaces "Ask first".
 */
export const OrgAgentToolServerOverride = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      server: OrgToolServerKey,
      enabled: z.boolean().optional(),
      tools: OrgAgentToolSelection.optional(),
      disableTools: ToolNames.optional(),
      approval: OrgAgentToolApproval.optional(),
      eager: ToolNames.optional(),
      /**
       * This chat's own login for the server (write-only, encrypted, never
       * returned): the last login source for a `per_user` server, after the
       * credential provider and the end user's stored login. Not an override.
       */
      headers: secretValue(z.record(z.string().min(1).max(256), z.string().max(16_384))).optional(),
    })
    .strict(),
);
export type OrgAgentToolServerOverride = z.infer<typeof OrgAgentToolServerOverride>;

/**
 * `agent: { ref, ... }` on session create: run an organization agent. The
 * other fields change settings for this chat only (request wins); `instructions`
 * are added after the agent's. `config` is an inline code-agent definition:
 * it becomes a version (by config hash) of a code-managed agent.
 */
export const OrgAgentSessionRequest = /* @__PURE__ */ defineSchema(() =>
  AgentConfigRequest.extend({
    ref: OrgAgentRef,
    /**
     * Run this version instead of the published one. Unpublished versions
     * (drafts) run only in the organization's Console test workspace.
     */
    version: z.number().int().positive().optional(),
    config: OrgAgentDefinition.optional(),
    toolServers: z.array(OrgAgentToolServerOverride).max(ORG_AGENT_TOOL_SERVERS_MAX).optional(),
  }).strict(),
);
export type OrgAgentSessionRequest = z.infer<typeof OrgAgentSessionRequest>;
export type OrgAgentSessionRequestInput = z.input<typeof OrgAgentSessionRequest>;

/**
 * The public `agent` field of session create: today's agent configuration
 * object (unchanged), an organization agent's key or id, or an
 * {@link OrgAgentSessionRequest}.
 */
export const CreateSessionAgentField = /* @__PURE__ */ defineSchema(() =>
  z.union([AgentConfigRequest, OrgAgentRef, OrgAgentSessionRequest]),
);
export type CreateSessionAgentField = z.infer<typeof CreateSessionAgentField>;
export type CreateSessionAgentFieldInput = z.input<typeof CreateSessionAgentField>;

/** Whether a create names an organization agent (a string or an object with `ref`). */
export function sessionAgentFieldNamesOrgAgent(agent: unknown): boolean {
  return (
    typeof agent === "string" ||
    (agent !== null &&
      typeof agent === "object" &&
      !Array.isArray(agent) &&
      Object.hasOwn(agent, "ref"))
  );
}

/** `allow` (default): the request may change the agent's settings. `reject`: 422 if it does. */
export const OrgAgentOverridesMode = /* @__PURE__ */ defineSchema(() =>
  z.enum(["allow", "reject"]),
);
export type OrgAgentOverridesMode = z.infer<typeof OrgAgentOverridesMode>;

/** Why a chat recorded `session.tool_server.unavailable` for a tool server. */
export const OrgToolServerUnavailableReason = /* @__PURE__ */ defineSchema(() =>
  z.enum(["missing_credentials", "credentials_expired"]),
);
export type OrgToolServerUnavailableReason = z.infer<typeof OrgToolServerUnavailableReason>;

/**
 * An organization machine or sandbox environment an agent can run on
 * (`GET /v1/organizations/:organizationId/agents/compute`). Machines carry
 * their sandbox id. `worksInManagedWorkspaces`: its reach includes every
 * workspace the organization's product manages (every shared workspace, or
 * "All product-managed workspaces"), which an agent's chats need.
 */
export const OrgAgentComputeOption = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    sandboxId: z.string().uuid().nullable().optional(),
    name: z.string(),
    worksInManagedWorkspaces: z.boolean(),
  }),
);
export type OrgAgentComputeOption = z.infer<typeof OrgAgentComputeOption>;

export const ListOrgAgentComputeResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    machines: z.array(OrgAgentComputeOption),
    environments: z.array(OrgAgentComputeOption),
  }),
);
export type ListOrgAgentComputeResponse = z.infer<typeof ListOrgAgentComputeResponse>;

/* ----------------------------------------------------- agent file JSON Schema */

/**
 * Where editors fetch the agent file JSON Schema. It ships in the `opengeni`
 * npm package (`schemas/agent.schema.json`); use it in a YAML file with
 * `# yaml-language-server: $schema=<this URL>`.
 */
export const ORG_AGENT_FILE_JSON_SCHEMA_URL =
  "https://cdn.jsdelivr.net/npm/opengeni/schemas/agent.schema.json" as const;

/**
 * The JSON Schema of an agent file (`agents/<key>.yaml`), generated from
 * {@link OrgAgentFile} (input side: defaults are optional). The committed copy
 * is regenerated by `scripts/generate-agent-file-schema.ts`.
 */
export function orgAgentFileJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(OrgAgentFile, { io: "input" }) as Record<
    string,
    unknown
  >;
  return {
    $schema,
    $id: ORG_AGENT_FILE_JSON_SCHEMA_URL,
    title: "Opengeni agent",
    description:
      "One Opengeni organization agent (agents/<key>.yaml). Deploy with `npx opengeni agents deploy <dir>`.",
    ...schema,
  };
}
