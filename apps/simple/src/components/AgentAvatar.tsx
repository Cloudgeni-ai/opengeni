import { useState } from "react";
import { agentGradient } from "../lib/agents";
import type { AgentProfile } from "../lib/app-api";

/**
 * The agent's generated image, or its emoji on a gradient while the image is
 * being painted (with a soft shimmer) or when there is none.
 */
export function AgentAvatar({
  id,
  emoji,
  profile,
  size = 32,
  className = "",
}: {
  id: string;
  emoji: string;
  profile: AgentProfile | null;
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const artifactId = profile?.avatarArtifactId ?? null;
  const pending = profile?.avatarStatus === "pending";
  const showImage = artifactId && broken !== artifactId;
  const radius = Math.round(size * 0.32);
  return (
    <div
      className={`relative shrink-0 overflow-hidden ${pending && !showImage ? "avatar-pending" : ""} ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: showImage ? "var(--app-hover)" : agentGradient(id),
      }}
      aria-hidden
    >
      {showImage ? (
        <img
          src={`/app/avatar/${id}?v=${artifactId}`}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          onError={() => setBroken(artifactId)}
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center select-none"
          style={{ fontSize: Math.round(size * 0.52), lineHeight: 1 }}
        >
          {emoji}
        </span>
      )}
    </div>
  );
}
