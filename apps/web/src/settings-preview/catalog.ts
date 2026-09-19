/** Review fixtures, not account data. Page coverage follows the settings shells. */
export const settingsPages = {
  workspace: [
    "General",
    "Agent learning",
    "Members",
    "Models",
    "Capabilities",
    "API keys",
    "Danger zone",
    "Agents",
    "Insights",
    "Credentials & variables",
    "Rigs",
    "Machines",
  ],
  organization: [
    "Overview",
    "Knowledge",
    "Models",
    "Integrations",
    "People & invitations",
    "Recovery",
    "Retention",
    "Developer",
    "Billing",
  ],
  personal: ["Security"],
  patterns: ["Pattern library"],
} as const;
export type SettingsScope = keyof typeof settingsPages;

export const pageDescriptions: Record<string, string> = {
  General: "Manage your workspace identity and everyday preferences.",
  "Agent learning": "Choose how agents learn and when changes need your review.",
  Members: "Manage who has access to this workspace.",
  Models: "Choose model defaults and manage your AI connections.",
  Capabilities: "Choose the tools available to agents in this workspace.",
  "API keys": "Manage programmatic access to your workspace.",
  "Danger zone": "Sensitive actions that affect this workspace and its data.",
  Agents: "Manage the agents working in your workspace.",
  Insights: "Review workspace activity and usage.",
  "Credentials & variables": "Organize credentials and reusable environment variables.",
  Rigs: "Configure the environments where your agents work.",
  Machines: "Manage computers connected to your workspace.",
  Overview: "Manage organization identity and shared workspaces.",
  Knowledge: "Manage shared knowledge and how your organization learns.",
  Integrations: "Manage connections available across the organization.",
  "People & invitations": "Manage organization membership and pending invitations.",
  Recovery: "Review recovery options for your organization.",
  Retention: "Manage how long organization data is retained.",
  Developer: "Manage developer access and organization configuration.",
  Billing: "Review usage, credits, and billing details.",
  Security: "Manage your sign-in methods and active sessions.",
  "Pattern library":
    "The same components used throughout this preview, ready for production integration.",
};

export type PreviewResource = { name: string; description: string; status: string };
export const resources: Record<string, PreviewResource[]> = {
  Members: [
    { name: "Alex Morgan", description: "alex@example.com", status: "Owner" },
    { name: "Jordan Lee", description: "jordan@example.com", status: "Admin" },
    { name: "Sam Rivera", description: "sam@example.com", status: "Member" },
  ],
  "People & invitations": [
    { name: "Alex Morgan", description: "alex@example.com · 2 workspaces", status: "Owner" },
    { name: "Jordan Lee", description: "jordan@example.com · 1 workspace", status: "Admin" },
    { name: "Sam Rivera", description: "sam@example.com · Invitation pending", status: "Invited" },
  ],
  "API keys": [
    {
      name: "Development",
      description: "Created Sep 10 · Last used 2 hours ago · Value hidden",
      status: "Active",
    },
    {
      name: "CI automation",
      description: "Created Sep 8 · Last used yesterday · Value hidden",
      status: "Active",
    },
  ],
  Capabilities: [
    { name: "GitHub", description: "Repositories, issues, and pull requests", status: "Connected" },
    { name: "Slack", description: "Shared workspace bot", status: "Connected" },
    {
      name: "Google Drive",
      description: "Documents and knowledge sources",
      status: "Not connected",
    },
  ],
  Integrations: [
    {
      name: "GitHub",
      description: "Source control · Organization connection",
      status: "Connected",
    },
    { name: "Slack", description: "Workspace bot · Shared connection", status: "Connected" },
  ],
  Agents: [
    { name: "Engineering assistant", description: "Development and code review", status: "Ready" },
    {
      name: "Research assistant",
      description: "Research and knowledge synthesis",
      status: "Ready",
    },
  ],
  "Credentials & variables": [
    {
      name: "Development environment",
      description: "Variable set · 4 variables · Values hidden",
      status: "Workspace",
    },
    {
      name: "Deployment credentials",
      description: "Credential · Value hidden",
      status: "Workspace",
    },
  ],
  Rigs: [
    {
      name: "Standard development",
      description: "Isolated sandbox · Default environment",
      status: "Ready",
    },
    {
      name: "Browser research",
      description: "Isolated sandbox · Browser enabled",
      status: "Ready",
    },
  ],
  Machines: [
    { name: "Development workstation", description: "Linux · Connected machine", status: "Online" },
    { name: "Design laptop", description: "macOS · Last seen yesterday", status: "Offline" },
  ],
  Overview: [
    { name: "Product team", description: "Shared workspace · 3 members", status: "Active" },
    { name: "Engineering", description: "Shared workspace · 8 members", status: "Active" },
  ],
  Developer: [
    {
      name: "Internal application",
      description: "Organization API access · Value hidden",
      status: "Active",
    },
  ],
};
