import { createRoot } from "react-dom/client";
import type { SkillRecord, SkillScope } from "@opengeni/sdk";
import type { AppContextValue } from "@opengeni/react/app/app-context";
import { SkillsPanelContent } from "../src/routes/skills-panel";
import "@opengeni/react/connect.css";
import "../src/styles.css";

// Development-only visual fixture: the console's Skills tab over an in-memory
// client. No API writes or credentials. `?role=member` shows a viewer.
const member = new URLSearchParams(window.location.search).get("role") === "member";
const workspaceId = "workspace";

function skill(scope: SkillScope, key: string, description: string, body: string): SkillRecord {
  const id = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  return {
    id,
    stableKey: key,
    scope,
    scopeVersion: 1,
    activationMode: "workspace_managed",
    pendingRevisionIds: [],
    status: "active",
    activeRevisionId: revisionId,
    revisionId,
    title: key,
    description,
    contentHash: "a".repeat(64),
    source: null,
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: ${key}\ndescription: ${description}\n---\n\n${body}\n`,
      },
    ],
  };
}

const store: SkillRecord[] = [
  skill("workspace", "release-notes", "Use when writing release notes.", "Group changes by area."),
  skill("user", "meeting-prep", "Use when preparing a meeting.", "Collect context first."),
  skill("organization", "incident-review", "Use for post-incident reviews.", "Blameless, short."),
];
const summary = ({ files: _files, ...rest }: SkillRecord) => rest;
const find = (id: string) => {
  const found = store.find((entry) => entry.id === id);
  if (!found) throw new Error("Skill not found");
  return found;
};

const context = {
  authSession: null,
  accessContext: {
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId,
        accountId: "account",
        principalKind: "human_session",
        permissions: member ? ["workspace:read"] : ["workspace:admin"],
      },
    ],
  },
  client: {
    async listWorkspaceSkills() {
      return { skills: store.map(summary) };
    },
    async readWorkspaceSkill(_workspaceId: string, id: string) {
      return find(id);
    },
    async getPreferenceRegistry() {
      return { revisions: [] };
    },
    async changePreferenceRegistryScope() {
      return {};
    },
    async saveWorkspaceSkill(
      _workspaceId: string,
      request: { skillId?: string; scope: SkillScope; files: SkillRecord["files"] },
    ) {
      const head = request.files.find((file) => file.path === "SKILL.md")?.content ?? "";
      const name = /name:\s*(.+)/.exec(head)?.[1]?.trim() ?? "skill";
      const description = /description:\s*(.+)/.exec(head)?.[1]?.trim() ?? "";
      const existing = request.skillId ? find(request.skillId) : null;
      const next = { ...skill(request.scope, name, description, ""), files: request.files };
      if (existing) Object.assign(existing, { ...next, id: existing.id });
      else store.push(next);
      return { skillId: existing?.id ?? next.id, outcome: "applied" };
    },
    async removeWorkspaceSkill(_workspaceId: string, id: string) {
      store.splice(store.indexOf(find(id)), 1);
      return { outcome: "applied" };
    },
  },
} as unknown as AppContextValue;

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-5xl p-6">
    <SkillsPanelContent context={context} workspaceId={workspaceId} />
  </main>,
);
