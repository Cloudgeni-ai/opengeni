import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { BrandMark, Wordmark } from "@/components/brand-mark";
import { useRail } from "@/components/rail/rail-context";
import { SwitcherBlock } from "@/components/rail/switcher-block";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function RailHeader() {
  const rail = useRail();
  return (
    <div
      className={cn(
        "@container flex h-12 shrink-0 items-center gap-2",
        rail.collapsed ? "justify-center px-2" : "px-3",
      )}
    >
      <Link
        to="/workspaces/$workspaceId/sessions"
        params={{ workspaceId: rail.workspaceId }}
        className="flex h-8 shrink-0 items-center gap-2 rounded-md px-1 text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Opengeni home"
      >
        <BrandMark className="w-5" />
        {!rail.collapsed ? <Wordmark className="hidden text-[18px] @[280px]:inline" /> : null}
      </Link>
      {!rail.collapsed ? <SwitcherBlock inline /> : null}
      {rail.isMobile ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close navigation"
          onClick={() => rail.setDrawerOpen(false)}
          className="ml-auto pointer-coarse:size-11"
        >
          <XIcon className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}
