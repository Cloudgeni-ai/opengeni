import { AppWindowIcon, GraduationCapIcon } from "lucide-react";
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
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { LoadErrorState } from "@opengeni/react/app/components/common";
import type { ReadyMadeKind } from "./capabilities-section";

function isForbidden(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 403;
}

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
): { key: string; team: string; entries: ReadyMadeEntry[] }[] {
  const needle = query.trim().toLowerCase();
  // Keyed by team, with `null` for no team, so a team named like the
  // no-team heading still gets its own group.
  const groups = new Map<string | null, ReadyMadeEntry[]>();
  for (const entry of entries) {
    if (kind && entry.kind !== kind) continue;
    const haystack = `${entry.name} ${entry.description} ${entry.team ?? ""} ${KIND_LABEL[entry.kind]}`;
    if (needle && !haystack.toLowerCase().includes(needle)) continue;
    const team = entry.team?.trim() || null;
    groups.set(team, [...(groups.get(team) ?? []), entry]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) =>
      a === null ? 1 : b === null ? -1 : a.localeCompare(b, undefined, { sensitivity: "base" }),
    )
    .map(([team, grouped]) => ({ key: team ?? "", team: team ?? NO_TEAM, entries: grouped }));
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
  canInstallSkills,
  onSkillAdded,
}: {
  workspaceId: string;
  query: string;
  /** Only this kind (`?kind=` of the tab), for example agents from the Agents page. */
  kind?: ReadyMadeKind | undefined;
  canInstallSkills: boolean;
  onSkillAdded: () => Promise<void>;
}) {
  const { client, accessContext } = useAppContext();
  const navigate = useNavigate();
  const canAddAgents = hasWorkspacePermission(accessContext, workspaceId, "sessions:create");
  const canAddApps = hasWorkspacePermission(accessContext, workspaceId, "artifacts:publish");
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [partlyLoaded, setPartlyLoaded] = useState(false);
  const [agentTemplates, setAgentTemplates] = useState<AgentTemplate[] | null>(null);
  const [appTemplates, setAppTemplates] = useState<AppTemplate[] | null>(null);
  const [librarySkills, setLibrarySkills] = useState<CapabilityCatalogItem[] | null>(null);
  // Whether the workspace's agents loaded, so an added agent isn't offered again.
  const [agentsKnown, setAgentsKnown] = useState(true);
  // Ready-made agents already added here, to the agent they became.
  const [addedAgents, setAddedAgents] = useState<ReadonlyMap<string, string>>(new Map());
  // Apps added from here, to the app they became. Adding again replays the
  // same install, so an app added before a reload opens instead of doubling.
  const [addedApps, setAddedApps] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    setPartlyLoaded(false);
    // Each kind loads on its own, so one failure (or a missing permission)
    // leaves the other kinds usable.
    void Promise.allSettled([
      client.listAgentTemplates(workspaceId),
      client.listAgents(workspaceId),
      client.listAppTemplates(workspaceId),
      client.listLibrarySkills(workspaceId),
    ]).then(([templates, agents, apps, skills]) => {
      if (!live) return;
      const kinds = [templates, apps, skills];
      // A kind this person may not read (403) isn't offered; it hasn't failed.
      const failed = kinds.filter(
        (result) => result.status === "rejected" && !isForbidden(result.reason),
      );
      if (failed.length > 0 && failed.length === kinds.length) {
        const reason = (failed[0] as PromiseRejectedResult).reason;
        setLoadError(reason instanceof Error ? reason : new Error(String(reason)));
        return;
      }
      setPartlyLoaded(failed.length > 0);
      setAgentTemplates(templates.status === "fulfilled" ? templates.value : []);
      // Only marks what is already added.
      setAgentsKnown(agents.status === "fulfilled");
      setAddedAgents(
        new Map(
          (agents.status === "fulfilled" ? agents.value : []).flatMap((agent) =>
            agent.templateKey ? [[agent.templateKey, agent.id]] : [],
          ),
        ),
      );
      setAppTemplates(apps.status === "fulfilled" ? apps.value : []);
      setLibrarySkills(skills.status === "fulfilled" ? skills.value : []);
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, loadRevision]);

  const entries: ReadyMadeEntry[] = useMemo(
    () => [
      ...(agentTemplates ?? []).map((template) => ({
        key: `agent:${template.key}`,
        kind: "agent" as const,
        name: template.name,
        description: template.description,
        team: template.team ?? null,
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
        unavailable: !canAddAgents
          ? "Ask an admin to add agents"
          : agentsKnown
            ? undefined
            : "Couldn't check your agents. Retry to add.",
      })),
      ...(appTemplates ?? []).map((template) => ({
        key: `app:${template.key}`,
        kind: "app" as const,
        name: template.name,
        description: template.description,
        team: template.team,
        icon: <LogoTile name={template.name} icon={<AppWindowIcon />} />,
        added: addedApps.has(template.key),
        unavailable: canAddApps ? undefined : "Ask an admin to add apps",
      })),
      ...(librarySkills ?? []).map((item) => ({
        key: `skill:${item.id}`,
        kind: "skill" as const,
        name: item.name,
        description: item.description ?? "",
        team: metadataString(item.metadata.team),
        icon: <LogoTile name={item.name} icon={<GraduationCapIcon />} />,
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
      canAddAgents,
      canAddApps,
      agentsKnown,
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
        // One key per ready-made app: adding it again returns the same app,
        // unless that app was archived, then it's added fresh.
        let installed = await client.installAppPackage(workspaceId, {
          package: template.package,
          idempotencyKey: `ready-made:${template.key}`,
        });
        // Each archived copy keys the next one, so adding again finds the live copy.
        for (
          let hops = 0;
          installed.replayed && installed.app.status !== "active" && hops < 20;
          hops += 1
        ) {
          installed = await client.installAppPackage(workspaceId, {
            package: template.package,
            idempotencyKey: `ready-made:${template.key}:after:${installed.app.id}`,
          });
        }
        setAddedApps((current) => new Map(current).set(key, installed.app.id));
        if (installed.notInstalled.length > 0) {
          toast.warning(`${entry.name} was added without some parts`, {
            description: installed.notInstalled.map((problem) => problem.reason).join(" "),
          });
          return;
        }
        if (installed.replayed) {
          void navigate({
            to: "/workspaces/$workspaceId/artifacts/$artifactId",
            params: { workspaceId, artifactId: installed.app.id },
          });
          return;
        }
      } else {
        const item = librarySkills?.find((each) => each.id === key);
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
        setLibrarySkills(
          (current) =>
            current?.map((each) => (each.id === key ? { ...each, enabled: true } : each)) ?? null,
        );
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

  if (loadError) {
    return (
      <LoadErrorState
        title="Couldn't load ready-made content"
        error={loadError}
        onRetry={() => setLoadRevision((value) => value + 1)}
      />
    );
  }
  if (agentTemplates === null || appTemplates === null || librarySkills === null) {
    return (
      <p role="status" className="text-sm text-fg-muted">
        Loading…
      </p>
    );
  }
  const groups = readyMadeGroups(entries, query, kind);
  const partial = partlyLoaded ? (
    <p role="status" className="text-sm text-fg-muted">
      Some of it couldn't load.{" "}
      <button
        type="button"
        className="font-medium text-fg underline-offset-2 hover:underline"
        onClick={() => setLoadRevision((value) => value + 1)}
      >
        Retry
      </button>
    </p>
  ) : null;
  if (groups.length === 0) {
    return (
      <div className="grid gap-3">
        {partial}
        <p role="status" className="text-sm text-fg-muted">
          {query.trim()
            ? `Nothing in Ready-made matches "${query.trim()}".`
            : "Nothing to add yet."}
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-8">
      {partial}
      {groups.map((group) => (
        <section key={group.key} aria-label={group.team}>
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
