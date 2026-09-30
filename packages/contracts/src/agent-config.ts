/**
 * Agent configuration: one `agent` object that describes what an OpenGeni
 * agent is (identity), how it answers (renderer, instructions alias) and what
 * it can do (capabilities). Capabilities are product words; this module owns
 * the single registry that maps every first-party tool to exactly one of them
 * and the pure resolution shared by every session creator (API, MCP child,
 * Slack, scheduled tasks, automations) and the mid-session update.
 *
 * Invariants:
 * - `"all"` reproduces the creator's legacy tool values exactly: capability
 *   filtering only removes tools of capabilities that are OFF, and every
 *   capability is ON under `"all"` (deployment-disabled capabilities are
 *   reported but never rewrite the stored selection; the runtime enforces them).
 * - A session with no configuration (`null`) keeps byte-identical legacy
 *   behavior; nothing here runs for it.
 * - Children and agent callers may only narrow.
 *
 * This module must not import runtime values from `./index` (the index
 * re-exports it); only types cross that edge.
 */
import { z } from "zod";
import type { FirstPartyMcpToolName, SessionToolPolicy, ToolRef } from "./index";

export const AGENT_CAPABILITY_IDS = [
  "webSearch",
  "humanInput",
  "skills",
  "goals",
  "subagents",
  "knowledge",
  "schedules",
  "artifacts",
  "browser",
  "media",
  "workspaceFiles",
  "workspaceConnectors",
  "workspaceAdmin",
] as const;
export const AgentCapabilityId = z.enum(AGENT_CAPABILITY_IDS);
export type AgentCapabilityId = z.infer<typeof AgentCapabilityId>;

/** Boolean capabilities: every capability except the three-state `skills`. */
export type AgentBooleanCapabilityId = Exclude<AgentCapabilityId, "skills">;
export const AGENT_BOOLEAN_CAPABILITY_IDS = AGENT_CAPABILITY_IDS.filter(
  (id): id is AgentBooleanCapabilityId => id !== "skills",
);

/** `read` reads installed Skills; `manage` also saves/installs/publishes/removes. */
export const AgentSkillsCapability = z.union([
  z.literal("read"),
  z.literal("manage"),
  z.literal(false),
]);
export type AgentSkillsCapability = z.infer<typeof AgentSkillsCapability>;

export const AgentCapabilityStartingPoint = z.enum(["all", "none"]);
export type AgentCapabilityStartingPoint = z.infer<typeof AgentCapabilityStartingPoint>;

export const AgentCapabilityToggles = z
  .object({
    webSearch: z.boolean().optional(),
    humanInput: z.boolean().optional(),
    skills: AgentSkillsCapability.optional(),
    goals: z.boolean().optional(),
    subagents: z.boolean().optional(),
    knowledge: z.boolean().optional(),
    schedules: z.boolean().optional(),
    artifacts: z.boolean().optional(),
    browser: z.boolean().optional(),
    media: z.boolean().optional(),
    workspaceFiles: z.boolean().optional(),
    workspaceConnectors: z.boolean().optional(),
    workspaceAdmin: z.boolean().optional(),
  })
  .strict();
export type AgentCapabilityToggles = z.infer<typeof AgentCapabilityToggles>;

/**
 * `"all"`: everything this workspace offers (today's behavior). `"none"`: the
 * session's own tools plus essentials (human input and reading Skills). An
 * object starts from one of them and switches individual capabilities.
 */
export const AgentCapabilities = z.union([
  z.literal("all"),
  z.literal("none"),
  AgentCapabilityToggles.extend({ from: AgentCapabilityStartingPoint }).strict(),
]);
export type AgentCapabilities = z.infer<typeof AgentCapabilities>;

/** `opengeni` emits `sandbox:`/`artifact:` links and inline visuals; `markdown` does not. */
export const AgentRenderer = z.enum(["opengeni", "markdown"]);
export type AgentRenderer = z.infer<typeof AgentRenderer>;

export const AGENT_IDENTITY_MAX_CHARACTERS = 8_000;
/** Same bound as `SESSION_INSTRUCTIONS_MAX_CHARACTERS` (asserted by test). */
export const AGENT_INSTRUCTIONS_MAX_CHARACTERS = 65_536;

export const AgentIdentity = z.string().trim().min(1).max(AGENT_IDENTITY_MAX_CHARACTERS);

/** The request-side agent object. Every field is optional. */
export const AgentConfigRequest = z
  .object({
    capabilities: AgentCapabilities.optional(),
    /** Replaces only OpenGeni's identity lines; null selects the default identity. */
    identity: AgentIdentity.nullable().optional(),
    /** Alias of the session `instructions` field (same column, same bound). */
    instructions: z.string().trim().min(1).max(AGENT_INSTRUCTIONS_MAX_CHARACTERS).optional(),
    renderer: AgentRenderer.optional(),
  })
  .strict();
export type AgentConfigRequest = z.infer<typeof AgentConfigRequest>;

/** Workspace "Defaults for new sessions" agent part (no instructions alias). */
export const WorkspaceAgentDefaults = z
  .object({
    capabilities: AgentCapabilities.optional(),
    identity: AgentIdentity.nullable().optional(),
    renderer: AgentRenderer.optional(),
  })
  .strict();
export type WorkspaceAgentDefaults = z.infer<typeof WorkspaceAgentDefaults>;

export const ResolvedAgentCapabilities = z
  .object({
    webSearch: z.boolean(),
    humanInput: z.boolean(),
    skills: AgentSkillsCapability,
    goals: z.boolean(),
    subagents: z.boolean(),
    knowledge: z.boolean(),
    schedules: z.boolean(),
    artifacts: z.boolean(),
    browser: z.boolean(),
    media: z.boolean(),
    workspaceFiles: z.boolean(),
    workspaceConnectors: z.boolean(),
    workspaceAdmin: z.boolean(),
  })
  .strict();
export type ResolvedAgentCapabilities = z.infer<typeof ResolvedAgentCapabilities>;

export const ResolvedAgentConfigSource = z.enum([
  "request",
  "workspace_default",
  "deployment_default",
  "inherited",
  "legacy_conversion",
]);
export type ResolvedAgentConfigSource = z.infer<typeof ResolvedAgentConfigSource>;

/**
 * The frozen per-session configuration (`sessions.agent_config`). `capabilities`
 * is the effective map; `unavailable` names capabilities the configuration
 * wanted on but this deployment does not offer (reported off, never widened
 * later without a new resolution).
 */
export const ResolvedAgentConfig = z
  .object({
    version: z.literal(1),
    from: AgentCapabilityStartingPoint,
    capabilities: ResolvedAgentCapabilities,
    unavailable: z.array(AgentCapabilityId).max(AGENT_CAPABILITY_IDS.length).default([]),
    identity: AgentIdentity.nullable(),
    renderer: AgentRenderer,
    source: ResolvedAgentConfigSource,
  })
  .strict();
export type ResolvedAgentConfig = z.infer<typeof ResolvedAgentConfig>;

/** `PUT /v1/workspaces/:workspaceId/sessions/:sessionId/agent`. Omitted fields keep current values. */
export const UpdateSessionAgentRequest = z
  .object({
    agent: AgentConfigRequest,
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type UpdateSessionAgentRequest = z.infer<typeof UpdateSessionAgentRequest>;

/** Client-safe rollout projection. */
export const ClientAgentConfig = z
  .object({
    enabled: z.boolean(),
    defaultForNewSessions: z.boolean(),
    capabilities: z.array(
      z
        .object({
          id: AgentCapabilityId,
          available: z.boolean(),
          reason: z.string().max(200).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type ClientAgentConfig = z.infer<typeof ClientAgentConfig>;

// ---------------------------------------------------------------------------
// Capability registry
// ---------------------------------------------------------------------------

/** A first-party tool's owner: a capability, or pure runtime mechanics. */
export type AgentToolCapability = AgentCapabilityId | "runtime";

/**
 * Exhaustive map from every `FIRST_PARTY_MCP_TOOL_NAMES` entry to exactly one
 * owner. The `Record` type makes an unmapped new name a compile error, and
 * `agent-config-registry.test.ts` asserts it at runtime too.
 *
 * `runtime` tools are mechanics every agent needs regardless of what it may do:
 * - `wait_for_input`: ends the turn and waits for the next input.
 * - `command_read` / `command_wait`: read/await the session's own background
 *   sandbox commands (the shell already exists whenever a sandbox is attached).
 * - `set_session_title`: session titling.
 */
export const FIRST_PARTY_MCP_TOOL_CAPABILITIES = {
  set_session_title: "runtime",
  wait_for_input: "runtime",
  command_wait: "runtime",
  command_read: "runtime",

  goal_set: "goals",
  goal_update: "goals",
  goal_progress: "goals",
  goal_complete: "goals",
  goal_pause: "goals",
  goal_resume: "goals",

  knowledge_search: "knowledge",
  knowledge_prepare_save: "knowledge",
  knowledge_get: "knowledge",
  knowledge_browse: "knowledge",
  knowledge_save: "knowledge",
  knowledge_retain_file: "knowledge",
  knowledge_retain_message: "knowledge",
  knowledge_archive: "knowledge",
  instruction_policy_save: "knowledge",
  instruction_policy_get: "knowledge",
  memory_search: "knowledge",
  memory_save: "knowledge",
  memory_correct: "knowledge",
  preference_registry_summary: "knowledge",
  preference_registry_get: "knowledge",
  task_notes_list: "knowledge",
  task_note_save: "knowledge",
  task_note_archive: "knowledge",
  task_note_replace: "knowledge",
  work_claim_upsert: "knowledge",
  work_claim_release: "knowledge",
  knowledge_propose: "knowledge",
  knowledge_correct: "knowledge",
  task_note_promote_knowledge: "knowledge",
  task_note_promote_instruction_policy: "knowledge",
  task_note_promote_preference: "knowledge",
  instruction_policy_propose: "knowledge",
  preference_propose: "knowledge",
  remember: "knowledge",
  remember_confirm: "knowledge",
  company_profile_propose: "knowledge",
  company_profile_confirm: "knowledge",

  sandboxes_list: "workspaceAdmin",
  sandbox_attach: "workspaceAdmin",
  sandbox_swap: "workspaceAdmin",
  run_on: "workspaceAdmin",
  sandbox_provision: "workspaceAdmin",
  connected_machine_remove: "workspaceAdmin",
  connected_machine_enroll_token: "workspaceAdmin",
  project_list: "workspaceAdmin",
  project_get: "workspaceAdmin",
  project_create: "workspaceAdmin",
  project_update: "workspaceAdmin",
  project_reorder: "workspaceAdmin",
  project_delete: "workspaceAdmin",
  session_set_project: "workspaceAdmin",
  rig_list: "workspaceAdmin",
  rig_get: "workspaceAdmin",
  rig_propose_change: "workspaceAdmin",
  rig_verify: "workspaceAdmin",
  rig_promote: "workspaceAdmin",
  variable_set_list: "workspaceAdmin",
  environment_list: "workspaceAdmin",
  variable_set_get_variable: "workspaceAdmin",
  variable_set_set_variable: "workspaceAdmin",
  environment_set_variable: "workspaceAdmin",
  capability_catalog_search: "workspaceAdmin",
  capability_authorization_request: "workspaceAdmin",
  custom_mcp_setup_request: "workspaceAdmin",

  sessions_list: "subagents",
  session_get: "subagents",
  session_events: "subagents",
  session_wait: "subagents",
  session_create: "subagents",
  session_send_message: "subagents",
  session_pause: "subagents",
  session_resume: "subagents",
  session_steer: "subagents",
  session_human_input_respond: "subagents",
  set_other_session_title: "subagents",

  interaction_discover: "browser",
  browser_open: "browser",
  browser_tabs: "browser",
  browser_observe: "browser",
  browser_read: "browser",
  browser_screenshot: "browser",
  browser_act: "browser",
  browser_clipboard: "browser",
  browser_debug: "browser",
  browser_auth: "browser",
  interaction_request_human: "browser",
  browser_identity: "browser",
  browser_publish: "browser",
  browser_lifecycle: "browser",
  computer_open: "browser",
  computer_targets: "browser",
  computer_observe: "browser",
  computer_clipboard: "browser",
  computer_act: "browser",
  computer_lifecycle: "browser",

  github_connect_link: "workspaceConnectors",
  github_repositories_list: "workspaceConnectors",
  social_connections_list: "workspaceConnectors",
  social_posts_recent: "workspaceConnectors",
  social_daily_analysis_context: "workspaceConnectors",
  social_search_live: "workspaceConnectors",
  social_mentions_live: "workspaceConnectors",
  social_thread_fetch: "workspaceConnectors",
  social_posts_sync: "workspaceConnectors",
  social_post_reply: "workspaceConnectors",
  x_accounts_list: "workspaceConnectors",
  x_search_live: "workspaceConnectors",
  x_mentions_live: "workspaceConnectors",
  x_thread_fetch: "workspaceConnectors",
  x_posts_sync: "workspaceConnectors",
  x_post_reply: "workspaceConnectors",
  reddit_accounts_list: "workspaceConnectors",
  reddit_search_live: "workspaceConnectors",
  reddit_mentions_live: "workspaceConnectors",
  reddit_thread_fetch: "workspaceConnectors",
  reddit_posts_sync: "workspaceConnectors",
  reddit_post_reply: "workspaceConnectors",
  slack_bot_list_channels: "workspaceConnectors",
  slack_bot_search: "workspaceConnectors",
  slack_bot_channel_history: "workspaceConnectors",
  slack_bot_thread_replies: "workspaceConnectors",
  slack_bot_list_users: "workspaceConnectors",
  slack_bot_list_files: "workspaceConnectors",
  slack_bot_file_info: "workspaceConnectors",
  slack_bot_file_content: "workspaceConnectors",
  slack_bot_upload_file: "workspaceConnectors",
  slack_bot_post_message: "workspaceConnectors",
  slack_bot_delete_message: "workspaceConnectors",
  slack_bot_prepare_message: "workspaceConnectors",
  slack_bot_send_prepared_message: "workspaceConnectors",
  fiken_companies_list: "workspaceConnectors",
  fiken_contacts_list: "workspaceConnectors",
  fiken_contact_create: "workspaceConnectors",
  fiken_products_list: "workspaceConnectors",
  fiken_invoices_list: "workspaceConnectors",
  fiken_invoice_get: "workspaceConnectors",
  fiken_invoice_draft_create: "workspaceConnectors",
  fiken_bank_accounts_list: "workspaceConnectors",
  fiken_purchases_list: "workspaceConnectors",
  fiken_sales_list: "workspaceConnectors",
  atlassian_sources_list: "workspaceConnectors",
  atlassian_search: "workspaceConnectors",
  atlassian_get: "workspaceConnectors",

  scheduled_tasks_list: "schedules",
  scheduled_tasks_get: "schedules",
  scheduled_tasks_create: "schedules",
  scheduled_tasks_update: "schedules",
  scheduled_tasks_pause: "schedules",
  scheduled_tasks_resume: "schedules",
  scheduled_tasks_trigger: "schedules",
  scheduled_tasks_delete: "schedules",
  scheduled_task_runs_list: "schedules",

  artifacts_list: "artifacts",
  artifacts_get_source: "artifacts",
  artifacts_prepare_upload: "artifacts",
  artifacts_create: "artifacts",
  artifacts_publish: "artifacts",
  artifacts_rollback: "artifacts",
  artifacts_archive: "artifacts",
  artifacts_restore: "artifacts",
  sandbox_file_publish: "artifacts",
  editable_artifact_list: "artifacts",
  editable_artifact_create: "artifacts",
  editable_artifact_import: "artifacts",
  editable_artifact_get: "artifacts",
  editable_artifact_inspect: "artifacts",
  editable_artifact_apply: "artifacts",
  editable_artifact_export: "artifacts",
  editable_artifact_export_status: "artifacts",
} as const satisfies Record<FirstPartyMcpToolName, AgentToolCapability>;

/** Owner of a non-MCP tool: a capability, runtime mechanics, or the sandbox. */
export type AgentFunctionToolClass = AgentCapabilityId | "runtime" | "sandbox";

/** Tools served outside the first-party MCP catalog, by the name the model sees. */
export const AGENT_FUNCTION_TOOL_CAPABILITIES = {
  // Hosted provider tools.
  web_search: "webSearch",
  x_search: "webSearch",
  image_generation: "media",
  // Runtime function tools.
  request_human_input: "humanInput",
  list_models: "subagents",
  generate_image: "media",
  generate_video: "media",
  get_video_generation_capabilities: "media",
  skill_read: "skills",
  skill_search: "skills",
  skill_checkout: "skills",
  skill_save: "skills",
  skill_install: "skills",
  skill_publish: "skills",
  skill_remove: "skills",
  // Derived from an attached sandbox, never toggled.
  exec_command: "sandbox",
  write_stdin: "sandbox",
  apply_patch: "sandbox",
  view_image: "sandbox",
  repository_skill_read: "sandbox",
  code_search: "sandbox",
  // Derived runtime mechanics: search router, operation recovery, credential
  // renewal, and a scheduled task's own bound knowledge source.
  tool_search: "runtime",
  tool_list: "runtime",
  tool_invoke: "runtime",
  operation_read: "runtime",
  refresh_credentials: "runtime",
  knowledge_source_fetch: "runtime",
  knowledge_source_read: "runtime",
} as const satisfies Record<string, AgentFunctionToolClass>;
export type AgentFunctionToolName = keyof typeof AGENT_FUNCTION_TOOL_CAPABILITIES;

/**
 * Value-free snapshot of the adapters actually selected for one runtime build.
 * Undefined means attachment has not been resolved, not that media is absent.
 * Subscription pool readiness is not evidence for either adapter.
 */
export type AgentMediaAttachment = {
  image: "native_hosted" | "provider_adapter" | null;
  video: boolean;
};

export function resolveAgentMediaToolSurface(
  config: ResolvedAgentConfig | null | undefined,
  attachment?: AgentMediaAttachment,
): { toolsKnown: boolean; hosted: AgentFunctionToolName[]; runtime: AgentFunctionToolName[] } {
  if (!resolveAgentToolFamilies(config).media) {
    return { toolsKnown: true, hosted: [], runtime: [] };
  }
  if (!attachment) return { toolsKnown: false, hosted: [], runtime: [] };
  return {
    toolsKnown: true,
    hosted: attachment.image === "native_hosted" ? ["image_generation"] : [],
    runtime: [
      ...(attachment.image === "provider_adapter" ? ["generate_image" as const] : []),
      ...(attachment.video
        ? ["get_video_generation_capabilities" as const, "generate_video" as const]
        : []),
    ],
  };
}

/** Skill tools that only read installed Skills (`skills: "read"`). */
export const AGENT_SKILL_READ_TOOL_NAMES = ["skill_read"] as const;
/** Skill tools that change Skills (`skills: "manage"` only). */
export const AGENT_SKILL_MANAGE_TOOL_NAMES = [
  "skill_search",
  "skill_checkout",
  "skill_save",
  "skill_install",
  "skill_publish",
  "skill_remove",
] as const;

/** Built-in MCP servers that belong to a capability rather than the product. */
export const AGENT_BUILTIN_MCP_SERVER_CAPABILITIES = {
  opengeni: "runtime",
  files: "workspaceFiles",
  docs: "knowledge",
  "google-drive-publishing": "workspaceConnectors",
} as const satisfies Record<string, AgentToolCapability>;

export function firstPartyMcpToolCapability(tool: FirstPartyMcpToolName): AgentToolCapability {
  return FIRST_PARTY_MCP_TOOL_CAPABILITIES[tool];
}

/** Availability narrows configuration; it never grants a disabled capability. */
export type AgentToolEnvironment = {
  /** Explicit product MCPs are independent of ambient workspace connectors. */
  productServerIds?: ReadonlySet<string>;
  unavailable?: readonly AgentCapabilityId[];
  hasSkills?: boolean;
  webSearch?: boolean;
  humanInput?: boolean;
  media?: boolean | undefined;
  hasDeferredTools?: boolean;
  routerInHistory?: boolean;
};

export const AGENT_RUNTIME_MECHANIC_TOOL_NAMES = [
  "wait_for_input",
  "command_read",
  "command_wait",
] as const satisfies readonly FirstPartyMcpToolName[];

/**
 * The one turn-time capability gate. Null means the historical attachment
 * rules, including unconditional Skill tools and router. Resource-derived
 * sandbox tools, product MCPs and runtime mechanics are never toggled.
 */
export function resolveAgentToolFamilies(
  config: ResolvedAgentConfig | null | undefined,
  environment: AgentToolEnvironment = {},
) {
  const enabled = (id: AgentCapabilityId): boolean =>
    !config ||
    (agentCapabilityEnabled(config.capabilities, id) &&
      !config.unavailable.includes(id) &&
      !environment.unavailable?.includes(id));
  const webSearch = enabled("webSearch") && environment.webSearch !== false;
  const humanInput = enabled("humanInput") && environment.humanInput !== false;
  const media = enabled("media") && environment.media !== false;
  const skills = !config ? "manage" : enabled("skills") ? config.capabilities.skills : false;
  const allowsFirstPartyTool = (name: FirstPartyMcpToolName): boolean => {
    const owner = FIRST_PARTY_MCP_TOOL_CAPABILITIES[name];
    return owner === "runtime" || enabled(owner);
  };
  return {
    webSearch,
    humanInput,
    media,
    subagents: enabled("subagents"),
    skills,
    router:
      !config || environment.hasDeferredTools === true || environment.routerInHistory === true,
    allowsFirstPartyTool,
    firstPartyTools(names: readonly FirstPartyMcpToolName[]): FirstPartyMcpToolName[] {
      return !config
        ? [...names]
        : [
            ...new Set([
              ...names.filter(allowsFirstPartyTool),
              ...AGENT_RUNTIME_MECHANIC_TOOL_NAMES,
            ]),
          ];
    },
    allowsFunctionTool(name: string): boolean {
      if (!config) return true;
      const owner = (AGENT_FUNCTION_TOOL_CAPABILITIES as Record<string, AgentFunctionToolClass>)[
        name
      ];
      if (!owner || owner === "sandbox" || owner === "runtime") return true;
      if (owner === "webSearch") return webSearch;
      if (owner === "humanInput") return humanInput;
      if (owner === "media") return media;
      if (owner === "skills") {
        return (
          skills === "manage" ||
          (skills === "read" && name === "skill_read" && environment.hasSkills === true)
        );
      }
      return enabled(owner);
    },
    allowsMcpServer(id: string): boolean {
      if (!config) return true;
      const owner = (AGENT_BUILTIN_MCP_SERVER_CAPABILITIES as Record<string, AgentToolCapability>)[
        id
      ];
      return owner
        ? owner === "runtime" || enabled(owner)
        : environment.productServerIds?.has(id) === true || enabled("workspaceConnectors");
    },
  };
}

export function firstPartyMcpToolsForCapability(
  capability: AgentCapabilityId,
): FirstPartyMcpToolName[] {
  return (Object.keys(FIRST_PARTY_MCP_TOOL_CAPABILITIES) as FirstPartyMcpToolName[]).filter(
    (tool) => FIRST_PARTY_MCP_TOOL_CAPABILITIES[tool] === capability,
  );
}

/** Product words for UI and docs. Meaning is fixed by the ids. */
export const AGENT_CAPABILITY_DESCRIPTIONS: Readonly<
  Record<AgentCapabilityId, { label: string; description: string }>
> = {
  webSearch: { label: "Web search", description: "Search the public web for current information." },
  humanInput: {
    label: "Ask questions",
    description: "Pause and ask the person for a decision or missing detail.",
  },
  skills: {
    label: "Skills",
    description: "Read installed Skills; with manage, also save, install, and publish them.",
  },
  goals: { label: "Goals", description: "Work toward a goal across many turns until it is done." },
  subagents: {
    label: "Subagents",
    description: "Start, message, and follow other sessions; see available models.",
  },
  knowledge: {
    label: "Knowledge",
    description: "Search and save workspace knowledge, task notes, and instructions.",
  },
  schedules: { label: "Schedules", description: "Create and manage scheduled tasks." },
  artifacts: {
    label: "Artifacts and Sites",
    description: "Publish files, documents, and Sites people can open.",
  },
  browser: { label: "Browser and computer", description: "Use a browser or desktop computer." },
  media: { label: "Images and video", description: "Generate images and videos." },
  workspaceFiles: {
    label: "Workspace files",
    description: "Read files uploaded to the workspace.",
  },
  workspaceConnectors: {
    label: "Workspace connectors",
    description: "Use the workspace's connected apps and integrations.",
  },
  workspaceAdmin: {
    label: "Workspace admin",
    description: "Manage variable sets, projects, rigs, machines, and connector setup.",
  },
};

// ---------------------------------------------------------------------------
// Prompt modules
// ---------------------------------------------------------------------------

/**
 * Sections of the modular operational contract (sessions with an agent
 * configuration). The order is the composition order. `base_behavior` and
 * `runtime_mechanics` are always present; every other module is included only
 * when its capability or resource is present. The model-context inspector
 * reports them as metadata on the `operational_contract` layer.
 */
export const AGENT_PROMPT_MODULE_IDS = [
  "base_behavior",
  "runtime_mechanics",
  "renderer_markdown",
  "sandbox",
  "connected_machine",
  "repositories",
  "workspace_environment",
  "rig",
  "artifacts",
  "goals",
  "subagents",
  "knowledge",
  "skills",
  "admin",
  "attachments",
] as const;
export const AgentPromptModuleId = z.enum(AGENT_PROMPT_MODULE_IDS);
export type AgentPromptModuleId = z.infer<typeof AgentPromptModuleId>;

export const AGENT_PROMPT_MODULE_TITLES: Readonly<Record<AgentPromptModuleId, string>> = {
  base_behavior: "Base behavior",
  runtime_mechanics: "Runtime mechanics",
  renderer_markdown: "Markdown rendering",
  sandbox: "Sandbox",
  connected_machine: "Connected Machine",
  repositories: "Repositories and Git",
  workspace_environment: "Workspace environment",
  rig: "Sandbox environment",
  artifacts: "Documents, files, and visuals",
  goals: "Goals",
  subagents: "Session coordination",
  knowledge: "Knowledge",
  skills: "Skills",
  admin: "Integration setup",
  attachments: "Attached files",
};

/** The prompt module each capability owns; capabilities absent here own none. */
export const AGENT_CAPABILITY_PROMPT_MODULES: Readonly<
  Partial<Record<AgentCapabilityId, readonly AgentPromptModuleId[]>>
> = {
  artifacts: ["artifacts"],
  goals: ["goals"],
  subagents: ["subagents"],
  knowledge: ["knowledge"],
  skills: ["skills"],
  workspaceAdmin: ["admin"],
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export const AgentConfigErrorCode = z.enum([
  "agent_capability_unavailable",
  "agent_config_conflict",
  "agent_config_widening",
  "agent_config_not_enabled",
]);
export type AgentConfigErrorCode = z.infer<typeof AgentConfigErrorCode>;

/** Typed resolution failure. Transports render it as 422 with `details.code`. */
export class AgentConfigError extends Error {
  readonly code: AgentConfigErrorCode;
  readonly capability: AgentCapabilityId | undefined;

  constructor(code: AgentConfigErrorCode, message: string, capability?: AgentCapabilityId) {
    super(message);
    this.name = "AgentConfigError";
    this.code = code;
    this.capability = capability;
  }
}

export function isAgentConfigError(error: unknown): error is AgentConfigError {
  return error instanceof AgentConfigError;
}

const SKILLS_RANK: Record<string, number> = { false: 0, read: 1, manage: 2 };
function skillsRank(value: AgentSkillsCapability): number {
  return SKILLS_RANK[String(value)] ?? 0;
}

export function allAgentCapabilities(): ResolvedAgentCapabilities {
  return {
    webSearch: true,
    humanInput: true,
    skills: "manage",
    goals: true,
    subagents: true,
    knowledge: true,
    schedules: true,
    artifacts: true,
    browser: true,
    media: true,
    workspaceFiles: true,
    workspaceConnectors: true,
    workspaceAdmin: true,
  };
}

/** `"none"`: the session's own tools plus the essentials. */
export function noneAgentCapabilities(): ResolvedAgentCapabilities {
  return {
    webSearch: false,
    humanInput: true,
    skills: "read",
    goals: false,
    subagents: false,
    knowledge: false,
    schedules: false,
    artifacts: false,
    browser: false,
    media: false,
    workspaceFiles: false,
    workspaceConnectors: false,
    workspaceAdmin: false,
  };
}

export function agentCapabilityEnabled(
  capabilities: ResolvedAgentCapabilities,
  id: AgentCapabilityId,
): boolean {
  return id === "skills" ? capabilities.skills !== false : capabilities[id] === true;
}

/** Clamp `value` to `ceiling` (children and agent callers never widen). */
export function intersectAgentCapabilities(
  value: ResolvedAgentCapabilities,
  ceiling: ResolvedAgentCapabilities,
): ResolvedAgentCapabilities {
  const next = { ...value };
  for (const id of AGENT_BOOLEAN_CAPABILITY_IDS) {
    next[id] = value[id] && ceiling[id];
  }
  next.skills =
    skillsRank(value.skills) <= skillsRank(ceiling.skills) ? value.skills : ceiling.skills;
  return next;
}

/** First capability `value` enables beyond `ceiling`, or null. */
export function agentCapabilityWidening(
  value: ResolvedAgentCapabilities,
  ceiling: ResolvedAgentCapabilities,
): AgentCapabilityId | null {
  for (const id of AGENT_CAPABILITY_IDS) {
    if (id === "skills") {
      if (skillsRank(value.skills) > skillsRank(ceiling.skills)) return id;
    } else if (value[id] && !ceiling[id]) {
      return id;
    }
  }
  return null;
}

function normalizeCapabilities(capabilities: AgentCapabilities): {
  from: AgentCapabilityStartingPoint;
  toggles: AgentCapabilityToggles;
} {
  if (capabilities === "all" || capabilities === "none") return { from: capabilities, toggles: {} };
  const { from, ...toggles } = capabilities;
  return { from, toggles };
}

function applyToggles(
  base: ResolvedAgentCapabilities,
  toggles: AgentCapabilityToggles,
): ResolvedAgentCapabilities {
  const next = { ...base };
  for (const id of AGENT_CAPABILITY_IDS) {
    const value = toggles[id];
    if (value === undefined) continue;
    if (id === "skills") next.skills = value as AgentSkillsCapability;
    else next[id] = value as boolean;
  }
  return next;
}

/** Hard limits: capabilities this deployment does not offer, with a reason. */
export type AgentConfigDeploymentLimits = {
  unavailable: Partial<Record<AgentCapabilityId, string>>;
};

export type AgentConfigCreator =
  | "api"
  | "slack"
  | "scheduled"
  | "automation"
  | "site_auth_maintenance";

/** What the workspace offers when a configuration is being created. */
export type AgentConfigWorkspaceContext = {
  /** Explicit `settings.sessionAgentDefaults`, honored only with admission enabled. */
  defaults: WorkspaceAgentDefaults | null;
  /** Legacy `settings.agentHumanInputEnabled`; false maps to `humanInput: false`. */
  humanInputEnabled: boolean;
};

export type AgentConfigParent =
  | { kind: "configured"; config: ResolvedAgentConfig }
  /** A null-config parent: its current effective capabilities are the ceiling. */
  | { kind: "legacy"; ceiling: ResolvedAgentCapabilities };

export type ResolveAgentConfigInput = {
  creator: AgentConfigCreator;
  /** The request `agent` object; undefined when omitted. */
  request?: AgentConfigRequest | undefined;
  /** The legacy session `instructions` field (alias target). */
  instructions?: string | undefined;
  workspace: AgentConfigWorkspaceContext;
  deployment: AgentConfigDeploymentLimits & {
    admissionEnabled: boolean;
    defaultForNewSessions: boolean;
  };
  /** Undefined for a top-level session. */
  parent?: AgentConfigParent | undefined;
  /** Whether the new session carries a goal. */
  goal: boolean;
};

export type ResolveAgentConfigResult = {
  config: ResolvedAgentConfig | null;
  /** The effective session instructions after the alias rule. */
  instructions: string | undefined;
};

function defaultRenderer(creator: AgentConfigCreator): AgentRenderer {
  return creator === "slack" ? "markdown" : "opengeni";
}

function agentConfigFromCapabilities(input: {
  from: AgentCapabilityStartingPoint;
  wanted: ResolvedAgentCapabilities;
  explicitOn: ReadonlySet<AgentCapabilityId>;
  deployment: AgentConfigDeploymentLimits;
  identity: string | null;
  renderer: AgentRenderer;
  source: ResolvedAgentConfigSource;
  inheritedUnavailable?: readonly AgentCapabilityId[] | undefined;
}): ResolvedAgentConfig {
  const capabilities = { ...input.wanted };
  const unavailable = new Set<AgentCapabilityId>(input.inheritedUnavailable ?? []);
  for (const id of AGENT_CAPABILITY_IDS) {
    const reason = input.deployment.unavailable[id];
    if (reason === undefined || !agentCapabilityEnabled(capabilities, id)) continue;
    if (input.explicitOn.has(id)) {
      throw new AgentConfigError(
        "agent_capability_unavailable",
        `agent capability ${id} is not available on this deployment: ${reason}`,
        id,
      );
    }
    unavailable.add(id);
    if (id === "skills") capabilities.skills = false;
    else capabilities[id] = false;
  }
  for (const id of unavailable) {
    if (id === "skills") capabilities.skills = false;
    else capabilities[id] = false;
  }
  return {
    version: 1,
    from: input.from,
    capabilities,
    unavailable: AGENT_CAPABILITY_IDS.filter((id) => unavailable.has(id)),
    identity: input.identity,
    renderer: input.renderer,
    source: input.source,
  };
}

function explicitOnToggles(toggles: AgentCapabilityToggles): Set<AgentCapabilityId> {
  const on = new Set<AgentCapabilityId>();
  for (const id of AGENT_CAPABILITY_IDS) {
    const value = toggles[id];
    if (value !== undefined && value !== false) on.add(id);
  }
  return on;
}

function resolveInstructionsAlias(
  request: AgentConfigRequest | undefined,
  instructions: string | undefined,
): string | undefined {
  const aliased = request?.instructions;
  if (
    aliased !== undefined &&
    instructions !== undefined &&
    aliased.trim() !== instructions.trim()
  ) {
    throw new AgentConfigError(
      "agent_config_conflict",
      "agent.instructions and instructions are both set and differ; send only one",
    );
  }
  return instructions ?? aliased;
}

/**
 * Resolve the frozen agent configuration for a new session.
 *
 * Order: deployment limits, then the workspace default, then the request, then
 * the parent (children only narrow). Returns `config: null` (exact legacy)
 * when nothing asks for a configuration: no request `agent`, no configured
 * parent, no honored workspace default, and the default-for-new-sessions
 * switch off (or a legacy parent, which keeps its tree legacy).
 */
export function resolveAgentConfig(input: ResolveAgentConfigInput): ResolveAgentConfigResult {
  const { request } = input;
  if (request !== undefined && !input.deployment.admissionEnabled) {
    throw new AgentConfigError(
      "agent_config_not_enabled",
      "agent configuration is not enabled on this deployment",
    );
  }
  const instructions = resolveInstructionsAlias(request, input.instructions);
  const requestConfigFields =
    request !== undefined &&
    (request.capabilities !== undefined ||
      request.identity !== undefined ||
      request.renderer !== undefined ||
      request.instructions !== undefined);

  const parent = input.parent;
  const workspaceDefaults = input.deployment.admissionEnabled ? input.workspace.defaults : null;

  // --- Omitted agent ---------------------------------------------------------
  if (!requestConfigFields) {
    if (parent?.kind === "configured") {
      return {
        config: withGoalImplication(
          { ...parent.config, source: "inherited" },
          input.goal,
          false,
          parent.config.capabilities,
        ),
        instructions,
      };
    }
    if (parent?.kind === "legacy") return { config: null, instructions };
    if (input.creator === "site_auth_maintenance") return { config: null, instructions };
    if (workspaceDefaults) {
      const config = resolveTopLevel(input, workspaceDefaults, "workspace_default");
      return { config, instructions };
    }
    if (input.deployment.defaultForNewSessions) {
      const config = resolveTopLevel(input, { capabilities: "all" }, "deployment_default");
      return { config, instructions };
    }
    return { config: null, instructions };
  }

  // --- Explicit agent ---------------------------------------------------------
  if (!parent) {
    const merged: WorkspaceAgentDefaults = {
      capabilities: request.capabilities ?? workspaceDefaults?.capabilities ?? "all",
      ...(request.identity !== undefined
        ? { identity: request.identity }
        : workspaceDefaults?.identity !== undefined
          ? { identity: workspaceDefaults.identity }
          : {}),
      ...((request.renderer ?? workspaceDefaults?.renderer)
        ? { renderer: request.renderer ?? workspaceDefaults?.renderer }
        : {}),
    };
    return {
      config: resolveTopLevel(input, merged, "request", request.capabilities === undefined),
      instructions,
    };
  }

  const ceiling = parent.kind === "configured" ? parent.config.capabilities : parent.ceiling;
  const parentConfig = parent.kind === "configured" ? parent.config : null;
  const requested = request.capabilities
    ? normalizeCapabilities(request.capabilities)
    : { from: (parentConfig?.from ?? "all") as AgentCapabilityStartingPoint, toggles: {} };
  // `"all"` for a child means the parent's set; `"none"` means the essentials
  // the parent also has. Only explicit toggles can widen, and that is refused.
  const base =
    requested.from === "all"
      ? { ...ceiling }
      : intersectAgentCapabilities(noneAgentCapabilities(), ceiling);
  const wanted = applyToggles(base, requested.toggles);
  const widened = agentCapabilityWidening(wanted, ceiling);
  if (widened) {
    throw new AgentConfigError(
      "agent_config_widening",
      `a child session may only narrow its parent's agent capabilities: ${widened}`,
      widened,
    );
  }
  const config = agentConfigFromCapabilities({
    from: requested.from,
    wanted,
    explicitOn: explicitOnToggles(requested.toggles),
    deployment: input.deployment,
    identity: request.identity !== undefined ? request.identity : (parentConfig?.identity ?? null),
    renderer: request.renderer ?? parentConfig?.renderer ?? defaultRenderer(input.creator),
    source: "request",
    inheritedUnavailable: parentConfig?.unavailable,
  });
  return {
    config: withGoalImplication(config, input.goal, requested.toggles.goals === false, ceiling),
    instructions,
  };
}

function resolveTopLevel(
  input: ResolveAgentConfigInput,
  source: WorkspaceAgentDefaults,
  sourceKind: ResolvedAgentConfigSource,
  capabilitiesFromWorkspace = false,
): ResolvedAgentConfig {
  const { from, toggles } = normalizeCapabilities(source.capabilities ?? "all");
  const base = from === "all" ? allAgentCapabilities() : noneAgentCapabilities();
  // "Everything this workspace offers": a workspace that turned structured
  // human input off keeps it off unless a toggle explicitly asks for it.
  if (!input.workspace.humanInputEnabled) base.humanInput = false;
  const wanted = applyToggles(base, toggles);
  const explicitGoalsOff = !capabilitiesFromWorkspace && toggles.goals === false;
  const config = agentConfigFromCapabilities({
    from,
    wanted,
    // A workspace default never fails a create: unavailable capabilities it
    // names are reported off instead. Only the request's own toggles are strict.
    explicitOn:
      sourceKind === "request" && !capabilitiesFromWorkspace
        ? explicitOnToggles(toggles)
        : new Set(),
    deployment: input.deployment,
    identity: source.identity ?? null,
    renderer: source.renderer ?? defaultRenderer(input.creator),
    source: sourceKind,
  });
  return withGoalImplication(config, input.goal, explicitGoalsOff, allAgentCapabilities());
}

/** Setting a goal implies `goals`; an explicit `goals: false` with a goal is a conflict. */
function withGoalImplication(
  config: ResolvedAgentConfig,
  goal: boolean,
  explicitGoalsOff: boolean,
  ceiling: ResolvedAgentCapabilities,
): ResolvedAgentConfig {
  if (!goal || config.capabilities.goals) return config;
  if (explicitGoalsOff) {
    throw new AgentConfigError(
      "agent_config_conflict",
      "a session with a goal needs the goals capability; remove goals: false or the goal",
      "goals",
    );
  }
  if (config.unavailable.includes("goals")) return config;
  if (!ceiling.goals) {
    throw new AgentConfigError(
      "agent_config_widening",
      "a child session with a goal needs the goals capability its parent does not have",
      "goals",
    );
  }
  return { ...config, capabilities: { ...config.capabilities, goals: true } };
}

/**
 * Resolve a mid-session update. Omitted fields keep the current values; a
 * legacy (null) session converts from `legacyCeiling` (its current effective
 * state). Agent callers may only narrow.
 */
export function resolveAgentConfigUpdate(input: {
  current: ResolvedAgentConfig | null;
  legacyCeiling: ResolvedAgentCapabilities;
  request: AgentConfigRequest;
  deployment: AgentConfigDeploymentLimits & { admissionEnabled: boolean };
  onlyNarrow: boolean;
  /** A parent's configuration or legacy ceiling; children never widen past it. */
  parentCeiling?: ResolvedAgentCapabilities | undefined;
  goal: boolean;
}): ResolvedAgentConfig {
  if (!input.deployment.admissionEnabled) {
    throw new AgentConfigError(
      "agent_config_not_enabled",
      "agent configuration is not enabled on this deployment",
    );
  }
  const current: ResolvedAgentConfig = input.current ?? {
    version: 1,
    from: "all",
    capabilities: { ...input.legacyCeiling },
    unavailable: [],
    identity: null,
    renderer: "opengeni",
    source: "legacy_conversion",
  };
  let wanted = { ...current.capabilities };
  let from = current.from;
  let explicitOn = new Set<AgentCapabilityId>();
  let explicitGoalsOff = false;
  if (input.request.capabilities !== undefined) {
    const normalized = normalizeCapabilities(input.request.capabilities);
    from = normalized.from;
    const base = normalized.from === "all" ? allAgentCapabilities() : noneAgentCapabilities();
    wanted = applyToggles(base, normalized.toggles);
    explicitOn = explicitOnToggles(normalized.toggles);
    explicitGoalsOff = normalized.toggles.goals === false;
    // Starting points are clamped silently to what this session may hold;
    // explicit toggles beyond it are refused below.
    const implicitCeiling = input.onlyNarrow ? current.capabilities : input.parentCeiling;
    if (implicitCeiling) {
      const clamped = intersectAgentCapabilities(wanted, implicitCeiling);
      for (const id of AGENT_CAPABILITY_IDS) {
        if (!explicitOn.has(id)) {
          if (id === "skills") wanted.skills = clamped.skills;
          else wanted[id] = clamped[id];
        }
      }
    }
  }
  for (const [ceiling, who] of [
    [input.onlyNarrow ? current.capabilities : undefined, "an agent may only narrow its session"],
    [input.parentCeiling, "a child session may only narrow its parent's agent capabilities"],
  ] as const) {
    if (!ceiling) continue;
    const widened = agentCapabilityWidening(wanted, ceiling);
    if (widened) {
      throw new AgentConfigError("agent_config_widening", `${who}: ${widened}`, widened);
    }
  }
  const config = agentConfigFromCapabilities({
    from,
    wanted,
    explicitOn,
    deployment: input.deployment,
    identity: input.request.identity !== undefined ? input.request.identity : current.identity,
    renderer: input.request.renderer ?? current.renderer,
    source: input.current ? "request" : "legacy_conversion",
    // Capabilities a human re-enables are re-checked against the deployment.
    inheritedUnavailable: current.unavailable.filter(
      (id) => input.deployment.unavailable[id] !== undefined,
    ),
  });
  return withGoalImplication(
    config,
    input.goal,
    explicitGoalsOff,
    input.parentCeiling ?? (input.onlyNarrow ? current.capabilities : allAgentCapabilities()),
  );
}

// ---------------------------------------------------------------------------
// Write-through to the legacy session columns
// ---------------------------------------------------------------------------

/** A capability is filtered out of legacy columns only when the config turns it off itself. */
function capabilityFilteredOut(config: ResolvedAgentConfig, id: AgentCapabilityId): boolean {
  return !agentCapabilityEnabled(config.capabilities, id) && !config.unavailable.includes(id);
}

/**
 * Narrow a creator's first-party selection (its exact legacy value) to the
 * enabled capabilities. `"all"` returns `baseline` unchanged. `explicit`, when
 * the request listed `firstPartyMcpTools` itself, must not name a tool of a
 * capability the configuration turns off.
 */
export function agentConfigFirstPartyMcpTools(
  config: ResolvedAgentConfig,
  baseline: readonly FirstPartyMcpToolName[],
  explicit?: readonly FirstPartyMcpToolName[],
): FirstPartyMcpToolName[] {
  for (const tool of explicit ?? []) {
    const owner = FIRST_PARTY_MCP_TOOL_CAPABILITIES[tool];
    if (owner !== "runtime" && capabilityFilteredOut(config, owner)) {
      throw new AgentConfigError(
        "agent_config_conflict",
        `firstPartyMcpTools lists ${tool}, but agent capability ${owner} is off`,
        owner,
      );
    }
  }
  return baseline.filter((tool) => {
    const owner = FIRST_PARTY_MCP_TOOL_CAPABILITIES[tool];
    return owner === "runtime" || !capabilityFilteredOut(config, owner);
  });
}

/**
 * First-party tools a capability change adds on top of the current selection:
 * the default-selection tools of every capability that `next` enables and
 * `previous` did not. Unchanged capabilities keep their exact current tools.
 */
export function agentConfigAddedFirstPartyMcpTools(
  previous: ResolvedAgentCapabilities,
  next: ResolvedAgentConfig,
  defaults: readonly FirstPartyMcpToolName[],
): FirstPartyMcpToolName[] {
  return defaults.filter((tool) => {
    const owner = FIRST_PARTY_MCP_TOOL_CAPABILITIES[tool];
    return (
      owner !== "runtime" &&
      !agentCapabilityEnabled(previous, owner) &&
      agentCapabilityEnabled(next.capabilities, owner)
    );
  });
}

export type AgentConfigToolRefsInput = {
  config: ResolvedAgentConfig;
  tools: readonly ToolRef[];
  toolPolicy: SessionToolPolicy;
  /** Product servers: attached to this session or named explicitly by the request. */
  productServerIds: ReadonlySet<string>;
  /** Server ids the request's explicit `tools` named (strict conflict check). */
  explicitServerIds?: ReadonlySet<string>;
};

/**
 * Apply `workspaceFiles`, `knowledge` (the `docs` server) and
 * `workspaceConnectors` to the stored tool refs and policy. A workspace-default
 * policy keeps tracking defaults with `files`/`docs` excluded when their
 * capability is off; with connectors off it becomes an explicit policy holding
 * only product refs (plus enabled built-ins), so no workspace default connector
 * ever reaches the session. `"all"` returns the input unchanged.
 */
export function agentConfigToolRefs(input: AgentConfigToolRefsInput): {
  tools: ToolRef[];
  toolPolicy: SessionToolPolicy;
} {
  const { config } = input;
  const filesOff = capabilityFilteredOut(config, "workspaceFiles");
  const docsOff = capabilityFilteredOut(config, "knowledge");
  const connectorsOff = capabilityFilteredOut(config, "workspaceConnectors");
  for (const id of input.explicitServerIds ?? []) {
    const owner: AgentCapabilityId | null =
      id === "files" ? "workspaceFiles" : id === "docs" ? "knowledge" : null;
    if (owner && capabilityFilteredOut(config, owner)) {
      throw new AgentConfigError(
        "agent_config_conflict",
        `tools lists the ${id} server, but agent capability ${owner} is off`,
        owner,
      );
    }
  }
  const builtinOff = (id: string) => (id === "files" && filesOff) || (id === "docs" && docsOff);
  const isWorkspaceConnector = (id: string) =>
    id !== "opengeni" && id !== "files" && id !== "docs" && !input.productServerIds.has(id);
  let tools = input.tools
    .filter((tool) => !builtinOff(tool.id))
    .map((tool) =>
      config.from === "none" && input.productServerIds.has(tool.id) && tool.eager === undefined
        ? { ...tool, eager: true }
        : tool,
    );
  let toolPolicy: SessionToolPolicy = { ...input.toolPolicy };
  if (connectorsOff) {
    tools = tools.filter((tool) => !isWorkspaceConnector(tool.id));
    if (toolPolicy.mode === "workspace_default") {
      toolPolicy = { mode: "explicit", inheritedFromSessionId: toolPolicy.inheritedFromSessionId };
    }
  } else if (toolPolicy.mode === "workspace_default" && (filesOff || docsOff)) {
    const excluded = new Set(toolPolicy.excludedMcpServerIds ?? []);
    if (filesOff) excluded.add("files");
    if (docsOff) excluded.add("docs");
    toolPolicy = { ...toolPolicy, excludedMcpServerIds: [...excluded].sort() };
  }
  if (
    tools.length === input.tools.length &&
    tools.every((tool, index) => tool === input.tools[index]) &&
    JSON.stringify(toolPolicy) === JSON.stringify(input.toolPolicy)
  ) {
    return { tools: [...input.tools], toolPolicy: input.toolPolicy };
  }
  return { tools, toolPolicy };
}

/**
 * The effective capabilities of a null-config (legacy) session, used as the
 * ceiling when a child asks for an explicit configuration and when a legacy
 * session converts on its first update. Legacy sessions always carry web
 * search, media, list_models and every Skill tool, so those are on.
 */
export function legacyEffectiveAgentCapabilities(input: {
  firstPartyMcpTools: readonly FirstPartyMcpToolName[];
  tools: readonly ToolRef[];
  toolPolicy: SessionToolPolicy;
  humanInputEnabled: boolean;
  /**
   * The workspace's current omitted-tools default server ids, when known. A
   * workspace-default session only has `files`/`docs`/connectors that are
   * actually defaults; without this the ceiling assumes they are.
   */
  defaultServerIds?: Iterable<string> | undefined;
}): ResolvedAgentCapabilities {
  const selected = new Set<AgentToolCapability>(
    input.firstPartyMcpTools.map((tool) => FIRST_PARTY_MCP_TOOL_CAPABILITIES[tool]),
  );
  const ids = new Set(input.tools.map((tool) => tool.id));
  const tracksDefaults = input.toolPolicy.mode === "workspace_default";
  const excluded = new Set(input.toolPolicy.excludedMcpServerIds ?? []);
  const defaults = input.defaultServerIds ? new Set(input.defaultServerIds) : null;
  const isDefault = (id: string) => defaults === null || defaults.has(id);
  const serverOn = (id: string) =>
    ids.has(id) || (tracksDefaults && !excluded.has(id) && isDefault(id));
  const defaultConnector =
    tracksDefaults &&
    (defaults === null ||
      [...defaults].some(
        (id) => id !== "opengeni" && id !== "files" && id !== "docs" && !excluded.has(id),
      ));
  return {
    webSearch: true,
    humanInput: input.humanInputEnabled,
    skills: "manage",
    goals: selected.has("goals"),
    subagents: true,
    knowledge: selected.has("knowledge") || serverOn("docs"),
    schedules: selected.has("schedules"),
    artifacts: selected.has("artifacts"),
    browser: selected.has("browser"),
    media: true,
    workspaceFiles: serverOn("files"),
    workspaceConnectors:
      selected.has("workspaceConnectors") ||
      defaultConnector ||
      [...ids].some((id) => id !== "opengeni" && id !== "files" && id !== "docs"),
    workspaceAdmin: selected.has("workspaceAdmin"),
  };
}

/**
 * Deployment limits derivable from the deployment's first-party ceiling: a
 * capability whose every first-party tool is outside the allowlist is not
 * offered. Callers add feature flags (for example hosted web search).
 */
export function agentConfigDeploymentLimitsFromAllowlist(
  allowed: readonly FirstPartyMcpToolName[],
  extra: Partial<Record<AgentCapabilityId, string>> = {},
): AgentConfigDeploymentLimits {
  const allowedSet = new Set(allowed);
  const unavailable: Partial<Record<AgentCapabilityId, string>> = {};
  for (const id of AGENT_CAPABILITY_IDS) {
    const tools = firstPartyMcpToolsForCapability(id);
    if (tools.length > 0 && !tools.some((tool) => allowedSet.has(tool))) {
      unavailable[id] = "its tools are not allowed on this server";
    }
  }
  return { unavailable: { ...unavailable, ...extra } };
}

export type AgentEffectiveToolEntry = {
  name: string;
  capability: AgentCapabilityId | "runtime" | "sandbox" | "product";
  source: "first_party" | "runtime" | "hosted" | "sandbox" | "mcp";
  visibility?: "upfront" | "search";
};

export type AgentEffectiveMcpServerEntry = {
  id: string;
  capability: AgentCapabilityId | "runtime" | "product";
  toolsKnown: boolean;
};

export const AgentEffectiveTools = z
  .object({
    capabilities: ResolvedAgentCapabilities,
    unavailable: z.array(AgentCapabilityId),
    /** False means media adapters await exact turn/credential attachment; tools does not guess them. */
    mediaToolsKnown: z.boolean().optional(),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(512),
            capability: z.union([
              AgentCapabilityId,
              z.literal("runtime"),
              z.literal("sandbox"),
              z.literal("product"),
            ]),
            source: z.enum(["first_party", "runtime", "hosted", "sandbox", "mcp"]),
            visibility: z.enum(["upfront", "search"]).optional(),
          })
          .strict(),
      )
      .max(512),
    mcpServers: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            capability: z.union([AgentCapabilityId, z.literal("runtime"), z.literal("product")]),
            toolsKnown: z.boolean(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export type AgentEffectiveTools = z.infer<typeof AgentEffectiveTools>;

/**
 * Project known model tools through the same turn-time gates. External MCP
 * schemas are never guessed: their server stays toolsKnown:false until listed.
 */
export function projectAgentEffectiveTools(input: {
  config: ResolvedAgentConfig;
  firstPartyMcpTools: readonly FirstPartyMcpToolName[];
  mcpServerIds: readonly string[];
  /** Servers attached to the session itself; other non-built-in ids are workspace connectors. */
  productServerIds: ReadonlySet<string>;
  environment?: AgentToolEnvironment;
  runtimeToolNames?: readonly AgentFunctionToolName[];
  hostedToolNames?: readonly AgentFunctionToolName[];
  sandboxToolNames?: readonly AgentFunctionToolName[];
  routerToolNames?: readonly AgentFunctionToolName[];
  /** Raw first-party names; other entries use model-facing names. */
  upfrontToolNames?: ReadonlySet<string>;
  firstPartyModelNames?: ReadonlyMap<FirstPartyMcpToolName, string>;
  mediaAttachment?: AgentMediaAttachment | undefined;
}): AgentEffectiveTools {
  const { capabilities } = input.config;
  const media = resolveAgentMediaToolSurface(input.config, input.mediaAttachment);
  const mediaNames = new Set<string>([...media.hosted, ...media.runtime]);
  const families = resolveAgentToolFamilies(input.config, {
    ...input.environment,
    media: media.toolsKnown ? mediaNames.size > 0 : undefined,
    productServerIds: input.productServerIds,
  });
  const tools: AgentEffectiveToolEntry[] = input.firstPartyMcpTools
    .filter(families.allowsFirstPartyTool)
    .map((tool) => ({
      name: input.firstPartyModelNames?.get(tool) ?? `opengeni__${tool}`,
      capability: FIRST_PARTY_MCP_TOOL_CAPABILITIES[tool],
      source: "first_party",
      visibility: input.upfrontToolNames?.has(tool) ? "upfront" : "search",
    }));
  const functionTool = (name: AgentFunctionToolName, source: AgentEffectiveToolEntry["source"]) => {
    const owner = AGENT_FUNCTION_TOOL_CAPABILITIES[name];
    if (owner === "media" && !mediaNames.has(name)) return;
    if (!families.allowsFunctionTool(name)) return;
    if (tools.some((tool) => tool.name === name)) return;
    tools.push({
      name,
      capability: owner,
      source,
      visibility:
        input.upfrontToolNames?.has(name) || source === "sandbox" || source === "hosted"
          ? "upfront"
          : "search",
    });
  };
  for (const name of input.hostedToolNames ?? []) functionTool(name, "hosted");
  for (const name of input.runtimeToolNames ?? []) functionTool(name, "runtime");
  for (const name of media.hosted) functionTool(name, "hosted");
  for (const name of media.runtime) functionTool(name, "runtime");
  for (const name of input.sandboxToolNames ?? []) functionTool(name, "sandbox");
  if (families.router)
    for (const name of input.routerToolNames ?? []) functionTool(name, "runtime");
  const builtin = AGENT_BUILTIN_MCP_SERVER_CAPABILITIES as Record<string, AgentToolCapability>;
  const mcpServers: AgentEffectiveMcpServerEntry[] = [...new Set(input.mcpServerIds)]
    .filter(families.allowsMcpServer)
    .sort()
    .map((id) => ({
      id,
      capability:
        builtin[id] ?? (input.productServerIds.has(id) ? "product" : "workspaceConnectors"),
      toolsKnown: id === "opengeni",
    }));
  return {
    capabilities: {
      ...capabilities,
      webSearch: families.webSearch,
      humanInput: families.humanInput,
      media: families.media,
    },
    mediaToolsKnown: media.toolsKnown,
    unavailable: [
      ...new Set([
        ...input.config.unavailable,
        ...AGENT_CAPABILITY_IDS.filter(
          (id) =>
            agentCapabilityEnabled(capabilities, id) &&
            (input.environment?.unavailable?.includes(id) ||
              (id === "webSearch" && !families.webSearch) ||
              (id === "humanInput" && !families.humanInput) ||
              (id === "media" && !families.media)),
        ),
      ]),
    ],
    tools,
    mcpServers,
  };
}
