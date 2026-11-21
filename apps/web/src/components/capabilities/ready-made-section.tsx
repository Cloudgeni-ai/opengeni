import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { agentInitialsAvatar, type AgentTemplate, type AppTemplate } from "@opengeni/contracts";
import type { CapabilityCatalogItem } from "@opengeni/react/app/types";
import { CapabilityCatalogRow, type CapabilityCatalogStatus } from "@opengeni/react/connect";
import "@opengeni/react/connect.css";
import { useAppContext } from "@opengeni/react/app/app-context";
import { SessionAvatar } from "@opengeni/react/app/components/session/session-avatar";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { SECTION_TITLE_CLASS } from "@opengeni/react/ui/section";
import { cn } from "@opengeni/react/app/lib/utils";
import type { ReadyMadeKind } from "./capabilities-section";

/** Content without a team goes last, under this heading. */
const NO_TEAM = "More";

export type ReadyMadeEntry = {
  key: string;
  kind: ReadyMadeKind;
  name: string;
  description: string;
  team: string | null;
  icon: ReactNode;
  /** Already here: the row opens it instead of adding it again. */
  added: boolean;
  /** Why it can't be added by this person, when it can't. */
  unavailable?: string | undefined;
};

const KIND_LABEL: Record<ReadyMadeEntry["kind"], string> = {
  agent: "Agent",
  app: "App",
  skill: "Skill",
};

/**
 * Ready-made content grouped by the team it is for. The teams come from each
 * entry's own `team`, in alphabetical order, and entries without one last.
 */
export function readyMadeGroups(
  entries: readonly ReadyMadeEntry[],
  query = "",
  kind?: ReadyMadeKind,
): { team: string; entries: ReadyMadeEntry[] }[] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, ReadyMadeEntry[]>();
  for (const entry of entries) {
    if (kind && entry.kind !== kind) continue;
    const haystack = `${entry.name} ${entry.description} ${entry.team ?? ""} ${KIND_LABEL[entry.kind]}`;
    if (needle && !haystack.toLowerCase().includes(needle)) continue;
    const team = entry.team?.trim() || NO_TEAM;
    groups.set(team, [...(groups.get(team) ?? []), entry]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) =>
      a === NO_TEAM
        ? 1
        : b === NO_TEAM
          ? -1
          : a.localeCompare(b, undefined, { sensitivity: "base" }),
    )
    .map(([team, grouped]) => ({ team, entries: grouped }));
}

function metadataString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The Ready-made tab: ready-made agents, apps and skills, each added with one
 * click. An added agent or app opens; an added skill opens in Skills.
 */
export function ReadyMadeSection({
  workspaceId,
  query,
  kind,
  items,
  canInstallSkills,
  onSkillAdded,
}: {
  workspaceId: string;
  query: string;
  /** Only this kind (`?kind=` of the tab), for example agents from the Agents page. */
  kind?: ReadyMadeKind | undefined;
  /** The capability catalog, for the reviewed library skills. */
  items: readonly CapabilityCatalogItem[];
  canInstallSkills: boolean;
  onSkillAdded: () => Promise<void>;
}) {
  const { client } = useAppContext();
  const navigate = useNavigate();
  const [agentTemplates, setAgentTemplates] = useState<AgentTemplate[] | null>(null);
  const [appTemplates, setAppTemplates] = useState<AppTemplate[] | null>(null);
  // Ready-made agents already added here, to the agent they became.
  const [addedAgents, setAddedAgents] = useState<ReadonlyMap<string, string>>(new Map());
  // Apps added from here in this visit, to the app they became.
  const [addedApps, setAddedApps] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([
      client.listAgentTemplates(workspaceId).catch(() => []),
      client.listAgents(workspaceId).catch(() => []),
      client.listAppTemplates(workspaceId).catch(() => []),
    ]).then(([templates, agents, apps]) => {
      if (!live) return;
      setAgentTemplates(templates);
      setAddedAgents(
        new Map(
          agents.flatMap((agent) => (agent.templateKey ? [[agent.templateKey, agent.id]] : [])),
        ),
      );
      setAppTemplates(apps);
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  const librarySkills = useMemo(
    () => items.filter((item) => item.kind === "skill" && item.source === "library"),
    [items],
  );

  const entries: ReadyMadeEntry[] = useMemo(
    () => [
      ...(agentTemplates ?? []).map((template) => ({
        key: `agent:${template.key}`,
        kind: "agent" as const,
        name: template.name,
        description: template.description,
        team: template.team,
        icon: (
          <SessionAvatar
            avatar={template.avatar ?? agentInitialsAvatar(template.name, template.key)}
            name={template.name}
            workspaceId={workspaceId}
            seed={template.key}
            size="md"
          />
        ),
        added: addedAgents.has(template.key),
      })),
      ...(appTemplates ?? []).map((template) => ({
        key: `app:${template.key}`,
        kind: "app" as const,
        name: template.name,
        description: template.description,
        team: template.team,
        icon: <LogoTile name={template.name} />,
        added: addedApps.has(template.key),
      })),
      ...librarySkills.map((item) => ({
        key: `skill:${item.id}`,
        kind: "skill" as const,
        name: item.name,
        description: item.description ?? "",
        team: metadataString(item.metadata.team),
        icon: <LogoTile name={item.name} />,
        added: item.enabled,
        unavailable: canInstallSkills ? undefined : "Ask an admin to add skills",
      })),
    ],
    [
      agentTemplates,
      appTemplates,
      librarySkills,
      addedAgents,
      addedApps,
      canInstallSkills,
      workspaceId,
    ],
  );

  const open = (entry: ReadyMadeEntry) => {
    const [, key] = entry.key.split(/:(.*)/su) as [string, string];
    if (entry.kind === "agent") {
      const agentId = addedAgents.get(key);
      if (agentId) {
        void navigate({
          to: "/workspaces/$workspaceId/agents/$agentId",
          params: { workspaceId, agentId },
        });
      }
    } else if (entry.kind === "app") {
      const appId = addedApps.get(key);
      if (appId) {
        void navigate({
          to: "/workspaces/$workspaceId/artifacts/$artifactId",
          params: { workspaceId, artifactId: appId },
        });
      }
    } else {
      void navigate({
        to: "/workspaces/$workspaceId/plugins",
        params: { workspaceId },
        search: { section: "skills" },
      });
    }
  };

  const add = async (entry: ReadyMadeEntry) => {
    const [, key] = entry.key.split(/:(.*)/su) as [string, string];
    setBusy(entry.key);
    try {
      if (entry.kind === "agent") {
        // The same add path as the Agents page.
        const agent = await client.createAgentFromTemplate(workspaceId, key);
        setAddedAgents((current) => new Map(current).set(key, agent.id));
      } else if (entry.kind === "app") {
        const template = appTemplates?.find((each) => each.key === key);
        if (!template) return;
        const installed = await client.installAppPackage(workspaceId, {
          package: template.package,
          idempotencyKey: crypto.randomUUID(),
        });
        setAddedApps((current) => new Map(current).set(key, installed.app.id));
      } else {
        const item = librarySkills.find((each) => each.id === key);
        const libraryId = metadataString(item?.metadata.libraryId);
        const expectedVersion = metadataString(item?.metadata.version);
        const expectedContentSha256 = metadataString(item?.metadata.contentSha256);
        if (!libraryId || !expectedVersion || !expectedContentSha256) {
          throw new Error("This skill is missing its reviewed version. Refresh and try again.");
        }
        const installed = await client.installLibrarySkill(workspaceId, libraryId, {
          expectedVersion,
          expectedContentSha256,
        });
        await onSkillAdded();
        if (installed.skillReceipt?.outcome === "pending") {
          toast.message(`${entry.name} is waiting for review`);
          return;
        }
      }
      toast.success(`Added ${entry.name}`);
    } catch (error) {
      toast.error(`Couldn't add ${entry.name}`, { description: userErrorText(error) });
    } finally {
      setBusy(null);
    }
  };

  if (agentTemplates === null || appTemplates === null) {
    return (
      <p role="status" className="text-sm text-fg-muted">
        Loading…
      </p>
    );
  }
  const groups = readyMadeGroups(entries, query, kind);
  if (groups.length === 0) {
    return (
      <p role="status" className="text-sm text-fg-muted">
        {query.trim() ? `Nothing in Ready-made matches "${query.trim()}".` : "Nothing to add yet."}
      </p>
    );
  }
  return (
    <div className="grid gap-8">
      {groups.map((group) => (
        <section key={group.team} aria-label={group.team}>
          <h2 className={cn(SECTION_TITLE_CLASS, "mb-2")}>{group.team}</h2>
          <div className="og-connection-catalog" data-columns="2">
            {group.entries.map((entry) => {
              const status: CapabilityCatalogStatus =
                busy === entry.key
                  ? "loading"
                  : entry.added
                    ? "added"
                    : entry.unavailable
                      ? "unavailable"
                      : "available";
              return (
                <CapabilityCatalogRow
                  key={entry.key}
                  data-ready-made-entry={entry.key}
                  name={entry.name}
                  icon={entry.icon}
                  status={status}
                  statusLabel={
                    entry.added
                      ? "Added"
                      : entry.unavailable && busy !== entry.key
                        ? entry.unavailable
                        : `Add ${entry.name}`
                  }
                  {...(entry.added
                    ? { statusLine: `Added · ${KIND_LABEL[entry.kind]}` }
                    : { description: `${KIND_LABEL[entry.kind]} · ${entry.description}` })}
                  disabled={busy !== null || (!entry.added && Boolean(entry.unavailable))}
                  title={entry.description}
                  onOpen={() => void (entry.added ? open(entry) : add(entry))}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
