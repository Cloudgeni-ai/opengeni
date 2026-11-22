// Preview-only data/context for the setup pages (Capabilities, Knowledge,
// Ready-made) beside the real rail. Every page and row is production UI; only the
// SDK client is a fixture. Calls the fixture doesn't serve resolve to an empty
// list, so a page shows its empty state instead of failing.
import type { AppContextValue } from "@opengeni/react/app/app-context";
import {
  client as sidebarClient,
  useAppContext as baseContext,
  workspaceId,
} from "./session-sidebar-context";

export { workspaceId };
export {
  RAIL_DEFAULT_WIDTH,
  RAIL_MIN_WIDTH,
  RAIL_MAX_WIDTH,
  useRail,
  useOptionalRail,
} from "./desktop-rail-context";
export { createSessionEventFeedStore } from "./session-sidebar-context";

const now = new Date("2026-11-21T12:00:00.000Z").toISOString();
const logo = (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

function connector(
  id: string,
  name: string,
  domain: string,
  description: string,
  enabled: boolean,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    kind: "mcp",
    source: "catalog",
    name,
    description,
    category: null,
    tags: ["featured"],
    providerDomain: domain,
    logoUrl: logo(domain),
    homepageUrl: `https://${domain}`,
    mcpUrl: `https://mcp.${domain}/mcp`,
    tier: "verified",
    enabled,
    runtime: { available: true },
    metadata: { curation: { curated: true, featured: true } },
    ...extra,
  };
}

function librarySkill(id: string, name: string, description: string, team: string) {
  return {
    id: `skill:${id}`,
    kind: "skill",
    source: "library",
    name,
    description,
    category: "infrastructure",
    tags: ["skill"],
    provenance: "Opengeni",
    tier: "verified",
    enabled: false,
    runtime: { available: true },
    metadata: {
      libraryId: id,
      version: "1.0.0",
      contentSha256: "0".repeat(64),
      team,
    },
  };
}

const capabilities = [
  connector(
    "connector:github",
    "GitHub",
    "github.com",
    "Repositories, issues and pull requests",
    true,
  ),
  connector("connector:linear", "Linear", "linear.app", "Plan projects and track issues", true),
  connector("connector:notion", "Notion", "notion.so", "Search pages and project notes", false),
  connector("connector:posthog", "PostHog", "posthog.com", "Product analytics and flags", true),
  connector("connector:sentry", "Sentry", "sentry.io", "Errors and performance issues", false),
  connector("connector:figma", "Figma", "figma.com", "Read designs and comments", false),
  connector("connector:hubspot", "HubSpot", "hubspot.com", "Contacts, deals and tickets", false),
  connector("connector:datadog", "Datadog", "datadoghq.com", "Metrics, logs and monitors", false),
  connector(
    "connector:google-drive",
    "Google Drive",
    "drive.google.com",
    "Files and folders",
    false,
  ),
  connector("connector:asana", "Asana", "asana.com", "Tasks and projects", false),
  librarySkill(
    "checkov",
    "Checkov",
    "Scan infrastructure code for misconfigurations",
    "Engineering",
  ),
  librarySkill("terraform-test", "Terraform test", "Write and run Terraform tests", "Engineering"),
  librarySkill(
    "social-media-marketing",
    "Social media marketing",
    "Plan and write posts for each network",
    "Marketing",
  ),
  librarySkill(
    "document-parsing",
    "Document parsing",
    "Read Word, PowerPoint, Excel and PDF files",
    "Operations",
  ),
];

const skills = [
  ["release-notes", "Release notes", "Turn merged pull requests into release notes", "workspace"],
  ["incident-review", "Incident review", "Write a blameless review after an incident", "workspace"],
  ["frontend-design", "Frontend design", "Distinctive, intentional interface design", "user"],
].map(([stableKey, title, description, scope], index) => ({
  id: `00000000-0000-4000-b000-00000000000${index + 1}`,
  stableKey,
  title,
  description,
  scope,
  scopeVersion: 1,
  status: "active",
  activationMode: "workspace_managed",
  activeRevisionId: `00000000-0000-4000-c000-00000000000${index + 1}`,
  revisionId: `00000000-0000-4000-c000-00000000000${index + 1}`,
  contentHash: "a".repeat(64),
  pendingRevisionIds: [],
  source: null,
  availableHere: true,
}));

const publicSkills = [
  [
    "vercel-labs/agent-skills/react-best-practices",
    "react-best-practices",
    "vercel-labs/agent-skills",
    22100,
  ],
  [
    "supabase/agent-skills/postgres-best-practices",
    "postgres-best-practices",
    "supabase/agent-skills",
    12400,
  ],
  ["anthropics/skills/pdf", "pdf", "anthropics/skills", 41200],
  ["anthropics/skills/xlsx", "xlsx", "anthropics/skills", 28900],
].map(([id, name, source, installs]) => ({
  id,
  name,
  source,
  installs,
  url: `https://skills.sh/${id}`,
}));

const plugins = [
  ["linear", "Linear", "Issues and projects, with skills for planning", "linear.app"],
  ["sentry", "Sentry", "Errors and traces, with a triage skill", "sentry.io"],
  ["figma", "Figma", "Designs and comments, with a handoff skill", "figma.com"],
  ["vercel", "Vercel", "Deployments and logs, with a release skill", "vercel.com"],
].map(([id, displayName, description, domain]) => ({
  id: `openai/${id}`,
  name: id,
  displayName,
  description,
  longDescription: description,
  provider: "openai",
  category: null,
  logoUrl: logo(domain!),
  darkLogoUrl: null,
  sourceUrl: `https://github.com/openai/plugins/tree/main/${id}`,
  author: { name: displayName },
  version: "1.0.0",
  skills: [
    { name: `${id}-workflow`, sourceUrl: `https://github.com/openai/plugins/tree/main/${id}` },
  ],
  mcpServers: [{ name: id, transport: "http", endpoint: `https://mcp.${domain}/mcp` }],
  components: ["skills", "mcp"],
  installation: "available",
}));

const workspaceState = {
  workspaceId,
  generatedAt: now,
  policy: {
    authority: "workspace_instruction_policy_heads",
    activeHeads: [],
    activeHeadsTruncated: false,
    latestRevision: null,
    legacyRuntime: { source: "deployment_default", workspaceOverrideConfigured: false },
    runtimeComposition: { status: "not_implemented" },
  },
};

const agentTemplates = [
  {
    key: "triage",
    name: "Triage",
    team: "Engineering",
    description: "Sorts new issues and reports, and hands real bugs to Bug fixer.",
    avatar: { kind: "icon", icon: "search", hue: 200 },
  },
  {
    key: "bug-fixer",
    name: "Bug fixer",
    team: "Engineering",
    description: "Reproduces a bug, fixes it and opens a pull request.",
    avatar: { kind: "icon", icon: "wrench", hue: 20 },
  },
  {
    key: "pr-reviewer",
    name: "PR reviewer",
    team: "Engineering",
    description: "Reviews pull requests for bugs, risky changes and missing tests.",
    avatar: { kind: "icon", icon: "git-pull-request", hue: 260 },
  },
].map((template) => ({
  instructions: "Preview",
  memoryEnabled: true,
  toolPermissions: [],
  skills: [],
  suggestedTriggers: [],
  ...template,
}));

const appTemplates = [
  {
    key: "decision-log",
    name: "Decision log",
    team: "Product",
    description: "Record decisions, who made them and why.",
  },
];

const served: Record<string, (...args: unknown[]) => unknown> = {
  listCapabilities: async () => ({
    // Like production, the catalog lists only added library skills.
    items: structuredClone(
      capabilities.filter((item) => item.source !== "library" || item.enabled),
    ),
    memberIntegrationSetup: null,
  }),
  connectTransport: () => ({ catalog: async () => [] }),
  listWorkspaceSkills: async () => ({ skills: structuredClone(skills), nextCursor: null }),
  searchPublicSkills: async () => ({ items: structuredClone(publicSkills), nextCursor: null }),
  discoverPlugins: async () => ({
    items: structuredClone(plugins),
    total: plugins.length,
    nextOffset: null,
  }),
  getWorkspaceState: async () => structuredClone(workspaceState),
  listAgentTemplates: async () => structuredClone(agentTemplates),
  listAppTemplates: async () => structuredClone(appTemplates),
  listLibrarySkills: async () =>
    structuredClone(capabilities.filter((item) => item.source === "library")),
  listAgents: async () => [],
};

/**
 * Unserved reads resolve to an empty list whose plural fields are empty lists
 * too (`{ plugins: [] }`-shaped answers), with no next page.
 */
function emptyResult(): unknown {
  return new Proxy([] as unknown[], {
    get(target, property, receiver) {
      // Answers' `entries`, `keys` and `values` are fields, not the array's methods.
      if (property === "entries" || property === "keys" || property === "values") return [];
      if (typeof property !== "string" || property in target) {
        return Reflect.get(target, property, receiver);
      }
      if (property === "then" || property === "toJSON") return undefined;
      if (/cursor|next|offset|error|^(id|status|state)$/iu.test(property)) return null;
      if (/^(total|count)$/iu.test(property)) return 0;
      // Plural fields are lists; anything else is absent.
      return /[a-z]s$/u.test(property) ? [] : undefined;
    },
  });
}

const unserved = new Set<string>();
export const client = new Proxy(sidebarClient as Record<string, unknown>, {
  get(target, property) {
    if (typeof property !== "string") return Reflect.get(target, property);
    if (property in served) return served[property];
    if (property in target) return Reflect.get(target, property);
    if (property === "then") return undefined;
    return async () => {
      if (!unserved.has(property)) {
        unserved.add(property);
        console.info("preview: unserved", property);
      }
      return emptyResult();
    };
  },
});

const base = baseContext() as unknown as Record<string, unknown>;
const workspace = { id: workspaceId, accountId: "preview-org", name: "Product", status: "active" };
const context = {
  ...base,
  client,
  clientConfig: {
    auth: { mode: "deploymentKey" },
    connectedMachines: false,
    fileUploads: { enabled: true },
    eventTriggers: { enabled: true },
  },
  workspaces: [workspace],
  workspace,
  workspaceCapabilityCatalog: capabilities,
  accessContext: {
    subjectId: "preview-user",
    subjectLabel: "Alex Morgan",
    accountGrants: [
      { accountId: "preview-org", permissions: [], metadata: { accountName: "Cloudgeni" } },
    ],
    workspaceGrants: [
      {
        workspaceId,
        accountId: "preview-org",
        subjectId: "preview-user",
        permissions: [
          "workspace:read",
          "workspace:admin",
          "sessions:create",
          "sessions:read",
          "connections:read",
          "connections:manage",
          "documents:manage",
          "artifacts:read",
          "artifacts:publish",
        ],
      },
    ],
  },
} as unknown as AppContextValue;

export const useAppContext = () => context;
export const useOptionalAppContext = () => context;
