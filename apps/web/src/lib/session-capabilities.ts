import type { FirstPartyMcpToolName } from "@opengeni/contracts";

export type SessionCapabilityGroup = {
  id: string;
  name: string;
  description: string;
  kind: "opengeni" | "connected_app";
  toolIds: FirstPartyMcpToolName[];
};

export type BuiltInMcpCapability = {
  id: "files" | "docs";
  name: string;
  description: string;
};

const BUILT_IN_MCP_CAPABILITIES: Record<BuiltInMcpCapability["id"], BuiltInMcpCapability> = {
  files: {
    id: "files",
    name: "Files",
    description: "Read and publish files selected for the session.",
  },
  docs: {
    id: "docs",
    name: "Documents",
    description: "Search approved documents indexed in this workspace.",
  },
};

/** MCP transports that are native OpenGeni capabilities, not connected apps. */
export function builtInMcpCapability(
  server: Readonly<{ id: string }>,
): BuiltInMcpCapability | null {
  return server.id === "files" || server.id === "docs"
    ? BUILT_IN_MCP_CAPABILITIES[server.id]
    : null;
}

type CapabilityGroupDefinition = Omit<SessionCapabilityGroup, "toolIds"> & {
  matches: (tool: FirstPartyMcpToolName) => boolean;
};

const CONNECTED_APP_GROUPS: CapabilityGroupDefinition[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Repository discovery and connection setup.",
    kind: "connected_app",
    matches: (tool) => tool.startsWith("github_"),
  },
  {
    id: "slack",
    name: "Slack",
    description: "Search workspace conversations and work with messages.",
    kind: "connected_app",
    matches: (tool) => tool.startsWith("slack_bot_"),
  },
  {
    id: "social",
    name: "Social accounts",
    description: "Read and work with connected X and Reddit accounts.",
    kind: "connected_app",
    matches: (tool) =>
      tool.startsWith("social_") || tool.startsWith("x_") || tool.startsWith("reddit_"),
  },
  {
    id: "fiken",
    name: "Fiken",
    description: "Customers, products, invoices, purchases, and sales.",
    kind: "connected_app",
    matches: (tool) => tool.startsWith("fiken_"),
  },
  {
    id: "atlassian",
    name: "Jira & Confluence",
    description: "Search approved Jira and Confluence sources.",
    kind: "connected_app",
    matches: (tool) => tool.startsWith("atlassian_"),
  },
];

const OPENGENI_GROUPS: CapabilityGroupDefinition[] = [
  {
    id: "knowledge",
    name: "Memory & learning",
    description: "Use durable facts, task notes, preferences, and workspace guidance.",
    kind: "opengeni",
    matches: (tool) =>
      tool.startsWith("memory_") ||
      tool.startsWith("preference_") ||
      tool.startsWith("task_note_") ||
      tool.startsWith("task_notes_") ||
      tool.startsWith("knowledge_") ||
      tool.startsWith("instruction_policy_") ||
      tool.startsWith("remember") ||
      tool.startsWith("company_profile_"),
  },
  {
    id: "agents",
    name: "Agents and delegation",
    description: "Set goals, create workers, and coordinate other sessions.",
    kind: "opengeni",
    matches: (tool) =>
      tool === "set_session_title" ||
      tool === "set_other_session_title" ||
      tool.startsWith("goal_") ||
      tool.startsWith("session_") ||
      tool.startsWith("sessions_"),
  },
  {
    id: "interaction",
    name: "Browser and computer",
    description: "Use browser sessions, connected computers, and human input.",
    kind: "opengeni",
    matches: (tool) =>
      tool.startsWith("interaction_") ||
      tool.startsWith("browser_") ||
      tool.startsWith("computer_"),
  },
  {
    id: "workspace",
    name: "Workspace operations",
    description: "Use sandboxes, rigs, variables, schedules, and artifacts.",
    kind: "opengeni",
    matches: (tool) =>
      tool.startsWith("sandbox") ||
      tool.startsWith("sandboxes_") ||
      tool === "run_on" ||
      tool.startsWith("connected_machine_") ||
      tool.startsWith("rig_") ||
      tool.startsWith("variable_set_") ||
      tool.startsWith("environment_") ||
      tool.startsWith("scheduled_") ||
      tool.startsWith("artifacts_") ||
      tool.startsWith("editable_artifact_") ||
      tool.startsWith("capability_"),
  },
];

/**
 * Convert the exact first-party catalog into a small, truthful product model.
 * Every visible tool remains represented. Unknown future tools fall into one
 * final OpenGeni group instead of silently disappearing from the picker.
 */
export function sessionCapabilityGroupsFor(
  tools: ReadonlyArray<{ id: FirstPartyMcpToolName }>,
): SessionCapabilityGroup[] {
  const unmatched = new Set(tools.map((tool) => tool.id));
  const groups = [...OPENGENI_GROUPS, ...CONNECTED_APP_GROUPS].flatMap((definition) => {
    const toolIds = [...unmatched].filter(definition.matches);
    for (const tool of toolIds) unmatched.delete(tool);
    return toolIds.length > 0
      ? [
          {
            id: definition.id,
            name: definition.name,
            description: definition.description,
            kind: definition.kind,
            toolIds,
          } satisfies SessionCapabilityGroup,
        ]
      : [];
  });
  if (unmatched.size > 0) {
    groups.push({
      id: "other",
      name: "Other OpenGeni actions",
      description: "Additional workspace actions enabled by this deployment.",
      kind: "opengeni",
      toolIds: [...unmatched],
    });
  }
  return groups;
}

export function capabilityGroupSelection(
  group: Pick<SessionCapabilityGroup, "toolIds">,
  selected: ReadonlySet<FirstPartyMcpToolName>,
): "all" | "some" | "none" {
  const selectedCount = group.toolIds.filter((tool) => selected.has(tool)).length;
  if (selectedCount === 0) return "none";
  return selectedCount === group.toolIds.length ? "all" : "some";
}
