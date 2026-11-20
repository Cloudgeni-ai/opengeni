import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { useRail } from "@opengeni/react/app/components/rail/rail-context";
import { useNavigate } from "@tanstack/react-router";
import { PanelLeftIcon } from "lucide-react";

/** Opens the Sidebar page: your links and groups (and the workspace default, for admins). */
export function CustomizeSidebarMenuItem({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const rail = useRail();
  return (
    <DropdownMenuItem
      onSelect={() => {
        rail.setDrawerOpen(false);
        void navigate({ to: "/workspaces/$workspaceId/sidebar", params: { workspaceId } });
      }}
    >
      <PanelLeftIcon className="size-4" />
      Customize sidebar
    </DropdownMenuItem>
  );
}
