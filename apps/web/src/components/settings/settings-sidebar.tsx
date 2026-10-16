import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, MenuIcon, type LucideIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { BrandMark, Wordmark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { PageHeader, PageHeaderStyleProvider } from "@/components/ui/page-header";
import { SectionVariantProvider } from "@/components/ui/section-variant";
import { NavGroup, NavItem, SettingsNav } from "@/components/ui/settings-nav";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Toolbar, ToolbarSearch } from "@/components/ui/toolbar";
import { desktopBridge, windowControlsInPage } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { SettingsActionsSlotContext } from "./settings-header-actions";
import { searchSettings, settingsSearchEntries, type SettingsSearchEntry } from "./settings-search";

/**
 * The settings shell for workspace, organization and personal settings.
 *
 * Settings is a mode of the left rail: entering settings swaps the main rail
 * (sessions) for the settings rail, and its back link leaves settings and
 * restores the main rail. The rail lists every settings page the person can
 * use in one place, in labeled sections: Workspace, Organization and Your
 * account, each naming the workspace or organization it configures. A search
 * field above the sections finds any of those pages, and the settings inside
 * them, by name. Below 1024px the rail folds into a header with the back
 * link, the current page and a Menu button that opens the rail in a drawer.
 *
 * Pages inside the shell drop their header icon; the settings rail gives context.
 */

/**
 * Rail 240px beside the content; one column with a header row below 1024px. In
 * the desktop app the rail stays down to 640px and matches the main rail's
 * width, so moving between sessions and settings keeps the page edge still.
 */
export const SETTINGS_SHELL_CLASS =
  "grid h-full min-h-0 w-full min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-bg text-fg lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-1 desktop-wide:grid-cols-[18rem_minmax(0,1fr)] desktop-wide:grid-rows-1";

const NARROW_QUERY = desktopBridge ? "(max-width: 639px)" : "(max-width: 1023px)";

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

/**
 * One scope of settings: "Workspace", "Organization" or "Your account". Its
 * header is the only heading in the section: the scope, with the workspace or
 * organization it configures as quiet meta. Groups inside are set apart by
 * space, without labels.
 */
export interface SettingsRailSection {
  id: string;
  /** The scope, in sentence case: "Workspace". */
  label: string;
  /** Which one: "Design preview", "Acme Robotics", the account's email. */
  meta?: string;
  groups: SettingsRailGroup[];
}

export interface SettingsShellPage {
  title: string;
  description?: ReactNode;
  /** The page's one primary action. Pages can also portal it in with SettingsHeaderActions. */
  actions?: ReactNode;
}

export interface SettingsShellProps {
  /** Accessible name of the settings rail, "Settings". */
  label: string;
  /** The link that leaves this area ("Back to sessions"), without children. */
  back: { link: ReactElement; label: string };
  /** The brand link at the top of the rail, without children. */
  home: ReactElement;
  /** The one picker under the back link: the same workspace picker as the main rail. */
  scope?: ReactNode;
  /** Workspace, Organization and Your account, in that order. */
  sections: SettingsRailSection[];
  /** The item that is current. */
  activeId: string | null;
  /** The current page's name, for the narrow header. */
  currentPage: string;
  /** The current page's scope for the narrow header: "Organization · Acme Robotics". */
  currentScope?: string;
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
  "aria-current"?: "page" | undefined;
  "data-settings-search-result"?: string;
}) {
  const linkProps = link.props as { className?: string };
  const Element = link.type as React.ElementType;
  return (
    <Element {...(link.props as object)} {...props} className={cn(className, linkProps.className)}>
      {children}
    </Element>
  );
}

function SettingsRailSectionView({
  section,
  activeId,
  first,
}: {
  section: SettingsRailSection;
  activeId: string | null;
  first: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={section.label}
      data-settings-section={section.id}
      className={cn("flex min-w-0 flex-col gap-3", !first && "border-t border-border pt-4")}
    >
      <div className="min-w-0 px-2.5">
        <p className="text-sm leading-5 font-medium text-fg">{section.label}</p>
        {section.meta ? (
          <p className="truncate text-xs leading-4.5 text-fg-muted" title={section.meta}>
            {section.meta}
          </p>
        ) : null}
      </div>
      {section.groups.map((group, index) => (
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
    </div>
  );
}

function SettingsRail({
  label,
  back,
  home,
  scope,
  sections,
  activeId,
  className,
  onNavigate,
}: Pick<SettingsShellProps, "label" | "back" | "home" | "scope" | "sections" | "activeId"> & {
  className?: string;
  onNavigate?: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const entries = useMemo(() => settingsSearchEntries(sections), [sections]);
  const results = useMemo(() => searchSettings(entries, query), [entries, query]);
  const searching = query.trim().length > 0;
  const resultsId = useId();
  // The rail is long (workspace and organization pages): keep the current page in view.
  useLayoutEffect(() => {
    if (searching) return;
    ref.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, searching]);

  const resultLinks = () =>
    Array.from(
      ref.current?.querySelectorAll<HTMLAnchorElement>("[data-settings-search-result]") ?? [],
    );
  // Down from the field moves into the results; Enter opens the best one.
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      resultLinks()[0]?.focus();
    } else if (event.key === "Enter") {
      const first = resultLinks()[0];
      if (first) {
        event.preventDefault();
        first.click();
      }
    }
  };
  // Up and down move between results; up from the first returns to the field.
  const onResultsKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Escape") return;
    const links = resultLinks();
    const index = links.findIndex((link) => link === document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const field = ref.current?.querySelector<HTMLInputElement>("[data-settings-search] input");
    if (event.key === "Escape") {
      setQuery("");
      field?.focus();
    } else if (event.key === "ArrowDown") {
      links[Math.min(index + 1, links.length - 1)]?.focus();
    } else if (index === 0) {
      field?.focus();
    } else {
      links[index - 1]?.focus();
    }
  };

  return (
    <SettingsNav
      ref={ref}
      variant="rail"
      aria-label={label}
      data-settings-rail
      className={cn(
        "og-rail-glow h-full w-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-2",
        className,
      )}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a[href]")) {
          if (event.target.closest("[data-settings-search-result]")) setQuery("");
          onNavigate?.();
        }
      }}
      header={
        <div className="flex min-w-0 flex-col gap-3">
          {windowControlsInPage ? (
            // The macOS window controls take this row; it still moves the window.
            <div data-window-drag aria-hidden="true" className="h-8 shrink-0" />
          ) : (
            <LinkShell
              link={home}
              aria-label="Opengeni home"
              className="flex h-8 w-fit shrink-0 items-center gap-2 rounded-md px-1.5 text-fg outline-none focus-visible:ring-2 focus-visible:ring-brand/55"
            >
              <BrandMark className="w-5" />
              <Wordmark className="text-[18px]" />
            </LinkShell>
          )}
          <NavItem asChild label={back.label} icon={<ArrowLeftIcon />}>
            {back.link}
          </NavItem>
          {scope ? <div className="min-w-0">{scope}</div> : null}
          <Toolbar data-settings-search>
            <ToolbarSearch
              value={query}
              onValueChange={setQuery}
              onKeyDown={onSearchKeyDown}
              placeholder="Search settings"
              aria-controls={searching ? resultsId : undefined}
            />
          </Toolbar>
        </div>
      }
    >
      {searching ? (
        <SettingsSearchResults
          id={resultsId}
          query={query}
          results={results}
          activeId={activeId}
          onKeyDown={onResultsKeyDown}
          onClear={() => {
            setQuery("");
            ref.current?.querySelector<HTMLInputElement>("[data-settings-search] input")?.focus();
          }}
        />
      ) : (
        sections.map((section, index) => (
          <SettingsRailSectionView
            key={section.id}
            section={section}
            activeId={activeId}
            first={index === 0}
          />
        ))
      )}
    </SettingsNav>
  );
}

/** Search results in place of the rail's sections: the page or setting, and where it lives. */
function SettingsSearchResults({
  id,
  query,
  results,
  activeId,
  onKeyDown,
  onClear,
}: {
  id: string;
  query: string;
  results: SettingsSearchEntry[];
  activeId: string | null;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onClear: () => void;
}) {
  return (
    <div id={id} role="group" aria-label="Search results" className="flex min-w-0 flex-col">
      <p className="sr-only" role="status">
        {results.length === 1 ? "1 result" : `${results.length} results`}
      </p>
      {results.length === 0 ? (
        <div className="flex min-w-0 flex-col items-start gap-1 px-2.5 py-2 text-sm leading-5 text-fg-muted">
          <p className="m-0 min-w-0 break-words">No settings match “{query.trim()}”.</p>
          <button
            type="button"
            onClick={onClear}
            className="cursor-pointer rounded-sm font-medium text-fg underline decoration-border-strong underline-offset-4 outline-none hover:decoration-fg focus-visible:ring-2 focus-visible:ring-brand/55"
          >
            Clear search
          </button>
        </div>
      ) : (
        <ul className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0" onKeyDown={onKeyDown}>
          {results.map((result) => {
            const Icon = result.icon;
            const current = result.id === activeId;
            return (
              <li key={result.id} className="min-w-0">
                <LinkShell
                  link={result.link}
                  data-settings-search-result=""
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "flex min-w-0 items-start gap-2.5 rounded-[10px] px-2.5 py-1.5 text-sm text-fg-label outline-none transition-colors duration-[120ms] hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-brand/55 pointer-coarse:py-2.5",
                    current && "bg-selection text-fg hover:bg-selection",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="flex h-5 w-4 shrink-0 items-center justify-center [&_svg]:size-4"
                  >
                    <Icon />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate leading-5">{result.label}</span>
                    <span className="truncate text-xs leading-4.5 text-fg-muted">
                      {result.location}
                    </span>
                  </span>
                </LinkShell>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function SettingsShell({
  label,
  back,
  home,
  scope,
  sections,
  activeId,
  currentPage,
  currentScope,
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

  const railProps = { label, back, home, scope, sections, activeId };

  const navigation = narrow ? (
    <header className="flex min-w-0 items-center gap-2 border-b border-border bg-bg px-2 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))]">
      <LinkShell
        link={back.link}
        aria-label={back.label}
        className="flex size-11 shrink-0 items-center justify-center rounded-md text-fg-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-brand/55"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
      </LinkShell>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs leading-4.5 text-fg-muted">{currentScope ?? label}</p>
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
                // A full page keeps its own scroller but starts its title at the
                // same height as every other settings page.
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:[&>[data-slot=content-page]>[data-slot=content-page-inner]]:pt-8 desktop-wide:[&>[data-slot=content-page]>[data-slot=content-page-inner]]:pt-8">
                  {children}
                </div>
              ) : (
                <ContentPage
                  width="standard"
                  // Pages that bring their own ContentPage (a detail page) join this
                  // scroller instead of nesting a second scroller and gutter.
                  className="pb-16 lg:pt-8 desktop-wide:pt-8 [&_[data-slot=content-page]]:overflow-visible [&_[data-slot=content-page-inner]]:max-w-none [&_[data-slot=content-page-inner]]:p-0"
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
