/**
 * First run: the answer to "What do you do?" fills the person's OWN sidebar
 * once (docs/sidebar-layout.md, personal changes) with its preset's
 * suggestions (./presets, one file per answer). Never the workspace default:
 * everyone else's sidebar is unchanged, and the person can edit or reset
 * theirs as usual.
 *
 * The links open a ready-made agent's preview (Add leads to Enable), Enable
 * (components/enable) for a ready-made app, Get started for a setup, or
 * Connections, so nothing is added until the person turns it on.
 */
import type {
  NewSidebarItem,
  SidebarLayoutResponse,
  SidebarItemIcon,
  UpdateSidebarLayoutRequest,
} from "@opengeni/sdk";
import type { OnboardingUseCase } from "@opengeni/react/app/lib/onboarding-use-case";

import { NOT_AN_ENGINEER_PRESET } from "./presets/not-an-engineer";
import { SOFTWARE_ENGINEER_PRESET } from "./presets/software-engineer";
import type { PersonaPreset } from "./presets/types";

type SidebarClient = {
  getSidebarLayout(workspaceId: string): Promise<SidebarLayoutResponse>;
  updateSidebarLayout(
    workspaceId: string,
    request: UpdateSidebarLayoutRequest,
  ): Promise<SidebarLayoutResponse>;
};

/** The preset for each answer: "cloud" is Software engineer, "everyday" Not an engineer. */
export const PERSONA_PRESETS: Record<"cloud" | "everyday", PersonaPreset> = {
  cloud: SOFTWARE_ENGINEER_PRESET,
  everyday: NOT_AN_ENGINEER_PRESET,
};

type Suggestion = { label: string; path: string; icon: SidebarItemIcon };

/** "GitHub, Slack and Linear"; past three, "Slack, Google Drive and more" so it fits the rail. */
function listInWords(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length > 3) return `${names.slice(0, 2).join(", ")} and more`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A preset's links in sidebar order: setup, agents, apps, then one Connect link. */
export function presetSuggestions(preset: PersonaPreset): Suggestion[] {
  return [
    ...(preset.setup
      ? [
          {
            label: preset.setup.label,
            path: `get-started?setup=${encodeURIComponent(preset.setup.key)}`,
            icon: "git-pull-request",
          },
        ]
      : []),
    ...preset.agents.map((agent) => ({
      label: agent.label,
      path: `agents/ready-made/${encodeURIComponent(agent.key)}`,
      icon: agent.icon,
    })),
    ...preset.apps.map((app) => ({
      label: app.label,
      path: `enable?app=${encodeURIComponent(app.key)}`,
      icon: app.icon,
    })),
    ...(preset.connections.length > 0
      ? [
          {
            label: `Connect ${listInWords(preset.connections)}`,
            path: "plugins",
            icon: "link",
          },
        ]
      : []),
  ];
}

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
  const preset = PERSONA_PRESETS[useCase];
  const base = `${origin}/workspaces/${encodeURIComponent(workspaceId)}/`;
  return {
    type: "group",
    label: preset.group,
    icon: preset.icon,
    items: presetSuggestions(preset).map((item) => ({
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
