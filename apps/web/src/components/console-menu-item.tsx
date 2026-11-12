import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { useAppContext } from "@opengeni/react/app/app-context";
import { administersOrganization } from "@opengeni/react/app/lib/workspaces";
import { useNavigate } from "@tanstack/react-router";
import { LayoutDashboardIcon } from "lucide-react";

/**
 * Opens Opengeni Console for the current workspace's organization: shown to
 * its owners and admins, the people Console is for.
 */
export function ConsoleMenuItem({
  workspaceId,
  className,
}: {
  workspaceId: string;
  className?: string | undefined;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const accountId = context.workspaces.find((workspace) => workspace.id === workspaceId)?.accountId;
  if (
    !accountId ||
    !administersOrganization({
      accessContext: context.accessContext,
      clientConfig: context.clientConfig,
      accountId,
    })
  ) {
    return null;
  }
  return (
    <DropdownMenuItem
      className={className}
      onSelect={() => void navigate({ to: "/console", search: { org: accountId } })}
    >
      <LayoutDashboardIcon className="size-4" />
      Opengeni Console
    </DropdownMenuItem>
  );
}
