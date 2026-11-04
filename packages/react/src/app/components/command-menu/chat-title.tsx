/**
 * A chat's title in the command menu and the Control+Tab list. A sub-agent
 * chat also says, quietly, which chat it belongs to ("in Release review"), so
 * two workers with similar names can be told apart. The title keeps the room
 * it needs; the parent's name gives way first when space runs out.
 */
import type { ReactNode } from "react";

export function ChatTitleInParent(props: { title: ReactNode; parentTitle: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
      <span className="min-w-0 truncate">{props.title}</span>
      <span
        data-chat-parent=""
        className="min-w-14 max-w-[60%] shrink-3 truncate text-xs text-fg-muted"
      >
        in {props.parentTitle}
      </span>
    </span>
  );
}
