// The account button at the foot of the rail: avatar and name as one button, a
// dot on the avatar while organization invitations are pending. Collapsed, only
// the avatar shows. Both account menus (single and browser accounts) use it.
import type { ComponentProps } from "react";
import { Loader2Icon } from "lucide-react";

import { OrganizationInvitationDot } from "@/components/organization-invitations";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

function userInitial(label: string): string {
  return (label.trim()[0] ?? "U").toUpperCase();
}

export function AccountTrigger({
  displayName,
  image,
  pendingCount = 0,
  collapsed,
  busy = false,
  className,
  ...props
}: {
  displayName: string;
  image: string | undefined;
  pendingCount?: number;
  collapsed: boolean;
  busy?: boolean;
} & ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-md text-left transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:bg-hover motion-reduce:transition-none forced-colors:border forced-colors:border-transparent forced-colors:focus:border-[Highlight]",
        collapsed
          ? "size-8 shrink-0 justify-center pointer-coarse:size-11"
          : "min-h-11 w-full px-1.5 py-1 pointer-coarse:py-2",
        className,
      )}
    >
      <span className="relative shrink-0">
        <Avatar size="sm">
          {image ? <AvatarImage src={image} alt="" /> : null}
          <AvatarFallback className="bg-surface-3 text-2xs text-fg-muted">
            {userInitial(displayName)}
          </AvatarFallback>
        </Avatar>
        <OrganizationInvitationDot pendingCount={pendingCount} />
      </span>
      {!collapsed ? (
        <span className="min-w-0 flex-1 truncate text-sm font-normal text-fg-label">
          {displayName}
        </span>
      ) : null}
      {busy && !collapsed ? (
        <Loader2Icon
          className="size-3.5 shrink-0 animate-spin text-fg-subtle motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : null}
    </button>
  );
}
