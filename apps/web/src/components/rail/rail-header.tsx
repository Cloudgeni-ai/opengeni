import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
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
        className="flex shrink-0 items-center gap-2 rounded-md text-[15px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="OpenGeni home"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
          <BrandMark className="size-4" />
        </span>
        {!rail.collapsed ? <span className="hidden @[280px]:inline">OpenGeni</span> : null}
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
