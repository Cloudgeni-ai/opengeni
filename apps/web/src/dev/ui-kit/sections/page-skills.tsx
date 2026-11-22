import type { SkillSummary } from "@opengeni/sdk";
import type { AppContextValue } from "@opengeni/react/app/app-context";
import { SelectMenu } from "@opengeni/react/ui/select-menu";
import { Toolbar, ToolbarSearch } from "@opengeni/react/ui/toolbar";
import { useMemo, useState } from "react";

import {
  SKILL_OWNER_FILTER_OPTIONS,
  SkillsPanelContent,
  type SkillOwnerFilter,
} from "@/routes/skills-panel";

import { KitBlock, KitSection, PagePreview } from "../kit";

const base: Omit<SkillSummary, "id" | "stableKey" | "title" | "scope"> = {
  description: null,
  scopeVersion: 1,
  activationMode: "workspace_managed",
  status: "active",
  activeRevisionId: "revision",
  revisionId: "revision",
  pendingRevisionIds: [],
  contentHash: null,
  source: null,
};

const SKILLS: SkillSummary[] = [
  {
    ...base,
    id: "s1",
    stableKey: "release-checklist",
    title: "Release checklist",
    scope: "workspace",
  },
  { ...base, id: "s2", stableKey: "my-writing-style", title: "My writing style", scope: "user" },
  {
    ...base,
    id: "s3",
    stableKey: "security-review",
    title: "Security review",
    scope: "organization",
    reach: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
  },
  {
    ...base,
    id: "s4",
    stableKey: "pdf-tools",
    title: "PDF tools",
    scope: "workspace",
    source: { pluginId: "plugin", facetKey: "pdf", skillFacetId: "facet" },
  },
  { ...base, id: "s5", stableKey: "standup-notes", title: "Standup notes", scope: "user" },
];

function previewContext(): AppContextValue {
  return {
    authSession: null,
    clientConfig: {},
    accessContext: {
      accountGrants: [{ accountId: "account", permissions: [] }],
      workspaceGrants: [
        {
          accountId: "account",
          workspaceId: "workspace",
          subjectId: "user:preview",
          principalKind: "human_session",
          permissions: ["workspace:read", "documents:manage"],
        },
      ],
    },
    client: {
      // The server filters; the preview does the same with the same options.
      listWorkspaceSkills: async (
        _workspaceId: string,
        options: { scope?: string; installed?: boolean } = {},
      ) => ({
        skills: SKILLS.filter(
          (skill) =>
            (!options.scope || skill.scope === options.scope) &&
            (!options.installed || skill.source !== null),
        ),
        nextCursor: null,
      }),
    },
  } as unknown as AppContextValue;
}

function SkillsPreview({ initial = "all" }: { initial?: SkillOwnerFilter }) {
  const context = useMemo(previewContext, []);
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState<SkillOwnerFilter>(initial);
  return (
    <div className="p-6">
      <Toolbar>
        <ToolbarSearch value={query} onValueChange={setQuery} placeholder="Search skills" />
        <SelectMenu
          aria-label="Whose skills"
          size="md"
          className="w-40"
          align="end"
          options={SKILL_OWNER_FILTER_OPTIONS}
          value={owner}
          onValueChange={setOwner}
        />
      </Toolbar>
      <div className="pt-6">
        <SkillsPanelContent context={context} workspaceId="workspace" query={query} owner={owner} />
      </div>
    </div>
  );
}

export default function PageSkillsSection() {
  return (
    <KitSection sectionKey="page-skills">
      <KitBlock
        title="Skills: whose"
        description="Capabilities > Skills. One filter next to the search: All, Mine, Workspace, Organization or From plugins. The list is paged, so the server filters."
      >
        <PagePreview label="Skills, all" height={560}>
          <SkillsPreview />
        </PagePreview>
      </KitBlock>
      <KitBlock title="Skills: Mine" description="Only the person's own skills.">
        <PagePreview label="Skills, mine" height={420}>
          <SkillsPreview initial="mine" />
        </PagePreview>
      </KitBlock>
    </KitSection>
  );
}
