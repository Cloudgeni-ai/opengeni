import { ArrowUpRightIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { useKitDocumentTheme, type ResolvedTheme } from "@/dev/ui-kit/theme";

/**
 * Development only: every onboarding screen in order on one page, over the
 * preview fixtures. Previous / Next (or the arrow keys), a step counter, a
 * jump list, the path (a product built by Opengeni or by your own coding
 * agent, exploring, cloud agents, an invited member) and the theme. Nothing here signs anyone up or calls the
 * API; each screen is the real component over fake data.
 */

export type WalkthroughPath =
  | "product-opengeni"
  | "product-own"
  | "product-explore"
  | "work"
  | "skip"
  | "no-trial"
  | "invited";

export type WalkthroughScreen = Readonly<{
  id: string;
  section: string;
  title: string;
  /** The preview view that renders it (`/dev/onboarding?view=`). */
  view: string;
  params: URLSearchParams;
}>;

type ScreenSpec = Readonly<{
  id: string;
  section: string;
  title: string;
  view: string;
  /** The paths it belongs to; every path when omitted. */
  paths?: readonly WalkthroughPath[];
  query?: (path: WalkthroughPath) => Record<string, string>;
}>;

const PATHS: ReadonlyArray<readonly [WalkthroughPath, string]> = [
  ["product-opengeni", "My product: Opengeni builds it"],
  ["product-own", "My product: my own coding agent"],
  ["product-explore", "Product, exploring first"],
  ["work", "My own work"],
  ["skip", "Skip everything"],
  ["no-trial", "No trial grant (model step)"],
  ["invited", "Invited member"],
];

const PRODUCT: readonly WalkthroughPath[] = ["product-opengeni", "product-own", "product-explore"];
const HAS_PRODUCT: readonly WalkthroughPath[] = ["product-opengeni", "product-own"];
const NEW_PEOPLE: readonly WalkthroughPath[] = [
  "product-opengeni",
  "product-own",
  "product-explore",
  "work",
  "skip",
  "no-trial",
];

/** `?path=` of the app fixtures (checklist, Get started, playground, first run). */
function fixturePath(path: WalkthroughPath): string {
  return PRODUCT.includes(path) ? "build" : path === "invited" ? "invited" : "cloud";
}

/** What first run remembers for the path (`?use=`, `?product=`, `?fill=`...). */
function answersQuery(path: WalkthroughPath): Record<string, string> {
  if (path === "skip") return { skipped: "1" };
  if (path === "work" || path === "no-trial") return { use: "work" };
  if (path === "product-explore") return { use: "product", product: "explore" };
  return {
    use: "product",
    product: "have",
    fill: "1",
    ...(path === "product-own" ? { builder: "own" } : {}),
  };
}

const SCREENS: readonly ScreenSpec[] = [
  { id: "sign-up", section: "Account", title: "Sign up", view: "signup" },
  {
    id: "invitation",
    section: "Account",
    title: "Join an organization you were invited to",
    view: "invitation",
    paths: ["invited"],
    query: () => ({ invitation: "pending" }),
  },
  {
    id: "use",
    section: "First question",
    title: "What do you want to use Opengeni for? (creates the organization)",
    view: "organization",
    paths: NEW_PEOPLE,
  },
  {
    id: "product",
    section: "Your product",
    title: "Do you already have a product?",
    view: "first-agent",
    paths: PRODUCT,
    query: (path) => ({
      path: "build",
      step: "product",
      use: "product",
      ...(path === "product-explore" ? { product: "explore" } : { product: "have" }),
    }),
  },
  {
    id: "details",
    section: "Your product",
    title: "Tell us about your product (nothing entered)",
    view: "first-agent",
    paths: HAS_PRODUCT,
    query: () => ({
      path: "build",
      step: "details",
      use: "product",
      product: "have",
      github: "on",
    }),
  },
  {
    id: "details-filled",
    section: "Your product",
    title: "Tell us about your product (website, repository, task)",
    view: "first-agent",
    paths: HAS_PRODUCT,
    query: (path) => ({
      path: "build",
      step: "details",
      github: "connected",
      ...answersQuery(path),
    }),
  },
  {
    id: "details-no-github",
    section: "Your product",
    title: "Tell us about your product (GitHub not set up here)",
    view: "first-agent",
    paths: HAS_PRODUCT,
    query: () => ({
      path: "build",
      step: "details",
      use: "product",
      product: "have",
      github: "off",
      fill: "site",
    }),
  },
  {
    id: "model-step",
    section: "Ready",
    title: "No trial grant and no model: the model step first",
    view: "first-agent",
    paths: ["no-trial"],
    query: () => ({ path: "cloud", step: "ready", use: "work", model: "none" }),
  },
  {
    id: "ready-no-trial",
    section: "Ready",
    title: "Ready without a trial grant (a model works; no amount)",
    view: "first-agent",
    paths: ["no-trial"],
    query: () => ({ path: "cloud", step: "ready", use: "work", billing: "disabled" }),
  },
  {
    id: "ready",
    section: "Ready",
    title: "You got free credits (confetti)",
    view: "first-agent",
    paths: ["product-opengeni", "product-own", "product-explore", "work", "skip"],
    query: (path) => ({
      path: fixturePath(path),
      step: "ready",
      credits: "trial",
      ...answersQuery(path),
    }),
  },
  {
    id: "own-agent",
    section: "Ready",
    title: "Your own coding agent: skills, key and prompt",
    view: "first-agent",
    paths: ["product-own"],
    query: () => ({
      path: "build",
      step: "own-agent",
      mcp: "oauth",
      ...answersQuery("product-own"),
    }),
  },
  {
    id: "own-agent-worked",
    section: "Ready",
    title: "Your own coding agent: it worked",
    view: "first-agent",
    paths: ["product-own"],
    query: () => ({
      path: "build",
      step: "own-agent",
      marks: "api_key,coding_agent",
      appChat: "1",
      ...answersQuery("product-own"),
    }),
  },
  {
    id: "welcome",
    section: "In the app",
    title: "Welcome checklist for an invited member",
    view: "checklist",
    paths: ["invited"],
    query: () => ({ path: "invited", model: "none" }),
  },
  {
    id: "checklist",
    section: "In the app",
    title: "Get started on the new-chat page",
    view: "checklist",
    paths: NEW_PEOPLE,
    query: (path) => ({
      path: fixturePath(path),
      github: "on",
      credits: "trial",
      ...answersQuery(path),
    }),
  },
  {
    id: "get-started",
    section: "In the app",
    title: "Get started page",
    view: "get-started",
    paths: NEW_PEOPLE,
    query: (path) => ({
      path: fixturePath(path),
      github: "on",
      credits: "trial",
      ...answersQuery(path),
    }),
  },
  {
    id: "playground",
    section: "In the app",
    title: "Playground (optional, a recorded demo)",
    view: "playground",
    paths: PRODUCT,
    query: () => ({ path: "build" }),
  },
  {
    id: "member-get-started",
    section: "In the app",
    title: "Get started page for a member",
    view: "get-started",
    paths: ["invited"],
    query: () => ({ path: "invited", role: "member", model: "none" }),
  },
  {
    id: "replay",
    section: "Other states",
    title: "The first question again (replay, Get started)",
    view: "first-agent",
    paths: NEW_PEOPLE,
    query: (path) => ({ path: fixturePath(path), step: "use" }),
  },
  {
    id: "out-of-credits",
    section: "Other states",
    title: "Out of credits (dialog)",
    view: "credits",
  },
];

export function walkthroughScreens(path: WalkthroughPath): WalkthroughScreen[] {
  return SCREENS.filter((spec) => !spec.paths || spec.paths.includes(path)).map((spec) => ({
    id: spec.id,
    section: spec.section,
    title: spec.title,
    view: spec.view,
    params: new URLSearchParams({ view: spec.view, ...(spec.query?.(path) ?? {}) }),
  }));
}

function isWalkthroughPath(value: string | null): value is WalkthroughPath {
  return PATHS.some(([path]) => path === value);
}

/** Arrow keys belong to the control under focus (choice cards, menus, fields). */
function arrowKeysOwnedBy(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="radiogroup"], [role="radio"], [role="tablist"], [role="menu"], [role="listbox"], [role="slider"], [role="dialog"]',
    ),
  );
}

export function OnboardingWalkthrough({
  renderScreen,
}: {
  renderScreen: (screen: WalkthroughScreen) => ReactNode;
}) {
  const initial = useMemo(() => new URLSearchParams(window.location.search), []);
  const [path, setPath] = useState<WalkthroughPath>(() => {
    const value = initial.get("path");
    return isWalkthroughPath(value) ? value : "product-opengeni";
  });
  const [theme, setTheme] = useState<ResolvedTheme>(() =>
    initial.get("theme") === "dark" ? "dark" : "light",
  );
  const screens = useMemo(() => walkthroughScreens(path), [path]);
  const [screenId, setScreenId] = useState<string>(
    () => initial.get("screen") ?? screens[0]?.id ?? "",
  );
  const index = Math.max(
    0,
    screens.findIndex((screen) => screen.id === screenId),
  );
  const screen = screens[index]!;
  useKitDocumentTheme(theme);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.search = new URLSearchParams({
      view: "walkthrough",
      screen: screen.id,
      path,
      theme,
    }).toString();
    window.history.replaceState(window.history.state, "", url);
    document.title = `${index + 1}/${screens.length} ${screen.title} · Onboarding walkthrough`;
  }, [index, path, screen.id, screen.title, screens.length, theme]);

  const go = useCallback(
    (delta: number) => {
      const next = screens[Math.min(screens.length - 1, Math.max(0, index + delta))];
      if (next) setScreenId(next.id);
    },
    [index, screens],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.shiftKey || arrowKeysOwnedBy(event.target)) return;
      event.preventDefault();
      go(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go]);

  const sections = screens.reduce<Array<{ section: string; screens: WalkthroughScreen[] }>>(
    (groups, item) => {
      const last = groups.at(-1);
      if (last?.section === item.section) last.screens.push(item);
      else groups.push({ section: item.section, screens: [item] });
      return groups;
    },
    [],
  );
  const alone = `/dev/onboarding?${screen.params.toString()}`;

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-canvas text-fg">
      <nav
        aria-label="Onboarding walkthrough"
        className="z-10 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-2"
      >
        <div className="flex min-w-0 flex-1 basis-[280px] items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Previous screen"
            title="Previous (←)"
            aria-keyshortcuts="ArrowLeft"
            disabled={index === 0}
            onClick={() => go(-1)}
            className="shrink-0 pointer-coarse:size-11"
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Next screen"
            title="Next (→)"
            aria-keyshortcuts="ArrowRight"
            disabled={index === screens.length - 1}
            onClick={() => go(1)}
            className="shrink-0 pointer-coarse:size-11"
          >
            <ChevronRightIcon />
          </Button>
          <p className="min-w-0 flex-1 truncate text-sm" aria-live="polite">
            <span className="font-medium tabular-nums text-fg">
              {index + 1} of {screens.length}
            </span>
            <span className="text-fg-muted"> · {screen.title}</span>
          </p>
          <SegmentedControl
            size="sm"
            aria-label="Theme"
            value={theme}
            onValueChange={setTheme}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            className="shrink-0"
          />
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="shrink-0 text-fg-muted max-[640px]:px-2"
          >
            <a href={alone} target="_blank" rel="noreferrer" title="Open this screen alone">
              <span className="max-[640px]:sr-only">Open alone</span>
              <ArrowUpRightIcon aria-hidden="true" />
            </a>
          </Button>
        </div>
        <div className="flex min-w-0 basis-full items-center gap-2 min-[1100px]:basis-auto">
          <div className="min-w-0 flex-1 [&>span]:block [&>span]:w-full min-[1100px]:flex-none">
            <Select
              aria-label="Jump to screen"
              value={screen.id}
              onChange={(event) => setScreenId(event.target.value)}
              className="h-8 w-full text-xs min-[1100px]:w-[240px]"
            >
              {sections.map((group) => (
                <optgroup key={group.section} label={group.section}>
                  {group.screens.map((item) => (
                    <option key={item.id} value={item.id}>
                      {screens.indexOf(item) + 1}. {item.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </div>
          <div className="min-w-0 flex-1 [&>span]:block [&>span]:w-full min-[1100px]:flex-none">
            <Select
              aria-label="Path"
              value={path}
              onChange={(event) => {
                const next = event.target.value;
                if (!isWalkthroughPath(next)) return;
                setPath(next);
                // Stay on the same screen when the new path has it.
                const nextScreens = walkthroughScreens(next);
                if (!nextScreens.some((item) => item.id === screen.id))
                  setScreenId(
                    nextScreens.find((item) => item.section === screen.section)?.id ??
                      nextScreens[0]!.id,
                  );
              }}
              className="h-8 w-full text-xs min-[1100px]:w-[210px]"
            >
              {PATHS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </nav>
      <div
        key={`${path}:${screen.id}`}
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
        data-walkthrough-screen={screen.id}
      >
        {renderScreen(screen)}
      </div>
    </div>
  );
}
