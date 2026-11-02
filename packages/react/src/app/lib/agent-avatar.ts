/**
 * The avatar an agent shows: its own icon, or the initials of its name.
 *
 * Mirrors `agentInitialsAvatar` from `@opengeni/contracts` without zod, so the
 * chat header (an eager module) does not load the contracts schemas. The
 * parity test keeps the two in step.
 */
import type { SessionAvatar } from "@opengeni/sdk";

export type AgentAvatarSource = {
  id: string;
  name: string;
  avatar: SessionAvatar | null;
};

/** Initials of up to two words of the name on a hue from the id; a bot icon without letters. */
export function agentInitialsAvatarLite(name: string, id: string): SessionAvatar {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  const hue = hash % 360;
  const letters = name
    .trim()
    .split(/\s+/u)
    .map((word) => [...word].find((char) => /[\p{L}\p{N}]/u.test(char)))
    .filter((char): char is string => typeof char === "string")
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return /^[\p{L}\p{N}]{1,2}$/u.test(letters)
    ? { kind: "letters", letters, hue }
    : { kind: "icon", icon: "bot", hue };
}

/** The agent's icon, or its initials when it has none. */
export function agentAvatar(agent: AgentAvatarSource): SessionAvatar {
  return agent.avatar ?? agentInitialsAvatarLite(agent.name, agent.id);
}
