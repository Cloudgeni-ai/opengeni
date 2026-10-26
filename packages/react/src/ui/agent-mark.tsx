import type { CSSProperties, SVGProps } from "react";
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
import type { AgentAvatar, AgentAvatarIcon } from "@opengeni/sdk";

import { cn } from "../lib/cn";

/* ----------------------------------------------------------------------------
   AgentMark: the face of an agent.

   A rounded square holding one emoji, a curated icon or one or two letters on
   a soft low-chroma gradient of the avatar's hue. The UI stays grey; this tile
   is the only colour an agent adds. Agents are square so they never read as a
   person's round monogram. With no avatar it is the default Opengeni agent:
   the brand mark on a neutral tile.

   Sizes: 16 / 18 (rail, composer, menus), 24 (chat header, timeline), 32
   (cards, rows), 40, 56 (profile page). Decorative: the name beside it is the
   accessible label, so the tile is aria-hidden unless a `title` is given.
   -------------------------------------------------------------------------- */

export const AGENT_AVATAR_ICON_COMPONENTS: Record<AgentAvatarIcon, LucideIcon> = {
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

/** The eight suggested tints, low-chroma hues that read well in both themes. */
export const AGENT_AVATAR_HUES = [235, 20, 60, 160, 300, 190, 340, 260] as const;

/** A stable default hue for a name, so a new agent gets a tint without a choice. */
export function agentAvatarHueForName(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return AGENT_AVATAR_HUES[hash % AGENT_AVATAR_HUES.length]!;
}

/** Background gradient for an avatar hue. */
export function agentAvatarBackground(hue: number): string {
  return `linear-gradient(150deg, oklch(0.5 0.075 ${hue}), oklch(0.33 0.05 ${hue}))`;
}

function OpengeniGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 176 138.73" fill="currentColor" aria-hidden="true" {...props}>
      <path
        transform="translate(-75 -39.5966)"
        d="M251 83.5966L207 109L163 83.5966L119 109L75 83.5966L141 45.4915A44 44 0 0 1 185 45.4915ZM185.25 172.3642A44.5 44.5 0 0 1 140.75 172.3642L75 134.4034L119 109L163 134.4034L207 109L251 134.4034Z"
      />
    </svg>
  );
}

export type AgentMarkProps = {
  /** Null or omitted renders the default Opengeni agent. */
  avatar?: AgentAvatar | null | undefined;
  /** Edge length in pixels. */
  size?: number;
  /** Optional status dot on the tile's corner (a CSS color, e.g. a status token). */
  dotClassName?: string | undefined;
  /** When set, the tile is announced with this label instead of being decorative. */
  title?: string | undefined;
  className?: string | undefined;
};

export function AgentMark({ avatar, size = 18, dotClassName, title, className }: AgentMarkProps) {
  const radius = Math.max(4, Math.round(size * 0.3));
  const style: CSSProperties = { width: size, height: size, borderRadius: radius };
  const a11y = title ? { role: "img", "aria-label": title, title } : { "aria-hidden": true };
  let inner;
  if (!avatar) {
    inner = <OpengeniGlyph style={{ width: Math.round(size * 0.58) }} className="h-auto" />;
  } else if (avatar.kind === "emoji") {
    inner = (
      <span
        className="leading-none"
        style={{
          fontSize: Math.round(size * 0.6),
          fontFamily: '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif',
        }}
      >
        {avatar.emoji}
      </span>
    );
  } else if (avatar.kind === "icon") {
    const Icon = AGENT_AVATAR_ICON_COMPONENTS[avatar.icon] ?? BotIcon;
    inner = (
      <Icon
        aria-hidden="true"
        strokeWidth={2}
        style={{
          width: Math.round(size * 0.56),
          height: Math.round(size * 0.56),
          color: `oklch(0.94 0.05 ${avatar.hue})`,
        }}
      />
    );
  } else {
    inner = (
      <span
        className="font-semibold leading-none"
        style={{
          fontSize: Math.max(7, Math.round(size * 0.38)),
          color: `oklch(0.96 0.03 ${avatar.hue})`,
        }}
      >
        {avatar.letters.toUpperCase()}
      </span>
    );
  }
  return (
    <span
      data-agent-mark
      {...a11y}
      className={cn(
        "relative inline-grid shrink-0 place-items-center overflow-visible select-none",
        "shadow-[inset_0_1px_0_rgb(255_255_255/0.12),inset_0_0_0_1px_rgb(255_255_255/0.05)]",
        avatar ? "" : "bg-surface-3 text-fg",
        className,
      )}
      style={avatar ? { ...style, background: agentAvatarBackground(avatar.hue) } : style}
    >
      {inner}
      {dotClassName ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-[7px] rounded-full ring-2 ring-bg",
            dotClassName,
          )}
        />
      ) : null}
    </span>
  );
}
