/**
 * The avatar picker used by a chat's profile, bot templates and Slack agents:
 * an emoji, an icon or letters on one of twelve colours, or an image the agent
 * set. The caller owns the draft; `sessionAvatarFromDraft` turns it into the
 * saved avatar (null while the draft is incomplete or "none").
 */
import { PencilIcon, XIcon } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { SESSION_AVATAR_ICONS, isSingleSessionAvatarEmoji } from "@opengeni/contracts";
import type { SessionAvatar as SessionAvatarValue, SessionAvatarIcon } from "@opengeni/sdk";

import { Button } from "../../../ui/button";
import { Field, TextInput } from "../../../ui/field";
import { MENU_SURFACE_CLASS } from "../../../ui/menu-styles";
import { containedPortal } from "../../../ui/portal-container";
import { SegmentedControl } from "../../../ui/segmented-control";
import { cn } from "../../lib/utils";
import {
  SESSION_AVATAR_ICON_COMPONENTS,
  SessionAvatar,
  sessionAvatarInitials,
} from "./session-avatar";

const PopoverContainedPortal = containedPortal(PopoverPrimitive.Portal);

export type SessionAvatarKind = "none" | "emoji" | "icon" | "letters" | "image";

/** Twelve evenly readable hues for the avatar tile. */
export const SESSION_AVATAR_HUES = [0, 28, 55, 85, 130, 160, 190, 215, 245, 275, 305, 335] as const;

const QUICK_EMOJI = [
  "🤖",
  "🐛",
  "🦉",
  "🚀",
  "🔧",
  "📈",
  "🧪",
  "🛡️",
  "📬",
  "🧭",
  "🎯",
  "💡",
  "🔍",
  "📚",
  "⚡",
  "🌱",
] as const;

const ICON_LABELS: Record<SessionAvatarIcon, string> = {
  bot: "Bot",
  bug: "Bug",
  mail: "Mail",
  "git-pull-request": "Pull request",
  telescope: "Telescope",
  "chart-line": "Chart",
  "file-text": "Document",
  "shield-check": "Shield",
  wrench: "Wrench",
  search: "Search",
  "calendar-clock": "Calendar",
  megaphone: "Megaphone",
  receipt: "Receipt",
  rocket: "Rocket",
  database: "Database",
  code: "Code",
  briefcase: "Briefcase",
  "book-open": "Book",
  "flask-conical": "Flask",
  globe: "Globe",
  headset: "Headset",
  "pen-tool": "Pen",
  users: "People",
  sparkles: "Sparkles",
};

/** Everything the picker edits, kept across kinds so switching back keeps a choice. */
export type SessionAvatarDraft = {
  kind: SessionAvatarKind;
  hue: number;
  emoji: string;
  icon: SessionAvatarIcon;
  letters: string;
};

/** The colour a new avatar starts with, stable for the same seed (a chat or template id). */
export function sessionAvatarSeedHue(seed: number): number {
  return SESSION_AVATAR_HUES[seed % SESSION_AVATAR_HUES.length] ?? 0;
}

/** A draft showing `avatar`, or `emptyKind` with defaults when there is none. */
export function sessionAvatarDraft(
  avatar: SessionAvatarValue | null,
  fallbackHue: number,
  emptyKind: SessionAvatarKind = "none",
): SessionAvatarDraft {
  return {
    kind: avatar?.kind ?? emptyKind,
    hue: avatar && avatar.kind !== "image" ? avatar.hue : fallbackHue,
    emoji: avatar?.kind === "emoji" ? avatar.emoji : "🤖",
    icon: avatar?.kind === "icon" ? avatar.icon : "bot",
    letters: avatar?.kind === "letters" ? avatar.letters : "",
  };
}

/** The letters an avatar shows: what was typed, or the name's initials. */
function draftLetters(draft: SessionAvatarDraft, name: string): string {
  return draft.letters.trim() || sessionAvatarInitials(name || "Bot").slice(0, 2);
}

/** The avatar a draft saves as; null for "none" or while the emoji or letters are invalid. */
export function sessionAvatarFromDraft(
  draft: SessionAvatarDraft,
  name: string,
  image: SessionAvatarValue | null,
): SessionAvatarValue | null {
  switch (draft.kind) {
    case "emoji":
      return isSingleSessionAvatarEmoji(draft.emoji.trim())
        ? { kind: "emoji", emoji: draft.emoji.trim(), hue: draft.hue }
        : null;
    case "icon":
      return { kind: "icon", icon: draft.icon, hue: draft.hue };
    case "letters": {
      const letters = draftLetters(draft, name);
      return /^[\p{L}\p{N}]{1,2}$/u.test(letters)
        ? { kind: "letters", letters: letters.toUpperCase(), hue: draft.hue }
        : null;
    }
    case "image":
      return image?.kind === "image" ? image : null;
    default:
      return null;
  }
}

/** Why a draft can't be saved, as field errors; empty when it can. */
export function sessionAvatarDraftErrors(
  draft: SessionAvatarDraft,
  name: string,
  image: SessionAvatarValue | null,
): { emoji?: string; letters?: string } {
  if (sessionAvatarFromDraft(draft, name, image) || draft.kind === "none") return {};
  if (draft.kind === "emoji") return { emoji: "Use a single emoji." };
  if (draft.kind === "letters") return { letters: "Use one or two letters or digits." };
  return {};
}

const NO_ERRORS = {};

export function SessionAvatarPicker({
  draft,
  onChange,
  name,
  image,
  errors = NO_ERRORS,
  label = "Avatar",
  allowNone = true,
}: {
  draft: SessionAvatarDraft;
  onChange: (draft: SessionAvatarDraft) => void;
  /** The name the letters default to. */
  name: string;
  /** An image the agent set, offered as the "Image" kind while it is the saved one. */
  image: SessionAvatarValue | null;
  errors?: { emoji?: string | null | undefined; letters?: string | null | undefined } | undefined;
  label?: string | undefined;
  /** False when an avatar is required: no "No avatar" action. */
  allowNone?: boolean | undefined;
}) {
  const set = (patch: Partial<SessionAvatarDraft>) => onChange({ ...draft, ...patch });
  const { kind, hue, emoji, icon, letters } = draft;
  const kinds: { value: SessionAvatarKind; label: string }[] = [
    { value: "emoji", label: "Emoji" },
    { value: "icon", label: "Icon" },
    { value: "letters", label: "Letters" },
    ...(image?.kind === "image" ? [{ value: "image" as const, label: "Image" }] : []),
  ];
  return (
    <Field
      label={label}
      group
      aside={
        allowNone && kind !== "none" ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-fg-muted pointer-coarse:min-h-11"
            onClick={() => set({ kind: "none" })}
          >
            <XIcon className="size-3" />
            No avatar
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-3">
        <SegmentedControl
          aria-label={`${label} kind`}
          size="sm"
          className="self-start"
          options={kinds}
          value={kind === "none" ? undefined : kind}
          onValueChange={(next) => set({ kind: next })}
        />
        {kind === "emoji" ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Suggested emoji">
              {QUICK_EMOJI.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-label={candidate}
                  aria-pressed={emoji === candidate}
                  onClick={() => set({ emoji: candidate })}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-md text-base outline-hidden transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-11",
                    emoji === candidate && "bg-selection ring-1 ring-brand/30",
                  )}
                >
                  {candidate}
                </button>
              ))}
            </div>
            <Field label="Or type one" error={errors.emoji ?? undefined}>
              <TextInput
                value={emoji}
                maxLength={16}
                autoComplete="off"
                className="w-24"
                onChange={(event) => set({ emoji: event.target.value })}
              />
            </Field>
          </div>
        ) : null}
        {kind === "icon" ? (
          <div
            className="grid w-fit grid-cols-8 gap-1 max-sm:grid-cols-6 pointer-coarse:grid-cols-6"
            role="group"
            aria-label="Icons"
          >
            {SESSION_AVATAR_ICONS.map((candidate) => {
              const Icon = SESSION_AVATAR_ICON_COMPONENTS[candidate];
              return (
                <button
                  key={candidate}
                  type="button"
                  aria-label={ICON_LABELS[candidate]}
                  title={ICON_LABELS[candidate]}
                  aria-pressed={icon === candidate}
                  onClick={() => set({ icon: candidate })}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-md text-fg-label outline-hidden transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-11",
                    icon === candidate && "bg-selection text-fg ring-1 ring-brand/30",
                  )}
                >
                  <Icon className="size-4" />
                </button>
              );
            })}
          </div>
        ) : null}
        {kind === "letters" ? (
          <Field
            label="Letters"
            hint="One or two letters or digits."
            error={errors.letters ?? undefined}
          >
            <TextInput
              value={letters}
              placeholder={sessionAvatarInitials(name || "Bot").slice(0, 2)}
              maxLength={2}
              autoComplete="off"
              className="w-24 uppercase"
              onChange={(event) => set({ letters: event.target.value })}
            />
          </Field>
        ) : null}
        {kind === "image" ? (
          <p className="m-0 text-sm leading-5 text-fg-muted">
            An image the agent set. To change it, ask the agent for a new one, or pick an emoji,
            icon or letters instead.
          </p>
        ) : null}
        {kind === "emoji" || kind === "icon" || kind === "letters" ? (
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
            {SESSION_AVATAR_HUES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={hue === candidate}
                aria-label={`Colour ${SESSION_AVATAR_HUES.indexOf(candidate) + 1}`}
                onClick={() => set({ hue: candidate })}
                className={cn(
                  "size-6 rounded-full outline-hidden ring-offset-2 ring-offset-surface transition-shadow focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-9",
                  hue === candidate && "ring-2 ring-fg/70",
                )}
                style={{ background: `oklch(0.56 0.11 ${candidate})` }}
              />
            ))}
          </div>
        ) : null}
      </div>
    </Field>
  );
}

/**
 * The avatar as a button that opens the picker in a popover, for forms where
 * the avatar sits next to the name and the full picker would crowd the fields.
 * Pass `open` and `onOpenChange` to open it when the draft can't be saved.
 */
export function SessionAvatarPickerButton({
  draft,
  onChange,
  name,
  image,
  errors = NO_ERRORS,
  label = "Avatar",
  allowNone = true,
  workspaceId,
  seed,
  open,
  onOpenChange,
}: Parameters<typeof SessionAvatarPicker>[0] & {
  /** Where an image avatar lives. */
  workspaceId: string;
  /** Keeps an image's fallback colour stable. */
  seed?: string | undefined;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const avatar = sessionAvatarFromDraft(draft, name, image);
  const invalid = Boolean(errors.emoji || errors.letters);
  return (
    <PopoverPrimitive.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <PopoverPrimitive.Trigger
        type="button"
        aria-label={label}
        // Not aria-invalid: the form focuses the first invalid control, which
        // must be the input in the popover that says what is wrong.
        data-invalid={invalid || undefined}
        title={`Change ${label.toLowerCase()}`}
        className={cn(
          "group/avatar relative inline-flex size-12 shrink-0 items-center justify-center rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40",
          "data-invalid:ring-2 data-invalid:ring-danger/60",
        )}
      >
        {avatar ? (
          <SessionAvatar
            avatar={avatar}
            name={name || "Agent"}
            workspaceId={workspaceId}
            seed={seed}
            size="lg"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-12 items-center justify-center rounded-lg border border-dashed border-border-strong"
          />
        )}
        <span
          aria-hidden="true"
          className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full border border-border bg-surface text-fg-muted shadow-og-sm transition-colors group-hover/avatar:text-fg"
        >
          <PencilIcon className="size-3" />
        </span>
      </PopoverPrimitive.Trigger>
      <PopoverContainedPortal>
        <PopoverPrimitive.Content
          aria-label={label}
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            // Opened because the emoji or letters can't be saved: go to that input.
            const field = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
              '[aria-invalid="true"]',
            );
            if (!field) return;
            event.preventDefault();
            field.focus();
          }}
          className={cn(
            MENU_SURFACE_CLASS,
            "z-50 max-h-(--radix-popover-content-available-height) w-[min(24rem,calc(100vw-24px))] overflow-y-auto p-3 outline-hidden",
          )}
        >
          <SessionAvatarPicker
            draft={draft}
            onChange={onChange}
            name={name}
            image={image}
            errors={errors}
            label={label}
            allowNone={allowNone}
          />
        </PopoverPrimitive.Content>
      </PopoverContainedPortal>
    </PopoverPrimitive.Root>
  );
}
