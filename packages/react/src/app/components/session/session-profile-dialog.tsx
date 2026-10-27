/**
 * Edit a chat's profile: its name, a one-line description and an avatar.
 * Together they are what makes a long-lived chat read as a bot in the
 * sidebar and header. Only people see them; the agent works the same. The
 * agent can set them too, including an image it made, which this dialog can
 * keep or replace but not upload.
 */
import { useState } from "react";
import { XIcon } from "lucide-react";
import {
  SESSION_AVATAR_ICONS,
  SESSION_DESCRIPTION_MAX_LENGTH,
  isSingleSessionAvatarEmoji,
} from "@opengeni/contracts";
import type { SessionAvatar as SessionAvatarValue, SessionAvatarIcon } from "@opengeni/sdk";

import { Button } from "../../../ui/button";
import { Field, FieldStack, TextArea, TextInput } from "../../../ui/field";
import { FormDialog } from "../../../ui/form-dialog";
import { SegmentedControl } from "../../../ui/segmented-control";
import { cn } from "../../lib/utils";
import { SESSION_TITLE_MAX_LENGTH } from "../../lib/session-rename";
import {
  SESSION_AVATAR_ICON_COMPONENTS,
  SessionAvatar,
  sessionAvatarFallbackHue,
  sessionAvatarInitials,
} from "./session-avatar";

export type SessionProfileValues = {
  title: string;
  description: string;
  avatar: SessionAvatarValue | null;
};

type AvatarKind = "none" | "emoji" | "icon" | "letters" | "image";

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

function avatarHue(avatar: SessionAvatarValue | null, fallback: number): number {
  return avatar && avatar.kind !== "image" ? avatar.hue : fallback;
}

export function SessionProfileDialog({
  open,
  onOpenChange,
  workspaceId,
  seed,
  initial,
  title = "Edit profile",
  description = "A name, description and avatar help people find this chat and know what it does. The agent doesn't see them.",
  submitLabel = "Save",
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** Keeps the default colour stable (the chat or template id). */
  seed: string;
  initial: SessionProfileValues;
  title?: string | undefined;
  description?: string | undefined;
  submitLabel?: string | undefined;
  /** Resolve false to keep the dialog open (a field of the caller's is wrong). */
  onSubmit: (values: SessionProfileValues) => Promise<void | false>;
  /** Extra fields after the profile (a template's setup instructions). */
  children?: React.ReactNode | undefined;
}) {
  const fallbackHue =
    SESSION_AVATAR_HUES[sessionAvatarFallbackHue(seed) % SESSION_AVATAR_HUES.length] ?? 0;
  const [name, setName] = useState(initial.title);
  const [about, setAbout] = useState(initial.description);
  const [kind, setKind] = useState<AvatarKind>(initial.avatar?.kind ?? "none");
  const [hue, setHue] = useState(avatarHue(initial.avatar, fallbackHue));
  const [emoji, setEmoji] = useState(
    initial.avatar?.kind === "emoji" ? initial.avatar.emoji : "🤖",
  );
  const [icon, setIcon] = useState<SessionAvatarIcon>(
    initial.avatar?.kind === "icon" ? initial.avatar.icon : "bot",
  );
  const [letters, setLetters] = useState(
    initial.avatar?.kind === "letters" ? initial.avatar.letters : "",
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const [emojiError, setEmojiError] = useState<string | null>(null);
  const [opened, setOpened] = useState(open);
  // Each opening starts from what the chat has now.
  if (open !== opened) {
    setOpened(open);
    if (open) {
      setName(initial.title);
      setAbout(initial.description);
      setKind(initial.avatar?.kind ?? "none");
      setHue(avatarHue(initial.avatar, fallbackHue));
      setEmoji(initial.avatar?.kind === "emoji" ? initial.avatar.emoji : "🤖");
      setIcon(initial.avatar?.kind === "icon" ? initial.avatar.icon : "bot");
      setLetters(initial.avatar?.kind === "letters" ? initial.avatar.letters : "");
      setNameError(null);
      setEmojiError(null);
    }
  }
  const initialImage = initial.avatar?.kind === "image" ? initial.avatar : null;
  const lettersValue = letters.trim() || sessionAvatarInitials(name || "Bot").slice(0, 2);
  const avatar: SessionAvatarValue | null =
    kind === "emoji"
      ? isSingleSessionAvatarEmoji(emoji.trim())
        ? { kind: "emoji", emoji: emoji.trim(), hue }
        : null
      : kind === "icon"
        ? { kind: "icon", icon, hue }
        : kind === "letters"
          ? /^[\p{L}\p{N}]{1,2}$/u.test(lettersValue)
            ? { kind: "letters", letters: lettersValue.toUpperCase(), hue }
            : null
          : kind === "image"
            ? initialImage
            : null;
  const kinds: { value: AvatarKind; label: string }[] = [
    { value: "emoji", label: "Emoji" },
    { value: "icon", label: "Icon" },
    { value: "letters", label: "Letters" },
    ...(initialImage ? [{ value: "image" as const, label: "Image" }] : []),
  ];

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={title}
      description={description}
      submitLabel={submitLabel}
      pendingLabel="Saving…"
      cancelLabel="Cancel"
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          setNameError("Give it a name.");
          return false;
        }
        if (kind === "emoji" && !avatar) {
          setEmojiError("Use a single emoji.");
          return false;
        }
        return (
          (await onSubmit({
            title: trimmed,
            description: about.trim(),
            avatar,
          })) !== false
        );
      }}
    >
      <FieldStack>
        <div className="flex items-start gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center">
            {avatar ? (
              <SessionAvatar
                avatar={avatar}
                name={name || "Bot"}
                workspaceId={workspaceId}
                seed={seed}
                size="lg"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex size-12 items-center justify-center rounded-lg border border-dashed border-border-strong text-xs text-fg-subtle"
              >
                None
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <Field label="Name" error={nameError ?? undefined}>
              <TextInput
                value={name}
                maxLength={SESSION_TITLE_MAX_LENGTH}
                autoComplete="off"
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                }}
              />
            </Field>
          </div>
        </div>
        <Field
          label="Description"
          optional
          hint="One line about what it's for, shown next to its name."
        >
          <TextArea
            value={about}
            rows={2}
            maxLength={SESSION_DESCRIPTION_MAX_LENGTH}
            onChange={(event) => setAbout(event.target.value)}
          />
        </Field>
        <Field
          label="Avatar"
          group
          aside={
            kind !== "none" ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-fg-muted pointer-coarse:min-h-11"
                onClick={() => setKind("none")}
              >
                <XIcon className="size-3" />
                No avatar
              </Button>
            ) : null
          }
        >
          <div className="flex flex-col gap-3">
            <SegmentedControl
              aria-label="Avatar kind"
              size="sm"
              options={kinds}
              value={kind === "none" ? undefined : kind}
              onValueChange={(next) => setKind(next)}
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
                      onClick={() => {
                        setEmoji(candidate);
                        setEmojiError(null);
                      }}
                      className={cn(
                        "flex size-8 items-center justify-center rounded-md text-base outline-hidden transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-11",
                        emoji === candidate && "bg-selection ring-1 ring-brand/30",
                      )}
                    >
                      {candidate}
                    </button>
                  ))}
                </div>
                <Field label="Or type one" error={emojiError ?? undefined}>
                  <TextInput
                    value={emoji}
                    maxLength={16}
                    autoComplete="off"
                    className="w-24"
                    onChange={(event) => {
                      setEmoji(event.target.value);
                      setEmojiError(null);
                    }}
                  />
                </Field>
              </div>
            ) : null}
            {kind === "icon" ? (
              <div
                className="grid grid-cols-8 gap-1 max-sm:grid-cols-6"
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
                      onClick={() => setIcon(candidate)}
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
              <Field label="Letters" hint="One or two letters or digits.">
                <TextInput
                  value={letters}
                  placeholder={sessionAvatarInitials(name || "Bot").slice(0, 2)}
                  maxLength={2}
                  autoComplete="off"
                  className="w-24 uppercase"
                  onChange={(event) => setLetters(event.target.value)}
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
                    onClick={() => setHue(candidate)}
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
        {children}
      </FieldStack>
    </FormDialog>
  );
}
