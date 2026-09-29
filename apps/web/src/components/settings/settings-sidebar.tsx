import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ChevronRightIcon, MenuIcon, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import { BrandMark, Wordmark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { PageHeader, PageHeaderStyleProvider } from "@/components/ui/page-header";
import { SectionVariantProvider } from "@/components/ui/section";
import { NavGroup, NavItem, SettingsNav } from "@/components/ui/settings-nav";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { SettingsActionsSlotContext } from "./settings-header-actions";

/**
 * The settings shell for workspace, organization and personal settings.
 *
 * Settings is a mode of the left rail: entering settings swaps the main rail
 * (sessions) for the settings rail, and its back link leaves settings and
 * restores the main rail. Below 1024px the rail folds into a header with the
 * back link, the current page and a Menu button that opens the rail in a
 * drawer.
 *
 * Pages inside the shell drop their header icon; the settings rail gives context.
 */

/** Rail 240px beside the content; one column with a header row below 1024px. */
export const SETTINGS_SHELL_CLASS =
  "grid h-full min-h-0 w-full min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-bg text-fg lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-1";

const NARROW_QUERY = "(max-width: 1023px)";

export interface SettingsRailItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** The router link for this destination, without children (`<Link to=... />`). */
  link: ReactElement;
  /** A purple dot for "needs you". */
  attention?: boolean;
}

export interface SettingsRailGroup {
  label?: string;
  items: SettingsRailItem[];
}

export interface SettingsShellPage {
  title: string;
  description?: ReactNode;
  /** The page's one primary action. Pages can also portal it in with SettingsHeaderActions. */
  actions?: ReactNode;
}

export interface SettingsShellProps {
  /** Accessible name of the settings rail, "Workspace settings". */
  label: string;
  /** The link that leaves this area ("Back to sessions"), without children. */
  back: { link: ReactElement; label: string };
  /** The brand link at the top of the rail, without children. */
  home: ReactElement;
  /** The scope under the back link: a switcher or the scope's name. */
  scope?: ReactNode;
  groups: SettingsRailGroup[];
  /** The item that is current. */
  activeId: string | null;
  /** A link out of this area at the bottom of the rail: "Organization: Acme →". */
  footer?: ReactNode;
  /** The current page's name, for the narrow header. */
  currentPage: string;
  /**
   * The page header of a settings page. `null` when the page brings its own: a
   * sub-page (an account, a key, a form) or a full page (Agents, Variable sets).
   */
  page: SettingsShellPage | null;
  /**
   * `settings`: the shell draws the standard-width scroller around the page.
   * `page`: the page brings its own `ContentPage` (Agents, Variable sets).
   */
  layout?: "settings" | "page";
  /** Workspace-wide state above the page (the paused banner). */
  notice?: ReactNode;
  children: ReactNode;
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(NARROW_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

/** Renders a router link element with our own children and classes. */
function LinkShell({
  link,
  className,
  children,
  ...props
}: {
  link: ReactElement;
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
}) {
  const linkProps = link.props as { className?: string };
  const Element = link.type as React.ElementType;
  return (
    <Element {...(link.props as object)} {...props} className={cn(className, linkProps.className)}>
      {children}
    </Element>
  );
}

function SettingsRail({
  label,
  back,
  home,
  scope,
  groups,
  activeId,
  footer,
  className,
  onNavigate,
}: Pick<
  SettingsShellProps,
  "label" | "back" | "home" | "scope" | "groups" | "activeId" | "footer"
> & { className?: string; onNavigate?: () => void }) {
  return (
    <SettingsNav
      variant="rail"
      aria-label={label}
      data-settings-rail
      className={cn(
        "og-rail-glow h-full w-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-2",
        className,
      )}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a[href]")) onNavigate?.();
      }}
      header={
        <div className="flex min-w-0 flex-col gap-3">
          <LinkShell
            link={home}
            aria-label="Opengeni home"
            className="flex h-8 w-fit shrink-0 items-center gap-2 rounded-md px-1.5 text-fg outline-none focus-visible:ring-2 focus-visible:ring-brand/55"
          >
            <BrandMark className="w-5" />
            <Wordmark className="text-[18px]" />
          </LinkShell>
          <NavItem asChild label={back.label} icon={<ArrowLeftIcon />}>
            {back.link}
          </NavItem>
          {scope ? <div className="min-w-0">{scope}</div> : null}
        </div>
      }
      footer={footer}
    >
      {groups.map((group, index) => (
        <NavGroup key={group.label ?? `group-${index}`} label={group.label}>
          {group.items.map((item) => {
            const Icon = item.icon;
            return (
              <NavItem
                key={item.id}
                asChild
                label={item.label}
                icon={<Icon />}
                active={activeId === item.id}
                attention={item.attention}
              >
                {item.link}
              </NavItem>
            );
          })}
        </NavGroup>
      ))}
    </SettingsNav>
  );
}

/** "Organization: Acme Robotics →" at the bottom of the settings rail. */
export function SettingsRailOutLink({
  groupLabel,
  label,
  icon: Icon,
  link,
}: {
  groupLabel: string;
  label: string;
  icon: LucideIcon;
  /** Omit when the viewer can't open it: the name shows as text. */
  link?: ReactElement;
}) {
  return (
    <NavGroup label={groupLabel}>
      {link ? (
        <NavItem asChild label={label} icon={<Icon />} trailingIcon={<ChevronRightIcon />}>
          {link}
        </NavItem>
      ) : (
        <div className="flex h-8 min-w-0 items-center gap-2.5 px-2.5 text-sm font-normal text-fg-label">
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">{label}</span>
        </div>
      )}
    </NavGroup>
  );
}

export function SettingsShell({
  label,
  back,
  home,
  scope,
  groups,
  activeId,
  footer,
  currentPage,
  page,
  layout = "settings",
  notice,
  children,
}: SettingsShellProps) {
  const narrow = useNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!narrow) setMenuOpen(false);
  }, [narrow]);
  useEffect(() => setMenuOpen(false), [activeId, currentPage]);

  const railProps = { label, back, home, scope, groups, activeId, footer };

  const navigation = narrow ? (
    <header className="flex min-w-0 items-center gap-2 border-b border-border bg-bg px-2 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))]">
      <LinkShell
        link={back.link}
        aria-label={back.label}
        className="flex size-11 shrink-0 items-center justify-center rounded-md text-fg-muted outline-none transition-colors hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-brand/55"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
      </LinkShell>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs leading-4.5 text-fg-subtle">{label}</p>
        <p className="truncate text-sm font-medium text-fg">{currentPage}</p>
      </div>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 pointer-coarse:h-11"
            aria-label={`Open ${label.toLowerCase()} menu`}
          >
            <MenuIcon aria-hidden="true" />
            Menu
          </Button>
        </SheetTrigger>
        <SheetContent
          side="left"
          className="w-[min(20rem,calc(100vw-2rem))] max-w-none gap-0 border-border bg-bg p-0 sm:max-w-none"
        >
          <SheetTitle className="sr-only">{label}</SheetTitle>
          <SheetDescription className="sr-only">Choose a settings page.</SheetDescription>
          <SettingsRail {...railProps} onNavigate={() => setMenuOpen(false)} />
        </SheetContent>
      </Sheet>
    </header>
  ) : (
    <div className="min-h-0 min-w-0 border-r border-border">
      <SettingsRail {...railProps} className="border-r-0" />
    </div>
  );

  const body = (
    <>
      {page ? (
        <PageHeader
          title={page.title}
          description={page.description}
          actions={
            <>
              {page.actions}
              <span ref={setActionsSlot} className="contents" />
            </>
          }
        />
      ) : null}
      <div className={page ? "mt-8" : undefined}>{children}</div>
    </>
  );

  return (
    <div className={SETTINGS_SHELL_CLASS}>
      {navigation}
      {/* A labelled region: the app shell already provides the one <main>. */}
      <section
        aria-label={page?.title ?? currentPage}
        data-canvas
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {notice}
        <SettingsActionsSlotContext.Provider value={actionsSlot}>
          <PageHeaderStyleProvider icon="hide">
            {/* Settings sections are grouped cards: heading above, rows in one card. */}
            <SectionVariantProvider variant="group">
              {layout === "page" ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                  {children}
                </div>
              ) : (
                <ContentPage
                  width="standard"
                  // Pages that bring their own ContentPage (a detail page) join this
                  // scroller instead of nesting a second scroller and gutter.
                  className="pb-16 lg:pt-8 [&_[data-slot=content-page]]:overflow-visible [&_[data-slot=content-page-inner]]:max-w-none [&_[data-slot=content-page-inner]]:p-0"
                >
                  {body}
                </ContentPage>
              )}
            </SectionVariantProvider>
          </PageHeaderStyleProvider>
        </SettingsActionsSlotContext.Provider>
      </section>
    </div>
  );
}

/** Home link for a settings rail: sessions of a workspace, or the app root. */
export function settingsHomeLink(workspaceId?: string): ReactElement {
  return workspaceId ? (
    <Link to="/workspaces/$workspaceId/sessions" params={{ workspaceId }} />
  ) : (
    <Link to="/" />
  );
}
