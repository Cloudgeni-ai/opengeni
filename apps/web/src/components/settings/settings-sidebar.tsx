import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, MenuIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";

export const SETTINGS_SHELL_CLASS =
  "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-bg text-fg lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-1";
export const SETTINGS_NAV_CLASS = "mt-1 flex flex-col gap-1";
export function settingsNavItemClass(selected: boolean) {
  return cn(
    "flex h-9 min-w-0 items-center gap-2 rounded-md px-2.5 text-sm transition-colors lg:w-full",
    selected
      ? "bg-surface-3 font-medium text-fg"
      : "text-fg-muted hover:bg-surface-2 hover:text-fg",
  );
}

export function SettingsSidebar({
  workspaceId,
  label,
  identity,
  currentPage,
  children,
}: {
  workspaceId?: string;
  label: string;
  identity: ReactNode;
  currentPage: string;
  children: ReactNode;
}) {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 1024 : false,
  );
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => {
      setNarrow(query.matches);
      if (!query.matches) setOpen(false);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => setOpen(false), [workspaceId, currentPage]);

  const sidebar = (
    <aside
      aria-label={label}
      className="h-full min-h-0 overflow-y-auto overscroll-y-contain border-border bg-surface/35 lg:border-r"
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a[href]")) setOpen(false);
      }}
    >
      <div className="flex min-h-full min-w-0 flex-col px-3 py-3 lg:py-4">
        <Link
          to={workspaceId ? "/workspaces/$workspaceId/sessions" : "/"}
          params={workspaceId ? { workspaceId } : undefined}
          className="flex h-9 shrink-0 items-center gap-2 rounded-md px-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-2"
        >
          <span className="flex size-6 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <BrandMark className="size-4" />
          </span>
          OpenGeni
        </Link>
        <Link
          to={workspaceId ? "/workspaces/$workspaceId/sessions" : "/"}
          params={workspaceId ? { workspaceId } : undefined}
          className="mt-3 inline-flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg lg:mt-5"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
          {workspaceId ? "Back to sessions" : "Back to OpenGeni"}
        </Link>
        <div className="mt-4 min-w-0 px-2 lg:mt-6">
          <p className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">{label}</p>
          {identity}
        </div>
        {children}
      </div>
    </aside>
  );
  if (!narrow) return sidebar;
  return (
    <header className="flex min-w-0 items-center gap-3 border-b border-border bg-surface/35 px-4 py-2">
      <Link
        to={workspaceId ? "/workspaces/$workspaceId/sessions" : "/"}
        params={workspaceId ? { workspaceId } : undefined}
        aria-label={workspaceId ? "Back to sessions" : "Back to OpenGeni"}
        className="flex size-10 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-brand"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
      </Link>
      <div className="min-w-0 flex-1">
        <p className="truncate text-2xs text-fg-subtle">{label}</p>
        <p className="truncate text-sm font-medium">{currentPage}</p>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            className="min-h-10 shrink-0"
            aria-label={`Open ${label.toLowerCase()} menu`}
          >
            <MenuIcon aria-hidden="true" className="size-4" />
            Menu
          </Button>
        </SheetTrigger>
        <SheetContent
          side="left"
          className="w-[min(20rem,calc(100vw-2rem))] max-w-none gap-0 border-border bg-bg p-0 sm:max-w-none"
        >
          <SheetTitle className="sr-only">{label}</SheetTitle>
          <SheetDescription className="sr-only">
            Switch workspace or organization and choose a settings page.
          </SheetDescription>
          {sidebar}
        </SheetContent>
      </Sheet>
    </header>
  );
}
