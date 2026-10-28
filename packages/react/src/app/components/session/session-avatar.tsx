/**
 * A chat's avatar: what a bot looks like in the sidebar, its header and the
 * bot templates. A rounded square, so it never reads as a person's round
 * monogram. Emoji sit on a soft tint of their hue; icons and letters are
 * white on it. An image avatar is a workspace image each viewer opens with
 * their own access; until it loads, or when they cannot open it, the chat's
 * initials show instead.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  BookOpenIcon,
  BotIcon,
  BriefcaseIcon,
  BugIcon,
  CalendarClockIcon,
  ChartLineIcon,
  CodeIcon,
  DatabaseIcon,
  FileTextIcon,
  FlaskConicalIcon,
  GitPullRequestIcon,
  GlobeIcon,
  HeadsetIcon,
  MailIcon,
  MegaphoneIcon,
  PenToolIcon,
  ReceiptIcon,
  RocketIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TelescopeIcon,
  UsersIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import type { RetainedArtifactMetadata, RetainedArtifactReference } from "@opengeni/sdk";
import type { SessionAvatar as SessionAvatarValue, SessionAvatarIcon } from "@opengeni/sdk";

import { isRetainedImageContentType, useRetainedImageObjectUrl } from "../../../artifacts";
import { createWorkspaceRetainedArtifactLoader } from "../../../timeline";
import { useAppContext } from "../../app-context";
import { cn } from "../../lib/utils";
import {
  cachedRetainedArtifactLoader,
  cachedRetainedMetadata,
  retainedImageCache,
  retainedImageScope,
} from "../artifacts/retained-image-cache";

export const SESSION_AVATAR_ICON_COMPONENTS: Record<SessionAvatarIcon, LucideIcon> = {
  bot: BotIcon,
  bug: BugIcon,
  mail: MailIcon,
  "git-pull-request": GitPullRequestIcon,
  telescope: TelescopeIcon,
  "chart-line": ChartLineIcon,
  "file-text": FileTextIcon,
  "shield-check": ShieldCheckIcon,
  wrench: WrenchIcon,
  search: SearchIcon,
  "calendar-clock": CalendarClockIcon,
  megaphone: MegaphoneIcon,
  receipt: ReceiptIcon,
  rocket: RocketIcon,
  database: DatabaseIcon,
  code: CodeIcon,
  briefcase: BriefcaseIcon,
  "book-open": BookOpenIcon,
  "flask-conical": FlaskConicalIcon,
  globe: GlobeIcon,
  headset: HeadsetIcon,
  "pen-tool": PenToolIcon,
  users: UsersIcon,
  sparkles: SparklesIcon,
};

export type SessionAvatarSize = "xs" | "sm" | "md" | "lg";

const SIZE: Record<SessionAvatarSize, { box: string; icon: string; text: string; emoji: string }> =
  {
    xs: {
      box: "size-4 rounded-[4px]",
      icon: "size-2.5",
      text: "text-[8px]",
      emoji: "text-[10px]",
    },
    sm: {
      box: "size-5 rounded-[5px]",
      icon: "size-3",
      text: "text-[9px]",
      emoji: "text-xs",
    },
    md: {
      box: "size-8 rounded-md",
      icon: "size-4",
      text: "text-xs",
      emoji: "text-base",
    },
    lg: {
      box: "size-12 rounded-lg",
      icon: "size-6",
      text: "text-base",
      emoji: "text-2xl",
    },
  };

/** One or two initials for a name: the first letter of its first two words. */
export function sessionAvatarInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .map((word) => [...word].find((char) => /[\p{L}\p{N}]/u.test(char)))
    .filter((char): char is string => Boolean(char));
  return words.slice(0, 2).join("").toUpperCase() || "?";
}

/** A stable hue for a chat without one (its id or name). */
export function sessionAvatarFallbackHue(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % 360;
}

function solid(hue: number): CSSProperties {
  return { background: `oklch(0.56 0.11 ${hue})` };
}

export function SessionAvatar({
  avatar,
  name,
  workspaceId,
  seed,
  size = "sm",
  className,
}: {
  avatar: SessionAvatarValue;
  /** The chat's name, for an image's initials fallback and alt text. */
  name: string;
  /** Where an image avatar lives. */
  workspaceId: string;
  /** Keeps an image's fallback colour stable (the chat id). Defaults to the name. */
  seed?: string | undefined;
  size?: SessionAvatarSize | undefined;
  className?: string | undefined;
}) {
  const dims = SIZE[size];
  const box = cn(
    "inline-flex shrink-0 select-none items-center justify-center overflow-hidden leading-none",
    dims.box,
    className,
  );
  if (avatar.kind === "image") {
    return (
      <ImageAvatar
        artifactId={avatar.artifactId}
        workspaceId={workspaceId}
        name={name}
        className={box}
        fallback={
          <LettersTile
            letters={sessionAvatarInitials(name)}
            hue={sessionAvatarFallbackHue(seed ?? name)}
            className={box}
            textClassName={dims.text}
          />
        }
      />
    );
  }
  if (avatar.kind === "emoji") {
    return (
      <span
        aria-hidden="true"
        data-session-avatar="emoji"
        className={cn(
          box,
          dims.emoji,
          "bg-[oklch(0.92_0.045_var(--avatar-hue))] dark:bg-[oklch(0.36_0.055_var(--avatar-hue))]",
        )}
        style={{ "--avatar-hue": avatar.hue } as CSSProperties}
      >
        {avatar.emoji}
      </span>
    );
  }
  if (avatar.kind === "icon") {
    const Icon = SESSION_AVATAR_ICON_COMPONENTS[avatar.icon] ?? BotIcon;
    return (
      <span
        aria-hidden="true"
        data-session-avatar="icon"
        className={cn(box, "text-white")}
        style={solid(avatar.hue)}
      >
        <Icon className={dims.icon} strokeWidth={2.25} />
      </span>
    );
  }
  return (
    <LettersTile
      letters={avatar.letters}
      hue={avatar.hue}
      className={box}
      textClassName={dims.text}
    />
  );
}

function LettersTile({
  letters,
  hue,
  className,
  textClassName,
}: {
  letters: string;
  hue: number;
  className: string;
  textClassName: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-session-avatar="letters"
      className={cn(className, textClassName, "font-semibold text-white")}
      style={solid(hue)}
    >
      {letters.toUpperCase()}
    </span>
  );
}

function ImageAvatar({
  artifactId,
  workspaceId,
  name,
  className,
  fallback,
}: {
  artifactId: string;
  workspaceId: string;
  name: string;
  className: string;
  fallback: React.ReactNode;
}) {
  const { client, accessKeyVersion } = useAppContext();
  const scope = retainedImageScope(accessKeyVersion, workspaceId, artifactId);
  const [artifact, setArtifact] = useState<RetainedArtifactReference | null>(() => {
    const cached = retainedImageCache(client).peek<RetainedArtifactMetadata>(`${scope}meta`);
    return cached && usableImage(cached, artifactId) ? cached : null;
  });
  useEffect(() => {
    let active = true;
    void cachedRetainedMetadata(retainedImageCache(client), scope, () =>
      client.getRetainedArtifact(workspaceId, artifactId),
    )
      .then((metadata) => {
        if (active) setArtifact(usableImage(metadata, artifactId) ? metadata : null);
      })
      .catch(() => {
        if (active) setArtifact(null);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, artifactId, scope]);
  const load = useMemo(
    () =>
      cachedRetainedArtifactLoader(
        retainedImageCache(client),
        accessKeyVersion,
        workspaceId,
        createWorkspaceRetainedArtifactLoader(client, workspaceId),
      ),
    [client, workspaceId, accessKeyVersion],
  );
  if (!artifact) return <>{fallback}</>;
  return (
    <LoadedImageAvatar
      key={artifact.artifactId}
      artifact={artifact}
      load={load}
      name={name}
      className={className}
      fallback={fallback}
    />
  );
}

function LoadedImageAvatar({
  artifact,
  load,
  name,
  className,
  fallback,
}: {
  artifact: RetainedArtifactReference;
  load: ReturnType<typeof createWorkspaceRetainedArtifactLoader>;
  name: string;
  className: string;
  fallback: React.ReactNode;
}) {
  const state = useRetainedImageObjectUrl(artifact, load);
  const [failed, setFailed] = useState(false);
  if (state.kind !== "ready" || failed) return <>{fallback}</>;
  return (
    <span aria-hidden="true" data-session-avatar="image" className={cn(className, "bg-surface-2")}>
      <img
        src={state.url}
        alt={name}
        className="size-full object-cover"
        draggable={false}
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function usableImage(
  artifact: RetainedArtifactMetadata,
  artifactId: string,
): artifact is RetainedArtifactReference {
  return (
    artifact.available &&
    artifact.artifactId === artifactId &&
    isRetainedImageContentType(artifact.contentType)
  );
}
