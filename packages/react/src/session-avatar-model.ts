/**
 * Renderer-neutral chat and agent avatars, shared by the web app and native
 * apps so a chat or an agent looks the same everywhere: the initials and
 * colour an avatar falls back to, the colours of its tile, and the agent a
 * chat belongs to with its current name and icon.
 *
 * No zod here (the web chat header is an eager module): `agentInitialsAvatar`
 * and `sessionSlackAgent` in `@opengeni/contracts` are mirrored, and parity
 * tests keep them in step.
 */
import { useEffect, useState } from "react";
import type { OpenGeniClient, SessionAvatar } from "@opengeni/sdk";

/** One or two initials for a name: the first letter of its first two words. */
export function sessionAvatarInitials(name: string): string {
  return initialsOf(name) || "?";
}

function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .map((word) => [...word].find((char) => /[\p{L}\p{N}]/u.test(char)))
    .filter((char): char is string => typeof char === "string")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** A stable hue for a chat without one (its id or name). */
export function sessionAvatarFallbackHue(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % 360;
}

/** Initials of up to two words of the name on a hue from the id; a bot icon without letters. */
export function agentInitialsAvatarLite(name: string, id: string): SessionAvatar {
  const hue = sessionAvatarFallbackHue(id);
  const letters = initialsOf(name);
  return /^[\p{L}\p{N}]{1,2}$/u.test(letters)
    ? { kind: "letters", letters, hue }
    : { kind: "icon", icon: "bot", hue };
}

export type AgentAvatarSource = {
  id: string;
  name: string;
  avatar: SessionAvatar | null;
};

/** The agent's icon, or its initials when it has none. */
export function agentAvatar(agent: AgentAvatarSource): SessionAvatar {
  return agent.avatar ?? agentInitialsAvatarLite(agent.name, agent.id);
}

/**
 * The tile colours, as OKLCH lightness and chroma on the avatar's hue: icons
 * and letters are white on `solid`; an emoji sits on `emojiLight` (light
 * appearance) or `emojiDark` (dark appearance).
 */
export const SESSION_AVATAR_TILE = {
  solid: { l: 0.56, c: 0.11 },
  emojiLight: { l: 0.92, c: 0.045 },
  emojiDark: { l: 0.36, c: 0.055 },
} as const;

export type SessionAvatarTileTone = keyof typeof SESSION_AVATAR_TILE;

/** A tile colour as a CSS `oklch()` value. */
export function sessionAvatarTileCss(tone: SessionAvatarTileTone, hue: number): string {
  const { l, c } = SESSION_AVATAR_TILE[tone];
  return `oklch(${l} ${c} ${hue})`;
}

/**
 * A tile colour as `#rrggbb` sRGB, for renderers that cannot parse `oklch()`
 * (React Native). Out-of-gamut channels are clipped, as browsers do.
 */
export function sessionAvatarTileHex(tone: SessionAvatarTileTone, hue: number): string {
  const { l, c } = SESSION_AVATAR_TILE[tone];
  return oklchToHex(l, c, hue);
}

/** An OKLCH colour as `#rrggbb` sRGB, clipping out-of-gamut channels as browsers do. */
export function oklchToHex(lightness: number, chroma: number, hue: number): string {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${linear
    .map((channel) => {
      const clipped = Math.min(1, Math.max(0, channel));
      const encoded = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
      return Math.round(encoded * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

/* The agent a chat belongs to --------------------------------------------- */

/** The Slack agent a chat was started for, read from the chat's metadata. */
export type SessionSlackAgentInfo = { id: string; name: string };

/** Session metadata key, `SESSION_SLACK_AGENT_METADATA_KEY` in contracts. */
const SLACK_AGENT_KEY = "slackAgent";
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

export function sessionSlackAgentInfo(
  metadata: Record<string, unknown> | null | undefined,
): SessionSlackAgentInfo | null {
  const value = metadata?.[SLACK_AGENT_KEY];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { id, name } = value as Record<string, unknown>;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (typeof name !== "string" || name.length === 0) return null;
  return { id, name };
}

export type SessionAgentRef = { id: string; name: string | null };

type SessionAgentSource = {
  metadata?: Record<string, unknown> | null | undefined;
  agentId?: string | null | undefined;
};

/**
 * The agent this chat belongs to, or null for an ordinary chat. Only
 * `session.agentId` names it (the server fills it in for older Slack chats);
 * the chat's metadata only supplies the name it had, until the agent loads.
 */
export function sessionAgentRef(session: SessionAgentSource): SessionAgentRef | null {
  if (!session.agentId) return null;
  const slack = sessionSlackAgentInfo(session.metadata);
  return { id: session.agentId, name: slack?.id === session.agentId ? slack.name : null };
}

export type SessionAgentInfo = {
  id: string;
  name: string;
  avatar: SessionAvatar;
  /** False while only the chat's own record of it is known (or it is gone). */
  live: boolean;
};

export type SessionAgentClient = Pick<OpenGeniClient, "getAgent">;

type CachedAgent = { name: string; avatar: SessionAvatar | null } | null;

// One read per agent, shared by every header that shows it. An entry belongs
// to the client that read it, so another account or access key reads again.
const agentCache = new Map<string, { client: object; pending: Promise<CachedAgent> }>();

/** Read the agent again next time a header shows it, after a change here. */
export function forgetSessionAgent(workspaceId: string, agentId: string): void {
  agentCache.delete(`${workspaceId}:${agentId}`);
}

/**
 * The agent's current name and icon; the chat's own record until (or unless)
 * it loads. `resolveClient` is only called for a chat with an agent.
 */
export function useSessionAgentInfo(
  workspaceId: string,
  ref: SessionAgentRef | null,
  resolveClient: () => SessionAgentClient | null | undefined,
): SessionAgentInfo | null {
  const id = ref?.id ?? null;
  const [loaded, setLoaded] = useState<{ key: string; value: CachedAgent } | null>(null);
  const key = id ? `${workspaceId}:${id}` : null;
  const client = key ? resolveClient() : null;
  useEffect(() => {
    if (!key || !id || typeof client?.getAgent !== "function") return;
    let live = true;
    let entry = agentCache.get(key);
    if (!entry || entry.client !== client) {
      const pending = client.getAgent(workspaceId, id).then(
        (agent): CachedAgent => ({ name: agent.name, avatar: agent.avatar }),
        () => {
          // Gone, hidden or unreachable: show what the chat knows, and ask again next time.
          if (agentCache.get(key)?.pending === pending) agentCache.delete(key);
          return null;
        },
      );
      entry = { client, pending };
      agentCache.set(key, entry);
    }
    void entry.pending.then((value) => {
      if (live) setLoaded({ key, value });
    });
    return () => {
      live = false;
    };
  }, [client, id, key, workspaceId]);
  if (!ref) return null;
  const current = loaded?.key === key ? loaded.value : null;
  if (current) {
    return {
      id: ref.id,
      name: current.name,
      avatar: agentAvatar({ id: ref.id, name: current.name, avatar: current.avatar }),
      live: true,
    };
  }
  if (!ref.name) return null;
  return {
    id: ref.id,
    name: ref.name,
    avatar: agentAvatar({ id: ref.id, name: ref.name, avatar: null }),
    live: false,
  };
}
