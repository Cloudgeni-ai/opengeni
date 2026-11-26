/**
 * First run: the answer to "What do you do?" fills the person's OWN sidebar
 * once (docs/sidebar-layout.md, personal changes), with suggested apps and
 * one suggested setup. Never the workspace default: everyone else's sidebar
 * is unchanged, and the person can edit or reset theirs as usual.
 *
 * The links open Enable (components/enable) for a ready-made app or Get
 * started for a setup, so nothing is added until the person turns it on.
 */
import type {
  NewSidebarItem,
  SidebarLayoutResponse,
  UpdateSidebarLayoutRequest,
} from "@opengeni/sdk";
import type { OnboardingUseCase } from "@opengeni/react/app/lib/onboarding-use-case";

type SidebarClient = {
  getSidebarLayout(workspaceId: string): Promise<SidebarLayoutResponse>;
  updateSidebarLayout(
    workspaceId: string,
    request: UpdateSidebarLayoutRequest,
  ): Promise<SidebarLayoutResponse>;
};

type Suggestion = { label: string; path: string; icon: string };

/** What each answer suggests: two ready-made apps and one setup. */
export const PERSONA_SUGGESTIONS: Record<
  "cloud" | "everyday",
  { group: string; icon: string; items: readonly Suggestion[] }
> = {
  cloud: {
    group: "Engineering",
    icon: "code",
    items: [
      {
        label: "Set up PR reviews",
        path: "get-started?setup=pr-reviews",
        icon: "git-pull-request",
      },
      { label: "Issue tracker", path: "enable?app=issue-tracker", icon: "list-checks" },
      { label: "Incident log", path: "enable?app=incident-log", icon: "shield-check" },
    ],
  },
  everyday: {
    group: "Your work",
    icon: "briefcase",
    items: [
      {
        label: "Weekly product report",
        path: "get-started?setup=product-analytics",
        icon: "chart-line",
      },
      { label: "Decision log", path: "enable?app=decision-log", icon: "notebook-pen" },
      { label: "Feedback board", path: "enable?app=feedback-board", icon: "megaphone" },
    ],
  },
};

/**
 * The one group a first answer adds to the person's own sidebar; null for an
 * answer with no suggestions, or where links can't be https (local dev).
 */
export function personaSidebarGroup(
  useCase: OnboardingUseCase,
  { origin, workspaceId }: { origin: string; workspaceId: string },
): NewSidebarItem | null {
  if (useCase !== "cloud" && useCase !== "everyday") return null;
  if (!origin.startsWith("https://")) return null;
  const preset = PERSONA_SUGGESTIONS[useCase];
  const base = `${origin}/workspaces/${encodeURIComponent(workspaceId)}/`;
  return {
    type: "group",
    label: preset.group,
    icon: preset.icon,
    items: preset.items.map((item) => ({
      type: "link" as const,
      label: item.label,
      url: `${base}${item.path}`,
      icon: item.icon,
    })),
  };
}

/**
 * Adds the answer's group to the person's own sidebar, once: only while they
 * have a sidebar of their own they haven't changed, and only at the revision
 * just read, so it never lands on top of their own changes or twice.
 */
export async function applyPersonaSidebar(
  client: SidebarClient,
  workspaceId: string,
  useCase: OnboardingUseCase,
  origin: string,
): Promise<"applied" | "skipped"> {
  const group = personaSidebarGroup(useCase, { origin, workspaceId });
  if (!group) return "skipped";
  const layout = await client.getSidebarLayout(workspaceId);
  if (!layout.personal.available || layout.personal.customized) return "skipped";
  await client.updateSidebarLayout(workspaceId, {
    scope: "personal",
    expectedRevision: layout.personal.revision,
    changes: [{ op: "add", item: group, index: 0 }],
  });
  return "applied";
}
