import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { useNavigate } from "@tanstack/react-router";
import { CircleUserRoundIcon } from "lucide-react";

/**
 * Opens My things: your own logins, model plans and machines in this
 * workspace's organization, and where each one works.
 */
export function MyThingsMenuItem({
  workspaceId,
  className,
}: {
  workspaceId: string;
  className?: string | undefined;
}) {
  const navigate = useNavigate();
  return (
    <DropdownMenuItem
      className={className}
      onSelect={() =>
        void navigate({
          to: "/workspaces/$workspaceId/settings",
          params: { workspaceId },
          search: { section: "mine" },
        })
      }
    >
      <CircleUserRoundIcon className="size-4" />
      My things
    </DropdownMenuItem>
  );
}
