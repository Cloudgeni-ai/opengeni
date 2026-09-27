import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type LazyExoticComponent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Dialog } from "radix-ui";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  Columns2Icon,
  CopyIcon,
  LayoutGridIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  SmartphoneIcon,
  SunIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { BrandMark } from "@/components/brand-mark";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { KitErrorBoundary, KitNote, KitPaneContext, KitSectionHeader, type KitPane } from "./kit";
import {
  formatPicksForExport,
  pickProgress,
  storedPick,
  usePickState,
  type PickState,
} from "./picks";
import {
  FORK_SECTIONS,
  SECTIONS,
  alternativeLetter,
  alternativeMeta,
  getSection,
  sectionsInGroup,
  visibleGroups,
  type SectionKey,
  type SectionMeta,
} from "./sections/registry";
import {
  ThemeScope,
  useKitDocumentTheme,
  useSplitPortalTheming,
  type KitTheme,
  type ResolvedTheme,
} from "./theme";
import {
  MOBILE_WIDTH,
  kitHref,
  useKitNavigate,
  useKitView,
  type KitView,
  type KitViewChange,
  type KitWidth,
} from "./view";

/**
 * DEV-only component studio at /dev/ui-kit. Every component shown here is the
 * real primitive from components/ui; this file is only the studio chrome. See
 * README.md in this folder for the builder API.
 */

const HEIGHT_MESSAGE = "opengeni-ui-kit:frame-height";
const MOBILE_FRAME_MIN_HEIGHT = 760;

type Navigate = (change: KitViewChange) => void;

export function UiKitRoute() {
  const view = useKitView();
  return view.embed ? <EmbeddedSection view={view} /> : <KitShell view={view} />;
}

/* ----------------------------------------------------------------------------
   Shell
   -------------------------------------------------------------------------- */

function KitShell({ view }: { view: KitView }) {
  const navigate = useKitNavigate(view);
  const documentTheme: ResolvedTheme = view.theme === "dark" ? "dark" : "light";
  useKitDocumentTheme(documentTheme);
  useSplitPortalTheming(view.theme === "split");
  const [navOpen, setNavOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    const title = view.section ? getSection(view.section).title : "Overview";
    document.title = `${title} - OpenGeni UI kit`;
  }, [view.section]);

  const goTo = useCallback(
    (section: SectionKey | null) => {
      setNavOpen(false);
      navigate({ section });
    },
    [navigate],
  );

  if (!view.chrome) {
    return (
      <TooltipProvider delayDuration={300}>
        <main className="min-h-0 flex-1 overflow-y-auto bg-bg text-fg">
          <div className="mx-auto w-full max-w-[1136px] px-4 py-6 sm:px-8 sm:py-8">
            {view.section ? (
              <>
                <KitSectionHeader sectionKey={view.section} />
                <div className="mt-8">
                  <SectionPanes sectionKey={view.section} theme={view.theme} width="desktop" />
                </div>
              </>
            ) : (
              <Overview goTo={goTo} />
            )}
          </div>
        </main>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-0 flex-1 bg-bg text-fg">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-border lg:flex">
          <SidebarContent view={view} goTo={goTo} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar view={view} navigate={navigate} onOpenNav={() => setNavOpen(true)} />
          <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto">
            {view.section ? (
              <SectionPage key={view.section} sectionKey={view.section} view={view} goTo={goTo} />
            ) : view.unknownSection ? (
              <UnknownSection value={view.unknownSection} goTo={goTo} />
            ) : (
              <div className="mx-auto w-full max-w-[960px] px-4 py-6 sm:px-8 sm:py-8">
                <Overview goTo={goTo} />
              </div>
            )}
          </main>
        </div>
      </div>
      <Dialog.Root open={navOpen} onOpenChange={setNavOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/70 lg:hidden" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-bg shadow-lg outline-none lg:hidden"
          >
            <Dialog.Title className="sr-only">Components</Dialog.Title>
            <SidebarContent view={view} goTo={goTo} onClose={() => setNavOpen(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </TooltipProvider>
  );
}

function isPlainClick(event: MouseEvent) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function SidebarContent({
  view,
  goTo,
  onClose,
}: {
  view: KitView;
  goTo: (section: SectionKey | null) => void;
  onClose?: () => void;
}) {
  const state = usePickState();
  const progress = pickProgress(state);
  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-brand/15 text-brand">
          <BrandMark className="size-4" />
        </span>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
          OpenGeni <span className="font-medium text-fg-muted">UI kit</span>
        </p>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close components"
            className="-mr-1.5 grid size-8 place-items-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg pointer-coarse:size-11"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <nav aria-label="Components" className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-6">
        <NavLink
          href={kitHref({ theme: view.theme, width: view.width })}
          active={!view.section}
          onNavigate={() => goTo(null)}
        >
          <LayoutGridIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">Overview</span>
        </NavLink>
        {visibleGroups().map((group) => (
          <div key={group} className="mt-5">
            <p className="px-3 pb-1 text-xs font-medium text-fg-subtle">{group}</p>
            <ul className="flex flex-col gap-px">
              {sectionsInGroup(group).map((section) => {
                const pick = storedPick(state, section.key);
                return (
                  <li key={section.key}>
                    <NavLink
                      href={kitHref({ section: section.key, theme: view.theme, width: view.width })}
                      active={view.section === section.key}
                      onNavigate={() => goTo(section.key)}
                    >
                      <span className="min-w-0 flex-1 truncate">{section.title}</span>
                      {pick ? (
                        <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-brand/10 px-1.5 text-2xs font-semibold text-brand">
                          <span className="sr-only">Picked </span>
                          {alternativeLetter(pick)}
                        </span>
                      ) : null}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="shrink-0 border-t border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-medium text-fg-muted">Your picks</span>
          <span className="text-fg-subtle tabular-nums">
            {progress.picked} of {progress.total}
          </span>
        </div>
        <ProgressBar picked={progress.picked} total={progress.total} className="mt-2" />
      </div>
    </>
  );
}

function NavLink({
  href,
  active,
  onNavigate,
  children,
}: {
  href: string;
  active: boolean;
  onNavigate: () => void;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onNavigate();
      }}
      className={cn(
        "relative flex h-8 items-center gap-2.5 rounded-md px-3 text-sm font-medium transition-colors duration-[120ms] pointer-coarse:h-11",
        active ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand"
        />
      ) : null}
      {children}
    </a>
  );
}

function ProgressBar({
  picked,
  total,
  className,
}: {
  picked: number;
  total: number;
  className?: string;
}) {
  const percent = total === 0 ? 0 : Math.round((picked / total) * 100);
  return (
    <div
      role="progressbar"
      aria-label="Components picked"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={picked}
      aria-valuetext={`${picked} of ${total} picked`}
      className={cn("h-1 overflow-hidden rounded-full bg-surface-3", className)}
    >
      <div className="h-full rounded-full bg-brand" style={{ width: `${percent}%` }} />
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Top bar
   -------------------------------------------------------------------------- */

const THEME_OPTIONS: Array<SegmentOption<KitTheme>> = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "split", label: "Side by side", icon: Columns2Icon },
];

const WIDTH_OPTIONS: Array<SegmentOption<KitWidth>> = [
  { value: "desktop", label: "Desktop", icon: MonitorIcon },
  { value: "mobile", label: `Mobile ${MOBILE_WIDTH}`, icon: SmartphoneIcon },
];

function TopBar({
  view,
  navigate,
  onOpenNav,
}: {
  view: KitView;
  navigate: Navigate;
  onOpenNav: () => void;
}) {
  const section = view.section ? getSection(view.section) : null;
  const widthControl = (
    <Segmented
      label="Preview width"
      value={view.width}
      options={WIDTH_OPTIONS}
      disabled={!section}
      onChange={(width) => navigate({ width })}
    />
  );
  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6">
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="Open components"
          className="-ml-1.5 grid size-8 shrink-0 place-items-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg lg:hidden pointer-coarse:size-11"
        >
          <MenuIcon className="size-4" aria-hidden="true" />
        </button>
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
          {section ? (
            <>
              <span className="hidden shrink-0 text-fg-subtle sm:inline">{section.group}</span>
              <ChevronRightIcon
                className="hidden size-3.5 shrink-0 text-fg-subtle sm:block"
                aria-hidden="true"
              />
              <span className="truncate font-medium text-fg">{section.title}</span>
            </>
          ) : (
            <span className="truncate font-medium text-fg">Overview</span>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Segmented
            label="Theme"
            value={view.theme}
            options={THEME_OPTIONS}
            onChange={(theme) => navigate({ theme })}
            className="hidden md:inline-flex"
          />
          <div className="hidden lg:block">
            {section ? (
              widthControl
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-flex rounded-md">
                    {widthControl}
                  </span>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>
                  Open a component to preview it at {MOBILE_WIDTH}px
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <CopyPicksButton />
        </div>
      </header>
      <div className="flex h-12 shrink-0 items-center border-b border-border px-4 md:hidden">
        <Segmented
          label="Theme"
          value={view.theme}
          options={THEME_OPTIONS}
          onChange={(theme) => navigate({ theme })}
          className="w-full"
          stretch
        />
      </div>
    </>
  );
}

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon: LucideIcon;
}

/** Kit chrome only. The product SegmentedControl is its own kit section. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  stretch,
  className,
}: {
  label: string;
  value: T;
  options: Array<SegmentOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  stretch?: boolean;
  className?: string;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1;
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    buttons.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn(
        "inline-flex h-8 items-center gap-0.5 rounded-md bg-surface-2 p-[3px] pointer-coarse:h-11",
        disabled && "opacity-50",
        className,
      )}
    >
      {options.map((option, index) => {
        const checked = index === selectedIndex;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "inline-flex h-full items-center justify-center gap-1.5 rounded-[7px] px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-[120ms]",
              stretch && "flex-1",
              checked
                ? "bg-surface text-fg shadow-sm"
                : "text-fg-muted enabled:hover:text-fg disabled:cursor-not-allowed",
            )}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Copy my picks
   -------------------------------------------------------------------------- */

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the selection-based copy.
    }
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  return copied;
}

function CopyPicksButton() {
  const state = usePickState();
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const descriptionId = useId();

  const copy = async () => {
    const text = formatPicksForExport(state);
    if (await copyText(text)) {
      const { picked, total } = pickProgress(state);
      toast.success("Picks copied", {
        description: `${picked} of ${total} picked. Paste them into the conversation.`,
      });
    } else {
      setFallbackText(text);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium text-fg transition-colors duration-[120ms] hover:border-border-strong hover:bg-surface-2 pointer-coarse:h-11"
      >
        <CopyIcon className="size-4" aria-hidden="true" />
        <span className="max-sm:sr-only">Copy my picks</span>
      </button>
      <Dialog.Root
        open={fallbackText !== null}
        onOpenChange={(open) => {
          if (!open) setFallbackText(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/70" />
          <Dialog.Content
            aria-describedby={descriptionId}
            className="fixed top-1/2 left-1/2 z-50 flex max-h-[85dvh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[16px] border border-border bg-surface p-6 text-fg shadow-lg outline-none"
          >
            <Dialog.Title className="text-lg leading-6.5 font-semibold tracking-[-0.25px]">
              Copy your picks
            </Dialog.Title>
            <Dialog.Description id={descriptionId} className="mt-1 text-sm text-fg-muted">
              This browser blocked copying. Select the text below and copy it.
            </Dialog.Description>
            <textarea
              readOnly
              autoFocus
              aria-label="Your picks as text"
              value={fallbackText ?? ""}
              onFocus={(event) => event.currentTarget.select()}
              className="mt-4 min-h-64 w-full flex-1 resize-none rounded-md border border-border bg-bg p-3 font-mono text-xs leading-4.5 text-fg"
            />
            <div className="mt-4 flex justify-end">
              <Dialog.Close className="inline-flex h-9 items-center rounded-md bg-brand-strong px-4 text-sm font-medium text-brand-fg transition-colors hover:bg-brand-strong/90">
                Done
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/* ----------------------------------------------------------------------------
   Overview
   -------------------------------------------------------------------------- */

function Overview({ goTo }: { goTo: (section: SectionKey | null) => void }) {
  const state = usePickState();
  const progress = pickProgress(state);
  const nextSection = FORK_SECTIONS.find((section) => !storedPick(state, section.key));
  return (
    <>
      <header className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold tracking-[-0.5px] text-fg">OpenGeni UI kit</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Pick the version you like for each component. Your picks are saved in this browser and
          shape the page previews.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
            <ProgressBar
              picked={progress.picked}
              total={progress.total}
              className="max-w-60 flex-1"
            />
            <p className="shrink-0 text-xs font-medium text-fg-muted tabular-nums">
              {progress.picked} of {progress.total} picked
            </p>
          </div>
          {nextSection ? (
            <a
              href={kitHref({ section: nextSection.key })}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                goTo(nextSection.key);
              }}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-brand-strong px-4 text-sm font-medium text-brand-fg transition-colors duration-[120ms] hover:bg-brand-strong/90 pointer-coarse:h-11"
            >
              {progress.picked === 0 ? "Start with" : "Continue with"} {nextSection.title}
              <ArrowRightIcon className="size-4" aria-hidden="true" />
            </a>
          ) : (
            <span className="inline-flex h-9 items-center gap-1.5 text-sm font-medium text-status-idle">
              <CheckIcon className="size-4" aria-hidden="true" />
              Everything is picked
            </span>
          )}
        </div>
      </header>
      {visibleGroups().map((group) => (
        <OverviewGroup key={group} group={group} state={state} goTo={goTo} />
      ))}
    </>
  );
}

function OverviewGroup({
  group,
  state,
  goTo,
}: {
  group: SectionMeta["group"];
  state: PickState;
  goTo: (section: SectionKey) => void;
}) {
  const headingId = useId();
  const sections = sectionsInGroup(group);
  const forks = sections.filter((section) => section.recommended);
  const pickedCount = forks.filter((section) => storedPick(state, section.key)).length;
  return (
    <section aria-labelledby={headingId} className="mt-8">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id={headingId} className="text-sm font-semibold text-fg">
          {group}
        </h2>
        <p className="text-xs text-fg-subtle tabular-nums">
          {forks.length > 0
            ? `${pickedCount} of ${forks.length} picked`
            : group === "Pages"
              ? "Built from your picks"
              : "No decision needed"}
        </p>
      </div>
      <ul className="mt-2 flex flex-col divide-y divide-border">
        {sections.map((section) => (
          <li key={section.key}>
            <a
              href={kitHref({ section: section.key })}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                goTo(section.key);
              }}
              className="group -mx-3 flex min-h-14 items-center gap-3 rounded-md px-3 py-2.5 transition-colors duration-[120ms] hover:bg-surface-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fg">{section.title}</p>
                <p className="line-clamp-2 text-xs leading-4.5 text-fg-muted sm:line-clamp-1">
                  {section.purpose}
                </p>
              </div>
              <OverviewStatus section={section} state={state} />
              <ChevronRightIcon
                className="size-4 shrink-0 text-fg-subtle transition-colors group-hover:text-fg-muted"
                aria-hidden="true"
              />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function OverviewStatus({ section, state }: { section: SectionMeta; state: PickState }) {
  const pick = storedPick(state, section.key);
  if (pick) {
    const name = alternativeMeta(section.key, pick)?.name;
    return (
      <span className="inline-flex max-w-56 shrink-0 items-center gap-1.5 text-xs font-medium text-brand">
        <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">
          {alternativeLetter(pick)}
          <span className="hidden md:inline"> - {name}</span>
        </span>
      </span>
    );
  }
  if (section.recommended) {
    return (
      <span className="hidden shrink-0 text-xs text-fg-subtle sm:inline">
        Decided {alternativeLetter(section.recommended)}
      </span>
    );
  }
  return null;
}

function UnknownSection({
  value,
  goTo,
}: {
  value: string;
  goTo: (section: SectionKey | null) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col items-center px-4 pt-16 text-center">
      <span className="grid size-10 place-items-center rounded-md border border-border bg-surface-2 text-fg-muted">
        <LayoutGridIcon className="size-5" aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-sm font-semibold text-fg">No component called "{value}"</h1>
      <p className="mt-1 text-sm text-fg-muted">
        It may have been renamed. Pick one from the list.
      </p>
      <button
        type="button"
        onClick={() => goTo(null)}
        className="mt-4 inline-flex h-9 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium text-fg transition-colors hover:border-border-strong hover:bg-surface-2"
      >
        Go to the overview
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Section page
   -------------------------------------------------------------------------- */

function SectionPage({
  sectionKey,
  view,
  goTo,
}: {
  sectionKey: SectionKey;
  view: KitView;
  goTo: (section: SectionKey | null) => void;
}) {
  const section = getSection(sectionKey);
  const index = SECTIONS.findIndex((each) => each.key === sectionKey);
  const previous = index > 0 ? SECTIONS[index - 1] : undefined;
  const next = SECTIONS[index + 1];
  const wide = section.group === "Pages" || view.theme === "split";

  return (
    <div
      className={cn(
        "mx-auto w-full px-4 py-6 sm:px-8 sm:py-8",
        wide ? "max-w-[1400px]" : "max-w-[1136px]",
      )}
    >
      <KitSectionHeader sectionKey={sectionKey} />
      <div className="mt-8">
        <SectionPanes sectionKey={sectionKey} theme={view.theme} width={view.width} />
      </div>
      {section.recommended && view.theme !== "split" && view.width === "desktop" ? null : (
        <div className="mt-10 border-t border-border pt-8">
          <KitNote
            sectionKey={sectionKey}
            label={section.recommended ? "Notes" : "Notes on this section"}
          />
        </div>
      )}
      <nav
        aria-label="Previous and next component"
        className="mt-12 grid gap-3 border-t border-border pt-6 sm:grid-cols-2"
      >
        {previous ? (
          <PagerLink section={previous} direction="previous" view={view} goTo={goTo} />
        ) : (
          <span className="hidden sm:block" />
        )}
        {next ? <PagerLink section={next} direction="next" view={view} goTo={goTo} /> : null}
      </nav>
    </div>
  );
}

function PagerLink({
  section,
  direction,
  view,
  goTo,
}: {
  section: SectionMeta;
  direction: "previous" | "next";
  view: KitView;
  goTo: (section: SectionKey) => void;
}) {
  const Icon = direction === "previous" ? ArrowLeftIcon : ArrowRightIcon;
  return (
    <a
      href={kitHref({ section: section.key, theme: view.theme, width: view.width })}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        goTo(section.key);
      }}
      className={cn(
        "group flex min-w-0 flex-col gap-0.5 rounded-lg border border-border px-4 py-3 transition-colors duration-[120ms] hover:border-border-strong hover:bg-surface-2",
        direction === "next" && "items-end text-right",
      )}
    >
      <span className="text-xs text-fg-subtle">
        {direction === "previous" ? "Previous" : "Next"} · {section.group}
      </span>
      <span className="flex max-w-full items-center gap-1.5 text-sm font-medium text-fg">
        {direction === "previous" ? <Icon className="size-4 shrink-0" aria-hidden="true" /> : null}
        <span className="truncate">{section.title}</span>
        {direction === "next" ? <Icon className="size-4 shrink-0" aria-hidden="true" /> : null}
      </span>
    </a>
  );
}

/* ----------------------------------------------------------------------------
   Panes: one theme, side by side, or 390px frames.
   -------------------------------------------------------------------------- */

const PANE_THEMES: readonly ResolvedTheme[] = ["light", "dark"];

function SectionPanes({
  sectionKey,
  theme,
  width,
}: {
  sectionKey: SectionKey;
  theme: KitTheme;
  width: KitWidth;
}) {
  if (width === "mobile") {
    const themes = theme === "split" ? PANE_THEMES : [theme];
    return (
      <div className="flex flex-wrap items-start justify-center gap-8">
        {themes.map((each) => (
          <MobileFrame
            key={each}
            sectionKey={sectionKey}
            theme={each}
            showThemeLabel={theme === "split"}
          />
        ))}
      </div>
    );
  }

  if (theme === "split") {
    return (
      <div className="grid gap-4 xl:grid-cols-2">
        {PANE_THEMES.map((each, index) => (
          <ThemeScope
            key={each}
            theme={each}
            className="min-w-0 overflow-hidden rounded-[16px] border border-border"
          >
            <p className="flex items-center gap-1.5 border-b border-border bg-surface px-4 py-2.5 text-xs font-medium text-fg-muted">
              {each === "light" ? (
                <SunIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <MoonIcon className="size-3.5" aria-hidden="true" />
              )}
              {each === "light" ? "Light" : "Dark"}
            </p>
            <div className="p-4 sm:p-6">
              <SectionRenderer
                sectionKey={sectionKey}
                pane={{
                  theme: each,
                  index,
                  count: 2,
                  mobileFrame: false,
                  headerInShell: true,
                  notesInPane: false,
                }}
              />
            </div>
          </ThemeScope>
        ))}
      </div>
    );
  }

  return (
    <SectionRenderer
      sectionKey={sectionKey}
      pane={{
        theme,
        index: 0,
        count: 1,
        mobileFrame: false,
        headerInShell: true,
        notesInPane: true,
      }}
    />
  );
}

const lazySections = new Map<string, LazyExoticComponent<ComponentType>>();

function lazySection(sectionKey: SectionKey, attempt: number) {
  const cacheKey = `${sectionKey}:${attempt}`;
  let component = lazySections.get(cacheKey);
  if (!component) {
    component = lazy(getSection(sectionKey).load);
    lazySections.set(cacheKey, component);
  }
  return component;
}

function SectionRenderer({ sectionKey, pane }: { sectionKey: SectionKey; pane: KitPane }) {
  const [attempt, setAttempt] = useState(0);
  const Section = lazySection(sectionKey, attempt);
  return (
    <KitPaneContext.Provider value={pane}>
      <KitErrorBoundary resetKey={sectionKey} onReset={() => setAttempt((value) => value + 1)}>
        <Suspense fallback={<SectionSkeleton />}>
          <Section />
        </Suspense>
      </KitErrorBoundary>
    </KitPaneContext.Provider>
  );
}

function SectionSkeleton() {
  return (
    <div role="status" aria-label="Loading section" className="flex flex-col gap-3">
      <div className="h-4 w-40 animate-pulse rounded-md bg-surface-2" />
      <div className="h-3 w-72 max-w-full animate-pulse rounded-md bg-surface-2" />
      <div className="mt-2 grid gap-4 sm:grid-cols-3">
        <div className="h-48 animate-pulse rounded-lg bg-surface-2" />
        <div className="h-48 animate-pulse rounded-lg bg-surface-2" />
        <div className="h-48 animate-pulse rounded-lg bg-surface-2" />
      </div>
    </div>
  );
}

function MobileFrame({
  sectionKey,
  theme,
  showThemeLabel,
}: {
  sectionKey: SectionKey;
  theme: ResolvedTheme;
  showThemeLabel: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MOBILE_FRAME_MIN_HEIGHT);
  const title = getSection(sectionKey).title;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (data?.type !== HEIGHT_MESSAGE || typeof data.height !== "number") return;
      setHeight(Math.max(MOBILE_FRAME_MIN_HEIGHT, Math.ceil(data.height)));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <figure className="m-0 flex flex-col items-center gap-2">
      <figcaption className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        <SmartphoneIcon className="size-3.5" aria-hidden="true" />
        {MOBILE_WIDTH}px
        {showThemeLabel ? ` · ${theme === "light" ? "Light" : "Dark"}` : null}
      </figcaption>
      <div className="overflow-hidden rounded-[16px] border border-border shadow-sm">
        {/* oxlint-disable-next-line react/iframe-missing-sandbox -- same-origin DEV preview of this app; it needs scripts and the picks in localStorage */}
        <iframe
          ref={frameRef}
          title={`${title} at ${MOBILE_WIDTH}px, ${theme} theme`}
          src={kitHref({ section: sectionKey, theme, embed: true })}
          style={{ width: MOBILE_WIDTH, height }}
          className="block border-0 bg-bg"
        />
      </div>
    </figure>
  );
}

/* ----------------------------------------------------------------------------
   Embedded section: the document inside a 390px frame.
   -------------------------------------------------------------------------- */

function EmbeddedSection({ view }: { view: KitView }) {
  const theme: ResolvedTheme = view.theme === "dark" ? "dark" : "light";
  useKitDocumentTheme(theme);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = contentRef.current;
    if (!element || window.parent === window) return;
    const post = () => {
      window.parent.postMessage(
        { type: HEIGHT_MESSAGE, height: element.getBoundingClientRect().height },
        window.location.origin,
      );
    };
    const observer = new ResizeObserver(post);
    observer.observe(element);
    post();
    return () => observer.disconnect();
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <main className="min-h-0 flex-1 overflow-y-auto bg-bg text-fg">
        <div ref={contentRef} className="px-4 py-6">
          {view.section ? (
            <SectionRenderer
              sectionKey={view.section}
              pane={{
                theme,
                index: 0,
                count: 1,
                mobileFrame: true,
                headerInShell: true,
                notesInPane: false,
              }}
            />
          ) : null}
        </div>
      </main>
    </TooltipProvider>
  );
}
