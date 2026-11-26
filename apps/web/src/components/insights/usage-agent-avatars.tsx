// Agents' own avatars for the usage breakdown by agent, as the Agents page
// shows them: the usage answer names agents but carries no avatars, so the
// agents of the workspaces in view are read beside it.
import { useEffect, useState } from "react";
import type { SessionAvatar as SessionAvatarValue } from "@opengeni/sdk";
import { useAppContext } from "@opengeni/react/app/app-context";
import { SessionAvatar } from "@opengeni/react/app/components/session/session-avatar";
import { agentAvatar } from "@opengeni/react/session-avatar-model";

/** At most this many workspaces are read for one breakdown: the first ones in row order. */
const MAX_WORKSPACES = 20;

type KnownAgent = { avatar: SessionAvatarValue | null; workspaceId: string };

/** Each visible agent's avatar by id, for the given workspaces; empty while off or loading. */
export function useUsageAgentAvatars(
  workspaceIds: readonly string[],
  enabled: boolean,
): ReadonlyMap<string, KnownAgent> {
  const { client } = useAppContext();
  const key = enabled ? [...new Set(workspaceIds)].slice(0, MAX_WORKSPACES).join(",") : "";
  const [known, setKnown] = useState<{ key: string; agents: Map<string, KnownAgent> }>({
    key: "",
    agents: new Map(),
  });
  useEffect(() => {
    if (!key || typeof client.listAgents !== "function") return;
    let live = true;
    void Promise.all(
      key.split(",").map((workspaceId) => client.listAgents(workspaceId).catch(() => [])),
    ).then((lists) => {
      if (!live) return;
      const agents = new Map<string, KnownAgent>();
      for (const agent of lists.flat())
        agents.set(agent.id.toLowerCase(), {
          avatar: agent.avatar,
          workspaceId: agent.workspaceId,
        });
      setKnown({ key, agents });
    });
    return () => {
      live = false;
    };
  }, [client, key]);
  return known.key === key ? known.agents : EMPTY;
}

const EMPTY: ReadonlyMap<string, KnownAgent> = new Map();

/** An agent row's avatar: its own, else its initials, as on the Agents page. */
export function UsageAgentAvatar({
  agentId,
  name,
  known,
  workspaceId,
}: {
  agentId: string;
  name: string;
  known: KnownAgent | undefined;
  workspaceId: string;
}) {
  return (
    <SessionAvatar
      avatar={agentAvatar({ id: agentId, name, avatar: known?.avatar ?? null })}
      name={name}
      workspaceId={known?.workspaceId ?? workspaceId}
      seed={agentId}
      size="sm"
    />
  );
}
