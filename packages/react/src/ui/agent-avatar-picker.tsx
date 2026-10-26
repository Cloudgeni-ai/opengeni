import { useId, useState } from "react";
import { AGENT_AVATAR_ICONS, isSingleAgentAvatarEmoji } from "@opengeni/contracts/agent-avatar";
import type { AgentAvatar, AgentAvatarIcon } from "@opengeni/sdk";

import { cn } from "../lib/cn";
import {
  AGENT_AVATAR_HUES,
  AGENT_AVATAR_ICON_COMPONENTS,
  agentAvatarBackground,
} from "./agent-mark";
import { Input } from "./input";
import { SegmentedControl } from "./segmented-control";

/* ----------------------------------------------------------------------------
   AgentAvatarPicker: choose an agent's face. One emoji (from a suggested grid
   or typed/pasted), one curated icon, or one or two letters, plus a tint.
   Used by the "Name this agent" popover and the agent profile form.
   -------------------------------------------------------------------------- */

export const SUGGESTED_AGENT_EMOJIS = [
  "🦉",
  "🐞",
  "📬",
  "📈",
  "✍️",
  "🛰️",
  "🧭",
  "🧪",
  "🛠️",
  "🔎",
  "🦊",
  "🐙",
  "🧹",
  "📣",
  "🧾",
  "🌱",
  "🤖",
  "🧠",
  "📚",
  "🗂️",
  "💬",
  "🚀",
  "🛡️",
  "🎯",
] as const;

type AvatarKind = AgentAvatar["kind"];

export type AgentAvatarPickerProps = {
  value: AgentAvatar;
  onChange: (avatar: AgentAvatar) => void;
  /** Used to seed letters when switching to the letters tab. */
  name?: string | undefined;
  className?: string | undefined;
};

function initialsFor(name: string | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "A").slice(0, 2);
  return (
    letters
      .replace(/[^\p{L}\p{N}]/gu, "")
      .slice(0, 2)
      .toUpperCase() || "A"
  );
}

export function AgentAvatarPicker({ value, onChange, name, className }: AgentAvatarPickerProps) {
  const id = useId();
  const [customEmoji, setCustomEmoji] = useState("");
  const emojiInvalid = customEmoji !== "" && !isSingleAgentAvatarEmoji(customEmoji);

  const switchKind = (kind: AvatarKind) => {
    if (kind === value.kind) return;
    if (kind === "emoji") onChange({ kind, emoji: SUGGESTED_AGENT_EMOJIS[0], hue: value.hue });
    else if (kind === "icon") onChange({ kind, icon: "bot", hue: value.hue });
    else onChange({ kind, letters: initialsFor(name), hue: value.hue });
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <SegmentedControl<AvatarKind>
        size="sm"
        aria-label="Avatar style"
        options={[
          { value: "emoji", label: "Emoji" },
          { value: "icon", label: "Icon" },
          { value: "letters", label: "Letters" },
        ]}
        value={value.kind}
        onValueChange={switchKind}
      />

      {value.kind === "emoji" ? (
        <div className="flex flex-col gap-2">
          <div role="listbox" aria-label="Emoji" className="grid grid-cols-8 gap-1">
            {SUGGESTED_AGENT_EMOJIS.map((emoji) => {
              const selected = value.emoji === emoji;
              return (
                <button
                  key={emoji}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={emoji}
                  onClick={() => onChange({ kind: "emoji", emoji, hue: value.hue })}
                  className={cn(
                    "grid h-9 place-items-center rounded-md text-xl leading-none transition-colors hover:bg-hover",
                    selected && "bg-selection ring-1 ring-border-strong",
                  )}
                  style={{
                    fontFamily:
                      '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif',
                  }}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
          <label htmlFor={`${id}-emoji`} className="sr-only">
            Any emoji
          </label>
          <Input
            id={`${id}-emoji`}
            suppressAutofill
            placeholder="Or type or paste any emoji"
            value={customEmoji}
            aria-invalid={emojiInvalid || undefined}
            onChange={(event) => {
              const next = event.target.value.trim();
              setCustomEmoji(next);
              if (isSingleAgentAvatarEmoji(next))
                onChange({ kind: "emoji", emoji: next, hue: value.hue });
            }}
          />
          {emojiInvalid ? <p className="text-2xs text-danger">Use a single emoji.</p> : null}
        </div>
      ) : null}

      {value.kind === "icon" ? (
        <div role="listbox" aria-label="Icon" className="grid grid-cols-8 gap-1">
          {AGENT_AVATAR_ICONS.map((icon: AgentAvatarIcon) => {
            const Icon = AGENT_AVATAR_ICON_COMPONENTS[icon];
            const selected = value.icon === icon;
            return (
              <button
                key={icon}
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={icon.replaceAll("-", " ")}
                onClick={() => onChange({ kind: "icon", icon, hue: value.hue })}
                className={cn(
                  "grid h-9 place-items-center rounded-md text-fg-label transition-colors hover:bg-hover",
                  selected && "bg-selection text-fg ring-1 ring-border-strong",
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
              </button>
            );
          })}
        </div>
      ) : null}

      {value.kind === "letters" ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-letters`} className="text-2xs text-fg-muted">
            One or two letters
          </label>
          <Input
            id={`${id}-letters`}
            suppressAutofill
            maxLength={2}
            value={value.letters}
            onChange={(event) => {
              const letters = event.target.value.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2);
              if (letters)
                onChange({ kind: "letters", letters: letters.toUpperCase(), hue: value.hue });
            }}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-fg-muted">Tint</span>
        <div role="radiogroup" aria-label="Tint" className="flex flex-wrap gap-2">
          {AGENT_AVATAR_HUES.map((hue) => {
            const selected = value.hue === hue;
            return (
              <button
                key={hue}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`Tint ${hue}`}
                onClick={() => onChange({ ...value, hue })}
                className={cn(
                  "size-6 rounded-[7px] transition-shadow",
                  selected && "ring-2 ring-brand ring-offset-2 ring-offset-surface",
                )}
                style={{ background: agentAvatarBackground(hue) }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
