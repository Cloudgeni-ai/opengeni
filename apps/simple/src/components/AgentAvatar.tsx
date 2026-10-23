import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { AgentProfile } from "../lib/app-api";
import { avatarMask, readyMask } from "../lib/avatar-mask";
import { avatarColors, DEFAULT_AVATAR_STYLE } from "../lib/avatar-styles";

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
 * An agent's face: its glyph filled with the style's colors. Geni wears the
 * Opengeni mark. Until a glyph is painted (or if painting failed), the tile
 * shows the agent's initial in the same colors, so nothing ever jumps from one
 * look to another.
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
  const profile = agent.profile;
  const artifactId = profile?.avatarArtifactId ?? null;
  const isMask = profile?.avatarFormat === "mask";
  const src = artifactId ? `/app/avatar/${agent.id}?v=${artifactId}` : null;
  const mask = useMask(isMask ? src : null);
  const pending = profile?.avatarStatus === "pending";
  const radius = Math.round(size * 0.32);
  const legacyImage = src && !isMask ? src : null;

  let face: React.ReactNode;
  if (agent.role === "main") {
    face = (
      <svg viewBox="71 17 184 184" width="58%" height="58%" aria-hidden>
        <path fill={colors.glyph} d={OPENGENI_MARK} />
      </svg>
    );
  } else if (mask) {
    face = (
      <span
        className="avatar-glyph h-full w-full"
        style={{
          backgroundColor: colors.glyph,
          WebkitMaskImage: `url(${mask})`,
          maskImage: `url(${mask})`,
        }}
      />
    );
  } else if (legacyImage) {
    face = (
      <img src={legacyImage} alt="" className="h-full w-full object-cover" draggable={false} />
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
      className={`relative flex shrink-0 items-center justify-center overflow-hidden ${pending && !mask && agent.role !== "main" ? "avatar-pending" : ""} ${className}`}
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

function useMask(src: string | null) {
  const [mask, setMask] = useState<{ src: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!src) return;
    let live = true;
    void avatarMask(src).then((url) => {
      if (live) setMask({ src, url });
    });
    return () => {
      live = false;
    };
  }, [src]);
  if (!src) return null;
  if (mask?.src === src) return mask.url;
  return readyMask(src) ?? null;
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
