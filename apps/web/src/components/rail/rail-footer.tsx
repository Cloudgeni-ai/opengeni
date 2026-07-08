// Pinned rail footer: the collapse-toggle chevron and the signed-in user menu
// (account/sign-out, depending on auth mode). Collapsed → just the avatar +
// a collapse chevron, both with tooltips.
import { Link } from "@tanstack/react-router";
import {
  ChevronsLeftIcon,
  ChevronsRightIcon,
  LockIcon,
  LogOutIcon,
  SettingsIcon,
  UserIcon,
} from "lucide-react";
import { toast } from "sonner";

import { useRail } from "@/components/rail/rail-context";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/context";

function userInitial(label: string): string {
  return (label.trim()[0] ?? "U").toUpperCase();
}

export function RailFooter() {
  const rail = useRail();
  const context = useAppContext();
  const managed = context.clientConfig.auth.mode === "managedSession";
  const displayName =
    context.authSession?.user.name ??
    context.authSession?.user.email ??
    context.accessContext.subjectLabel ??
    context.accessContext.subjectId;
  const secondary = context.authSession?.user.email ?? context.accessContext.subjectId;
  const image = context.authSession?.user.image ?? undefined;

  return (
    <div className="mt-auto border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div
        className={rail.collapsed ? "grid justify-items-center gap-1" : "flex items-center gap-1.5"}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Account menu"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none pointer-coarse:py-2"
            >
              <Avatar size="sm">
                {image ? <AvatarImage src={image} alt="" /> : null}
                <AvatarFallback className="bg-surface-3 text-2xs text-fg-muted">
                  {userInitial(displayName)}
                </AvatarFallback>
              </Avatar>
              {!rail.collapsed ? (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-fg">{displayName}</span>
                  {secondary && secondary !== displayName ? (
                    <span className="block truncate text-2xs text-fg-subtle">{secondary}</span>
                  ) : null}
                </span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side={rail.collapsed ? "right" : "top"}
            className="min-w-56"
          >
            <DropdownMenuLabel className="grid gap-0.5">
              <span className="truncate text-sm">{displayName}</span>
              {secondary && secondary !== displayName ? (
                <span className="truncate text-xs font-normal text-fg-subtle">{secondary}</span>
              ) : null}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId: rail.workspaceId }}
              >
                <SettingsIcon className="size-4" />
                Organization settings
              </Link>
            </DropdownMenuItem>
            {managed ? (
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  void context
                    .handleManagedSignOut()
                    .catch((error) =>
                      toast.error("Sign out failed", { description: String(error) }),
                    );
                }}
              >
                <LogOutIcon className="size-4" />
                Sign out
              </DropdownMenuItem>
            ) : context.keyAuthRequired ? (
              <DropdownMenuItem variant="destructive" onSelect={() => context.forgetAccessKey()}>
                <LockIcon className="size-4" />
                Clear access key
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled>
                <UserIcon className="size-4" />
                {context.accessContext.mode} access
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={rail.collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={rail.toggleCollapsed}
              className="shrink-0 text-fg-subtle hover:text-fg"
            >
              {rail.collapsed ? (
                <ChevronsRightIcon className="size-4" />
              ) : (
                <ChevronsLeftIcon className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {rail.collapsed ? "Expand sidebar" : "Collapse sidebar"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
