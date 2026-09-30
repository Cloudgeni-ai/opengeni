import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { BrandMark, Wordmark } from "@/components/brand-mark";
import { useRail } from "@/components/rail/rail-context";
import { SwitcherBlock } from "@/components/rail/switcher-block";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The top of the main rail: a brand row (the mark and the "Opengeni" wordmark)
 * and, under it, the workspace picker at full rail width. Its spacing matches
 * the settings rail's top (12px, 32px brand row, 12px gap) so switching
 * between the two rails doesn't jump. Collapsed, only the mark stays.
 */
export function RailHeader() {
  const rail = useRail();
  return (
    <div className="flex shrink-0 flex-col gap-3 pt-3">
      <div
        className={cn(
          "flex h-8 min-w-0 items-center gap-2",
          rail.collapsed ? "justify-center px-2" : "justify-between px-2",
        )}
      >
        <Link
          to="/workspaces/$workspaceId/sessions"
          params={{ workspaceId: rail.workspaceId }}
          className="flex h-8 shrink-0 items-center gap-2 rounded-md px-1.5 text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Opengeni home"
        >
          <BrandMark className="w-5" />
          {!rail.collapsed ? <Wordmark className="text-[18px]" /> : null}
        </Link>
        {rail.isMobile ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close navigation"
            onClick={() => rail.setDrawerOpen(false)}
            className="pointer-coarse:size-11"
          >
            <XIcon className="size-4" />
          </Button>
        ) : null}
      </div>
      {!rail.collapsed ? <SwitcherBlock /> : null}
    </div>
  );
}
