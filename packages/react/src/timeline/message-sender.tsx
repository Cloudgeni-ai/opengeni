import { createContext, useContext, type ReactNode } from "react";

import { cn } from "../lib/cn";
import type { MessageSender, UserMessageItem } from "./types";

/**
 * Draws who sent a person's message. The host decides: return null for the
 * viewer's own messages, or when it has no identity to show for a sender.
 */
export type RenderMessageSender = (sender: MessageSender, item: UserMessageItem) => ReactNode;

export const MessageSenderContext = createContext<RenderMessageSender | undefined>(undefined);

/** The sender line above a message bubble, when the host draws one. */
export function MessageSenderSlot({ item }: { item: UserMessageItem }) {
  const render = useContext(MessageSenderContext);
  if (!render || !item.sender) return null;
  const content = render(item.sender, item);
  if (content === null || content === undefined || content === false) return null;
  return <div className="flex max-w-full min-w-0 justify-end px-1">{content}</div>;
}

function initials(name: string): string {
  const isEmail = name.includes("@");
  const words = name
    .replace(/@.*$/u, "")
    .split(/[\s._-]+/u)
    .filter(Boolean);
  // "Kari Nordmann" → KN; "ola.normann.x@example.com" → ON.
  const picked = words.length > 1 ? [words[0]!, isEmail ? words[1]! : words.at(-1)!] : words;
  const letters = picked.map((word) => Array.from(word)[0] ?? "").join("");
  return letters.toUpperCase() || "?";
}

/** A small avatar and a name, for {@link RenderMessageSender}. */
export function MessageSenderLabel({
  name,
  avatarUrl,
  className,
}: {
  name: string;
  /** A same-origin or otherwise allowed image; initials are shown without one. */
  avatarUrl?: string | null | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1.5 text-og-xs text-og-fg-muted",
        className,
      )}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          className="size-4 shrink-0 rounded-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span
          aria-hidden="true"
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-og-surface-2 text-[10px] leading-none font-semibold text-og-fg-muted"
        >
          {initials(name)}
        </span>
      )}
      <span className="min-w-0 truncate font-medium">{name}</span>
    </span>
  );
}
