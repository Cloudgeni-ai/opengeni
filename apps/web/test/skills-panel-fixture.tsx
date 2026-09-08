import { createRoot } from "react-dom/client";
import type { SkillRecord } from "@opengeni/sdk";
import type { AppContextValue } from "../src/context";
import { SkillsPanelContent } from "../src/routes/skills-panel";
import "../src/styles.css";

let record: SkillRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  stableKey: "release-checks",
  scope: "workspace",
  scopeVersion: 1,
  activationMode: "workspace_managed",
  pendingRevisionIds: [],
  status: "active",
  activeRevisionId: "22222222-2222-4222-8222-222222222222",
  revisionId: "22222222-2222-4222-8222-222222222222",
  title: "Release checks",
  description: "Verify a release before publishing it.",
  contentHash: "a".repeat(64),
  source: null,
  files: [
    {
      path: "SKILL.md",
      content:
        "---\nname: release-checks\ndescription: Verify a release before publishing it.\n---\n\n# Release checks\n\nRead references/checklist.md before publishing.\n",
    },
    {
      path: "references/checklist.md",
      content: "# Checklist\n\n- Run the targeted tests.\n- Check the release notes.\n",
    },
  ],
};
const context = {
  authSession: null,
  accessContext: {
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId: "fixture",
        accountId: "fixture",
        principalKind: "human_session",
        permissions: ["workspace:admin"],
      },
    ],
  },
  client: {
    async listWorkspaceSkills() {
      return { skills: [record] };
    },
    async readWorkspaceSkill() {
      return record;
    },
    async getPreferenceRegistry() {
      return { revisions: [] };
    },
    async saveWorkspaceSkill(
      _workspaceId: string,
      request: {
        files: SkillRecord["files"];
        title: string;
        description: string;
        operationId: string;
      },
    ) {
      record = {
        ...record,
        files: request.files,
        title: request.title,
        description: request.description,
      };
      return {
        skillId: record.id,
        revisionId: record.revisionId,
        operationId: request.operationId,
        outcome: "applied",
        replayed: false,
      };
    },
  },
} as unknown as AppContextValue;
createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-background p-8 text-fg">
    <div className="mx-auto max-w-4xl">
      <SkillsPanelContent context={context} workspaceId="fixture" />
    </div>
  </main>,
);
