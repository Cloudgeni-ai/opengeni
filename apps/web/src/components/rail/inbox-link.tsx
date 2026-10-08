import { Link, useRouterState } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";

import { useRail } from "@/components/rail/rail-context";
import { useAppContext } from "@/context";
import { hasInbox, inboxAttentionCount, useInbox } from "@/lib/inbox";
import { cn } from "@/lib/utils";

/** The Inbox entry, with how many things wait on the person. Only people have one. */
export function InboxLink() {
  const { accessContext } = useAppContext();
  if (!hasInbox(accessContext)) return null;
  return <PersonInboxLink />;
}

function PersonInboxLink() {
  const rail = useRail();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = pathname === `/workspaces/${rail.workspaceId}/inbox`;
  const { data } = useInbox();
  const count = inboxAttentionCount(data);
  const countLabel = count > 99 ? "99+" : String(count);
  return (
    <Link
      to="/workspaces/$workspaceId/inbox"
      params={{ workspaceId: rail.workspaceId }}
      data-active={active ? "true" : undefined}
      aria-label={count > 0 ? `Inbox, ${count} waiting` : "Inbox"}
      title={rail.collapsed ? (count > 0 ? `Inbox · ${count} waiting` : "Inbox") : undefined}
      onClick={() => rail.setDrawerOpen(false)}
      className={cn(
        "group relative flex h-8 items-center rounded-md text-sm font-normal text-fg-label outline-none transition-colors pointer-coarse:h-10",
        "hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50",
        "data-[active=true]:bg-selection data-[active=true]:text-fg data-[active=true]:hover:bg-selection",
        rail.collapsed ? "w-8 justify-center pointer-coarse:w-10" : "gap-2.5 px-2.5",
      )}
    >
      <span
        aria-hidden="true"
        className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand opacity-0 transition-opacity group-data-[active=true]:opacity-100"
      />
      <InboxIcon className="size-4 shrink-0" />
      {rail.collapsed ? null : <span className="min-w-0 truncate">Inbox</span>}
      {count > 0 ? (
        rail.collapsed ? (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 size-2 rounded-full bg-status-waiting ring-2 ring-surface"
          />
        ) : (
          <span
            aria-hidden="true"
            className="ml-auto min-w-5 rounded-full bg-status-waiting/15 px-1.5 text-center text-xs font-medium leading-5 tabular-nums text-fg"
          >
            {countLabel}
          </span>
        )
      ) : null}
    </Link>
  );
}
