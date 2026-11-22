import type { SkillSummary } from "@opengeni/sdk";
import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import { useState } from "react";

import { CapabilitiesRoute } from "@/routes/capabilities";

import { currentWorkspace } from "../fixtures";
import { KitBlock, KitSection, PagePreview } from "../kit";

/* ----------------------------------------------------------------------------
   The production Capabilities page on its Skills tab, with a long list of
   skills of every owner. Only the SDK transport is replaced: the Skills list
   filters by scope like the server does; everything else answers empty.
   -------------------------------------------------------------------------- */

const WORKSPACE_ID = currentWorkspace.id;

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

const TITLES: Record<SkillSummary["scope"], string[]> = {
  user: [
    "My writing style",
    "Standup notes",
    "Shorter replies",
    "Weekly review",
    "Travel planning",
    "Reading list",
    "Email triage",
    "Meeting prep",
  ],
  workspace: [
    "Release checklist",
    "Incident response",
    "Customer onboarding",
    "Changelog writing",
    "Support macros",
    "Pricing questions",
    "Sales call notes",
    "Bug triage",
    "Design review",
    "Data exports",
    "Grant applications",
    "Hiring loop",
    "Invoice follow-up",
  ],
  organization: [
    "Security review",
    "Brand voice",
    "Legal review",
    "Accessibility check",
    "Privacy requests",
    "Vendor review",
    "Expense policy",
    "Travel policy",
    "Code style",
    "PDF tools",
  ],
};

const SKILLS: SkillSummary[] = (Object.keys(TITLES) as SkillSummary["scope"][]).flatMap((scope) =>
  TITLES[scope].map((title) => {
    const stableKey = title.toLowerCase().replaceAll(" ", "-");
    return {
      ...base,
      id: `${scope}-${stableKey}`,
      stableKey,
      title,
      scope,
      ...(scope === "organization"
        ? { reach: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true } }
        : {}),
    };
  }),
);

/** Any value a list call might read: lists are empty, everything else is unset. */
const EMPTY: unknown = new Proxy([], {
  get(target, key, receiver) {
    if (key in target || typeof key === "symbol") return Reflect.get(target, key, receiver);
    return /s$/.test(key) ? EMPTY : undefined;
  },
});

function previewContext(): AppContextValue {
  const client = new Proxy(
    {
      listWorkspaceSkills: async (_workspaceId: string, options: { scope?: string } = {}) => ({
        skills: SKILLS.filter((skill) => !options.scope || skill.scope === options.scope),
        nextCursor: null,
      }),
    } as Record<string, unknown>,
    {
      get: (target, key) =>
        typeof key === "string" && !(key in target) ? async () => EMPTY : target[key as string],
    },
  );
  return {
    client,
    authSession: null,
    clientConfig: {},
    workspaces: [currentWorkspace],
    accessContext: {
      subjectId: "user:preview",
      accountGrants: [{ accountId: "account", permissions: [] }],
      workspaceGrants: [
        {
          accountId: "account",
          workspaceId: WORKSPACE_ID,
          subjectId: "user:preview",
          principalKind: "human_session",
          permissions: ["workspace:read", "documents:manage", "connections:read"],
        },
      ],
    },
    refreshWorkspaceMcpServers: async () => undefined,
    githubStatus: null,
    githubStatusFailed: false,
    repoBusy: false,
  } as unknown as AppContextValue;
}

function CapabilitiesSkillsPreview() {
  const [context] = useState(previewContext);
  return (
    <AppContext.Provider value={context}>
      <CapabilitiesRoute workspaceId={WORKSPACE_ID} initialSection="skills" />
    </AppContext.Provider>
  );
}

export default function PageSkillsSection() {
  return (
    <KitSection sectionKey="page-skills">
      <KitBlock
        title="Capabilities: Skills, by whose"
        description="The Skills tab of Capabilities with a long list. Next to the search: All, Yours, Workspace or Organization. The list is paged, so the server filters."
      >
        <PagePreview label="Capabilities, Skills" height={820}>
          <CapabilitiesSkillsPreview />
        </PagePreview>
      </KitBlock>
    </KitSection>
  );
}
