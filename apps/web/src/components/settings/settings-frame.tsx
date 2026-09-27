import { ChevronLeftIcon, ChevronRightIcon, type LucideIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { ContentPage } from "@/components/ui/content-layout";
import { PageHeader, PageHeaderStyleProvider } from "@/components/ui/page-header";
import { NavGroup, NavItem, SettingsNav } from "@/components/ui/settings-nav";
import { cn } from "@/lib/utils";

/**
 * The one settings frame for workspace, organization and personal settings.
 *
 * The main rail never swaps: settings render inside the content area, with a
 * 200px sub-nav column beside the page. Where the content area is too narrow
 * for both (a laptop with the rail open, a phone), the sub-nav becomes a page
 * of its own (the settings list) and every settings page gets a "Settings"
 * back link above its title.
 *
 * Pages inside the frame drop their header icon; the sub-nav gives context.
 */

export interface SettingsFrameItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** The router link for this destination, without children (`<Link to=... />`). */
  link: ReactElement;
  /** A purple dot for "needs you". */
  attention?: boolean;
}

export interface SettingsFrameGroup {
  label?: string;
  items: SettingsFrameItem[];
}

export interface SettingsFramePage {
  title: string;
  description?: ReactNode;
  /** The page's one primary action. Pages can also portal it in with SettingsHeaderActions. */
  actions?: ReactNode;
}

export interface SettingsFrameProps {
  /** Accessible name of the sub-nav, "Workspace settings". */
  label: string;
  /** The sub-nav's small title and the settings list's title. */
  heading: string;
  /** The scope under the heading: the workspace or organization name. */
  subheading?: ReactNode;
  groups: SettingsFrameGroup[];
  /** The item that is current. */
  activeId: string | null;
  /**
   * The URL asked for the settings list itself (no page). Where the sub-nav has
   * room the caller's page (usually General) shows instead.
   */
  indexRequested?: boolean;
  /** Link back to the settings list (`<Link ... />` without children). */
  indexLink: ReactElement;
  /** A link out of this area under the items: "Organization: Acme →". */
  footer?: ReactNode;
  /** A line above the sub-nav heading, for example "Back to OpenGeni". */
  header?: ReactNode;
  /** The page header. `null` when the page brings its own (a detail or form page). */
  page: SettingsFramePage | null;
  /** Rendered above the page, under the back link (a scope notice). */
  banner?: ReactNode;
  /**
   * The page is a sub-page with its own back link (a detail or form page), so
   * the narrow frame's "Settings" link would stack a second one above it.
   */
  ownBackLink?: boolean;
  children: ReactNode;
}

/** Sub-nav 200 + gap 40 + the narrowest page that keeps controls in their column. */
const COLUMN_MIN_WIDTH = 200 + 40 + 640 + 64;

const SettingsActionsSlotContext = createContext<HTMLElement | null>(null);

/**
 * Page header actions, rendered from inside the page body so the page decides
 * (for example, hide "Create API key" while the empty state shows it).
 */
export function SettingsHeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(SettingsActionsSlotContext);
  if (!slot) return null;
  return createPortal(children, slot);
}

function useFrameWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1200 : Math.max(0, window.innerWidth - 240),
  );
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function FrameItems({
  groups,
  activeId,
  list = false,
}: {
  groups: SettingsFrameGroup[];
  activeId: string | null;
  /** The settings list page: icons, 44px rows and a chevron. */
  list?: boolean;
}) {
  return (
    <>
      {groups.map((group, index) => (
        <NavGroup key={group.label ?? `group-${index}`} label={group.label}>
          {group.items.map((item) => {
            const Icon = item.icon;
            return (
              <NavItem
                key={item.id}
                asChild
                label={item.label}
                icon={list ? <Icon /> : undefined}
                active={!list && activeId === item.id}
                attention={item.attention}
                trailingIcon={list ? <ChevronRightIcon /> : undefined}
                className={list ? "h-11" : undefined}
              >
                {item.link}
              </NavItem>
            );
          })}
        </NavGroup>
      ))}
    </>
  );
}

function BackToSettings({ link, label }: { link: ReactElement; label: string }) {
  return (
    <NavLinkShell link={link}>
      <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
      {label}
    </NavLinkShell>
  );
}

/** Renders a router link element with our own children and classes. */
function NavLinkShell({ link, children }: { link: ReactElement; children: ReactNode }) {
  const props = link.props as { className?: string };
  const Element = link.type as React.ElementType;
  return (
    <Element
      {...(link.props as object)}
      className={cn(
        "-ml-0.5 inline-flex items-center gap-0.5 rounded-md text-xs leading-4.5 font-medium text-fg-subtle transition-colors duration-[120ms] outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-brand/55 pointer-coarse:min-h-11",
        props.className,
      )}
    >
      {children}
    </Element>
  );
}

export function SettingsFrame({
  label,
  heading,
  subheading,
  groups,
  activeId,
  indexRequested = false,
  indexLink,
  footer,
  header,
  page,
  banner,
  ownBackLink = false,
  children,
}: SettingsFrameProps) {
  const [frameRef, width] = useFrameWidth();
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const showColumn = width >= COLUMN_MIN_WIDTH;
  const showIndex = !showColumn && indexRequested;

  let body: ReactNode;
  if (showIndex) {
    body = (
      <>
        <PageHeader title={heading} context={subheading} />
        <nav aria-label={label} className="-mx-2.5 mt-4 flex flex-col gap-5">
          <FrameItems groups={groups} activeId={null} list />
          {footer}
        </nav>
      </>
    );
  } else {
    body = (
      <>
        {page ? (
          <PageHeader
            title={page.title}
            description={page.description}
            context={showColumn ? undefined : <BackToSettings link={indexLink} label={heading} />}
            actions={
              <>
                {page.actions}
                <span ref={setActionsSlot} className="contents" />
              </>
            }
          />
        ) : showColumn || ownBackLink ? null : (
          <div className="mb-4">
            <BackToSettings link={indexLink} label={heading} />
          </div>
        )}
        {banner ? <div className={page ? "mt-6" : "mb-6"}>{banner}</div> : null}
        <div className={page ? "mt-6" : undefined}>{children}</div>
      </>
    );
  }

  return (
    <div ref={frameRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ContentPage width="standard" className="max-w-[1040px] pb-16 lg:pt-8">
        <div className="flex min-w-0 gap-10">
          {showColumn ? (
            <SettingsNav
              aria-label={label}
              className="sticky top-8 self-start"
              header={
                <div className="flex min-w-0 flex-col gap-3">
                  {header}
                  <div className="px-2.5">
                    <p className="text-sm leading-5 font-semibold text-fg">{heading}</p>
                    {subheading ? (
                      <p className="truncate text-xs leading-4.5 text-fg-subtle">{subheading}</p>
                    ) : null}
                  </div>
                </div>
              }
              footer={footer}
            >
              <FrameItems groups={groups} activeId={activeId} />
            </SettingsNav>
          ) : null}
          <main
            aria-label={showIndex ? heading : (page?.title ?? heading)}
            className={cn(
              "min-w-0 flex-1",
              showColumn && "max-w-[720px]",
              // Pages that bring their own ContentPage (Variable sets, Machines)
              // join this column instead of nesting a second scroller and gutter.
              "[&_[data-slot=content-page]]:overflow-visible [&_[data-slot=content-page-inner]]:max-w-none [&_[data-slot=content-page-inner]]:p-0",
            )}
          >
            <SettingsActionsSlotContext.Provider value={actionsSlot}>
              <PageHeaderStyleProvider icon="hide">{body}</PageHeaderStyleProvider>
            </SettingsActionsSlotContext.Provider>
          </main>
        </div>
      </ContentPage>
    </div>
  );
}

/** "Organization: Acme Robotics →" under the sub-nav items. */
export function SettingsFrameOutLink({
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
        <div className="flex h-8 min-w-0 items-center gap-2.5 px-2.5 text-sm font-medium text-fg-muted">
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">{label}</span>
        </div>
      )}
    </NavGroup>
  );
}
