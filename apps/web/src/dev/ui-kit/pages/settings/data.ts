/**
 * Kit-only data for the workspace settings page previews (General, Access,
 * API keys). Everything is derived from the shared fixtures so the pages show
 * the same Acme Robotics content as every component section.
 */

import type { AccessMember } from "@/components/ui/access-list";
import type { RoleOption } from "@/components/ui/role-select";

import {
  apiKeyPresets,
  apiKeys,
  currentWorkspace,
  designPreviewAccess,
  personById,
  workspaceRoles,
  type ApiKey,
  type ApiKeyAccess,
  type Person,
  type WorkspaceRole,
} from "../../fixtures";

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ----------------------------------------------------------------------------
   Who is looking at the page.
   -------------------------------------------------------------------------- */

/** Bendik is the workspace admin; Maria is a member of Design preview. */
export type Viewer = "admin" | "member";

export const VIEWER_PERSON: Record<Viewer, Person> = {
  admin: personById("person-bendik"),
  member: personById("person-maria"),
};

export const ADMIN_ONLY_REASON = "Only workspace admins can change this. Ask Bendik Hansen.";

/* ----------------------------------------------------------------------------
   Access.
   -------------------------------------------------------------------------- */

/** Workspace roles from the server's role catalog, with the escalation copy. */
export const WORKSPACE_ROLE_OPTIONS: RoleOption<WorkspaceRole>[] = workspaceRoles.map((role) => ({
  ...role,
  escalation:
    role.id === "workspace_admin"
      ? "They'll be able to change this workspace's settings, integrations and who has access."
      : undefined,
}));

export function accessMemberFor(
  person: Person,
  role: WorkspaceRole | "custom",
  viewer: Viewer,
): AccessMember<WorkspaceRole> {
  const pending = person.status === "invited" || person.status === "invite_failed";
  return {
    id: person.id,
    name: person.name,
    email: person.email,
    initials: person.initials,
    kind: person.kind,
    isYou: person.id === VIEWER_PERSON[viewer].id,
    isOwner: person.organizationRole === "owner",
    tag: person.organizationRole === "owner" ? "Organization owner" : undefined,
    status: pending ? person.status : undefined,
    statusLabel: pending ? person.statusLabel : undefined,
    role,
    // The access matrix reads roles per workspace; this page has one column.
    grants: { [currentWorkspace.id]: role },
  };
}

/** Who has access to Design preview today, as the viewer sees it. */
export function initialAccess(viewer: Viewer): AccessMember<WorkspaceRole>[] {
  return designPreviewAccess.map((entry) =>
    accessMemberFor(personById(entry.personId), entry.role, viewer),
  );
}

/** People in Acme Robotics who could be added to Design preview. */
export const ADD_CANDIDATE_IDS = [
  "person-jonas",
  "person-priya",
  "person-aiko",
  "person-tom",
] as const;

/* ----------------------------------------------------------------------------
   API keys. Timestamps pinned to KIT_NOW (Sat 26 Sep 2026, 13:48 Oslo).
   -------------------------------------------------------------------------- */

export interface PreviewApiKey extends ApiKey {
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Created in this preview, for the "Just created" highlight. */
  isNew?: boolean;
}

const KEY_DATES: Record<
  string,
  Pick<PreviewApiKey, "createdAt" | "lastUsedAt" | "expiresAt" | "revokedAt">
> = {
  "key-ci": {
    createdAt: "2026-06-18T08:12:00Z",
    lastUsedAt: "2026-09-26T09:48:00Z",
    expiresAt: null,
    revokedAt: null,
  },
  "key-terraform": {
    createdAt: "2026-09-24T13:05:00Z",
    lastUsedAt: null,
    expiresAt: "2027-03-31T10:00:00Z",
    revokedAt: null,
  },
  "key-staging-smoke": {
    createdAt: "2026-06-22T09:30:00Z",
    lastUsedAt: "2026-09-05T10:12:00Z",
    expiresAt: "2026-09-20T10:00:00Z",
    revokedAt: null,
  },
  "key-old-deploy": {
    createdAt: "2026-03-03T11:00:00Z",
    lastUsedAt: "2026-08-12T15:30:00Z",
    expiresAt: null,
    revokedAt: "2026-08-12T16:02:00Z",
  },
};

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20 Sep": the day a key stopped working, like "Revoked 12 Aug". */
function shortDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${SHORT_MONTHS[date.getUTCMonth()]}`;
}

export const INITIAL_API_KEYS: PreviewApiKey[] = apiKeys.map((key) => {
  const dates = KEY_DATES[key.id]!;
  return {
    ...key,
    ...dates,
    // An expired key says when, the same way a revoked one does.
    statusLabel:
      key.status === "expired" && dates.expiresAt
        ? `Expired ${shortDate(dates.expiresAt)}`
        : key.statusLabel,
  };
});

export function isLiveKey(key: PreviewApiKey): boolean {
  return key.status === "active";
}

/** Permissions a Custom key can pick, grouped the way people think about them. */
export const PERMISSION_GROUPS: Array<{ label: string; permissions: string[] }> = [
  { label: "Sessions", permissions: ["Read sessions", "Start sessions", "Send messages"] },
  { label: "Automation", permissions: ["Manage schedules", "Use variable sets"] },
  {
    label: "Files and knowledge",
    permissions: ["Read files", "Read and write files", "Read knowledge"],
  },
];

/** Today's create dialog (question 9 answered "No"): raw scopes, grouped as the API names them. */
export const RAW_SCOPE_GROUPS: Array<{ label: string; scopes: string[] }> = [
  {
    label: "Sessions",
    scopes: ["sessions:read", "sessions:create", "sessions:write", "stream:acknowledge"],
  },
  {
    label: "Automation",
    scopes: ["schedules:read", "schedules:write", "variable-sets:list", "variable-sets:use"],
  },
  { label: "Files and knowledge", scopes: ["files:read", "files:write", "knowledge:read"] },
  {
    label: "Workspace",
    scopes: ["workspace:read", "codemode:call", "mcp_servers:attach", "connections:read"],
  },
];

export const DEFAULT_RAW_SCOPES = ["sessions:read", "sessions:create", "sessions:write"];

export function presetPermissions(access: ApiKeyAccess): string[] {
  return apiKeyPresets.find((preset) => preset.id === access)?.permissions ?? [];
}

export function accessLabelFor(access: ApiKeyAccess, permissions: string[]): string {
  if (access === "custom") {
    return `Custom (${permissions.length} ${permissions.length === 1 ? "permission" : "permissions"})`;
  }
  const preset = apiKeyPresets.find((each) => each.id === access)!;
  return access === "run_sessions"
    ? `${preset.label} (${preset.permissions.length} permissions)`
    : preset.label;
}

/** Expiry choices with the date they land on, counted from KIT_NOW. */
export const EXPIRY_CHOICES: Array<{
  id: string;
  label: string;
  dateLabel: string | null;
  iso: string | null;
}> = [
  { id: "30d", label: "30 days", dateLabel: "26 Oct 2026", iso: "2026-10-26T11:48:00Z" },
  { id: "90d", label: "90 days", dateLabel: "25 Dec 2026", iso: "2026-12-25T11:48:00Z" },
  { id: "1y", label: "1 year", dateLabel: "26 Sep 2027", iso: "2027-09-26T11:48:00Z" },
  { id: "never", label: "Never", dateLabel: null, iso: null },
];

/** "ogk_7e21c9a0_…" style tokens for keys created in the preview. Fake. */
export function fakeToken(seed: number): { token: string; prefix: string } {
  const hex = (seed * 2654435761).toString(16).padStart(8, "0").slice(-8);
  return {
    token: `ogk_${hex}_example-token-shown-once-${hex.slice(0, 4)}q7`,
    prefix: `ogk_${hex}`,
  };
}
