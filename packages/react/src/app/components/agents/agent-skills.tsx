/**
 * The agent page's Skills (docs/agents.md): the Skills it relies on, each by
 * its name and linked to its page, and one searchable list to add another.
 * A display note only: every Skill stays available to every chat.
 */
import { useEffect, useMemo, useState } from "react";
import { XIcon } from "lucide-react";
import type { Agent, AgentSkillRef, SkillSummary } from "@opengeni/sdk";

import { Button } from "../../../ui/button";
import { DetailSection } from "../../../ui/detail-sheet";
import { SelectMenu } from "../../../ui/select-menu";
import { SettingRow } from "../../../ui/setting-row";
import { useAppContext } from "../../app-context";
import { useNavigate } from "../../lib/navigation";
import { skillDisplayName, skillShortDescription } from "../../lib/skill-names";

/** A chosen Skill as people see it: its catalog entry when one matches. */
export interface AgentSkillChoice {
  /** The stored reference. */
  ref: string;
  name: string;
  description: string | null;
  /** The Skill it opens, or null when none in this workspace matches. */
  skillId: string | null;
}

const normal = (value: string) => value.trim().toLowerCase();

/**
 * The catalog entry a stored reference names: by key (what this page saves),
 * else by title (what ready-made agents and older saves may use). Skills that
 * work here win over ones that don't.
 */
export function findAgentSkill(
  ref: string,
  catalog: readonly SkillSummary[],
): SkillSummary | undefined {
  const wanted = normal(ref);
  const matches = [
    (skill: SkillSummary) => skill.stableKey === ref,
    (skill: SkillSummary) => normal(skill.stableKey) === wanted,
    (skill: SkillSummary) => !!skill.title && normal(skill.title) === wanted,
    (skill: SkillSummary) => normal(skillDisplayName(skill)) === wanted,
  ];
  for (const match of matches) {
    const found = catalog.filter(match);
    const best = found.find((skill) => skill.availableHere !== false) ?? found[0];
    if (best) return best;
  }
  return undefined;
}

/** Each reference resolved to a name, description and Skill to open. */
export function agentSkillChoices(
  refs: readonly AgentSkillRef[],
  catalog: readonly SkillSummary[] | null,
): AgentSkillChoice[] {
  return refs.map(({ name: ref }) => {
    const skill = catalog ? findAgentSkill(ref, catalog) : undefined;
    return skill
      ? {
          ref,
          name: skillDisplayName(skill),
          description: skillShortDescription(skill.description),
          skillId: skill.id,
        }
      : {
          ref,
          name: skillDisplayName({ title: null, stableKey: ref }),
          description: null,
          skillId: null,
        };
  });
}

/** The Skill's own page under Plugins. */
export function agentSkillHref(workspaceId: string, skillId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/plugins?section=skills&open=${encodeURIComponent(`skill:${skillId}`)}`;
}

/** Every page of the workspace's own and installed Skills. */
async function readCatalog(
  list: (options: {
    cursor?: string;
    limit?: number;
  }) => Promise<{ skills: SkillSummary[]; nextCursor: string | null }>,
): Promise<SkillSummary[]> {
  const skills: SkillSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const response: { skills: SkillSummary[]; nextCursor: string | null } = await list({
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    skills.push(...response.skills);
    cursor = response.nextCursor;
    if (!cursor) break;
  }
  return skills;
}

export function AgentSkills({
  agent,
  workspaceId,
  onSaved,
  onError,
}: {
  agent: Agent;
  workspaceId: string;
  onSaved: (agent: Agent) => void;
  onError: (error: unknown) => void;
}) {
  const { client } = useAppContext();
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<SkillSummary[] | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    // The workspace's own and installed Skills; Opengeni's built-in ones are not listed.
    readCatalog((options) => client.listWorkspaceSkills(workspaceId, options)).then(
      (skills) => live && setCatalog(skills),
      () => live && setCatalog([]),
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  const save = async (skills: AgentSkillRef[]) => {
    setSaving(true);
    try {
      onSaved(
        await client.updateAgent(workspaceId, agent.id, { expectedVersion: agent.version, skills }),
      );
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };
  const chosen = useMemo(() => agentSkillChoices(agent.skills, catalog), [agent.skills, catalog]);
  const options = useMemo(() => {
    const taken = new Set(chosen.flatMap((choice) => (choice.skillId ? [choice.skillId] : [])));
    const refs = new Set(agent.skills.map((skill) => skill.name));
    return (catalog ?? [])
      .filter(
        (skill) =>
          skill.availableHere !== false && !taken.has(skill.id) && !refs.has(skill.stableKey),
      )
      .map((skill) => ({
        value: skill.stableKey,
        label: skillDisplayName(skill),
        description: skillShortDescription(skill.description) ?? undefined,
        keywords: [skill.stableKey, ...(skill.title ? [skill.title] : [])],
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [agent.skills, catalog, chosen]);
  const open = (href: string) => void navigate({ href });
  return (
    <DetailSection title="Skills">
      {chosen.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">
          Every Skill in the workspace is available. Add the ones it relies on.
        </p>
      ) : null}
      {chosen.map((choice) => {
        const href = choice.skillId ? agentSkillHref(workspaceId, choice.skillId) : null;
        return (
          <SettingRow
            key={choice.ref}
            data-agent-skill={choice.ref}
            label={
              href ? (
                <a
                  href={href}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
                      return;
                    }
                    event.preventDefault();
                    open(href);
                  }}
                  className="rounded-[4px] text-fg underline decoration-fg/25 underline-offset-2 hover:decoration-fg"
                >
                  {choice.name}
                </a>
              ) : (
                choice.name
              )
            }
            description={
              catalog !== null && !choice.skillId ? (
                "Not in this workspace."
              ) : choice.description ? (
                <span className="line-clamp-1">{choice.description}</span>
              ) : undefined
            }
            control={
              agent.viewer.canEdit ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${choice.name}`}
                  disabled={saving}
                  onClick={() =>
                    void save(agent.skills.filter((entry) => entry.name !== choice.ref))
                  }
                >
                  <XIcon />
                </Button>
              ) : undefined
            }
          />
        );
      })}
      {agent.viewer.canEdit ? (
        // The same gap the other sections leave between their text and controls.
        <div className="pt-3">
          <SelectMenu
            variant="combobox"
            aria-label="Add a Skill"
            name="skill"
            size="sm"
            className="w-full sm:w-80"
            value={null}
            placeholder="Add a Skill"
            searchPlaceholder="Search Skills"
            loading={catalog === null}
            loadingLabel="Loading Skills…"
            disabled={saving}
            emptyMessage="No other Skills in this workspace."
            options={options}
            onValueChange={(name) => {
              if (name) void save([...agent.skills, { name }]);
            }}
          />
        </div>
      ) : null}
    </DetailSection>
  );
}
