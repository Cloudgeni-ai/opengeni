import { createContext, useContext, useSyncExternalStore } from "react";
import { agentIcon } from "../lib/agent-icons";
import type { AgentProfile } from "../lib/app-api";
import { avatarColors, DEFAULT_AVATAR_STYLE } from "../lib/avatar-styles";
import { AGENT_ICON_COMPONENTS } from "./agent-icon-components";

/** The workspace's avatar style; every avatar reads it, so a switch recolors all at once. */
export const AvatarStyleContext = createContext(DEFAULT_AVATAR_STYLE);

const OPENGENI_MARK =
  "M251 83.5966L207 109L163 83.5966L119 109L75 83.5966L141 45.4915A44 44 0 0 1 185 45.4915ZM185.25 172.3642A44.5 44.5 0 0 1 140.75 172.3642L75 134.4034L119 109L163 134.4034L207 109L251 134.4034Z";

export type AvatarSubject = {
  id: string;
  name: string;
  role: "main" | "agent";
  profile: AgentProfile | null;
};

/**
 * An agent's face: its icon drawn in the style's colors. Geni wears the
 * Opengeni mark. An agent with no fitting icon shows its initial.
 */
export function AgentAvatar({
  agent,
  size = 32,
  styleId,
  className = "",
}: {
  agent: AvatarSubject;
  size?: number;
  /** Overrides the workspace style, for previews. */
  styleId?: string;
  className?: string;
}) {
  const workspaceStyle = useContext(AvatarStyleContext);
  const dark = useDarkMode();
  const colors = avatarColors(styleId ?? workspaceStyle, agent.id, dark);
  const radius = Math.round(size * 0.32);
  const iconName =
    agent.role === "main"
      ? null
      : agentIcon({
          icon: agent.profile?.icon,
          name: agent.name,
          description: agent.profile?.description,
        });
  const Icon = iconName ? AGENT_ICON_COMPONENTS[iconName] : undefined;

  let face: React.ReactNode;
  if (agent.role === "main") {
    face = (
      <svg viewBox="71 17 184 184" width="58%" height="58%" aria-hidden>
        <path fill={colors.glyph} d={OPENGENI_MARK} />
      </svg>
    );
  } else if (Icon) {
    face = (
      <Icon
        size={Math.round(size * 0.55)}
        color={colors.glyph}
        strokeWidth={size < 28 ? 2.25 : 2}
        aria-hidden
      />
    );
  } else {
    face = (
      <span
        className="font-semibold select-none"
        style={{ color: colors.glyph, fontSize: Math.round(size * 0.42), lineHeight: 1 }}
      >
        {initial(agent.name)}
      </span>
    );
  }

  return (
    <div
      className={`relative flex shrink-0 items-center justify-center overflow-hidden ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: colors.background,
        boxShadow: colors.ring ? `inset 0 0 0 1px ${colors.ring}` : undefined,
      }}
      aria-hidden
    >
      {face}
    </div>
  );
}

function initial(name: string) {
  const letter = [...name.trim()].find((char) => /\p{L}|\p{N}/u.test(char));
  return (letter ?? "•").toLocaleUpperCase();
}

const darkListeners = new Set<() => void>();
let darkObserver: MutationObserver | null = null;
function subscribeDark(listener: () => void) {
  darkListeners.add(listener);
  if (!darkObserver) {
    darkObserver = new MutationObserver(() => {
      for (const notify of darkListeners) notify();
    });
    darkObserver.observe(document.documentElement, { attributeFilter: ["class"] });
  }
  return () => {
    darkListeners.delete(listener);
  };
}

function useDarkMode() {
  return useSyncExternalStore(
    subscribeDark,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
}
