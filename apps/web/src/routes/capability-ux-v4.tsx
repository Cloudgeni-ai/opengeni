import {
  ArrowLeftIcon,
  BlocksIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Code2Icon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  Globe2Icon,
  Grid2X2Icon,
  KeyRoundIcon,
  MailIcon,
  MessageSquareIcon,
  MicIcon,
  PlugIcon,
  SearchIcon,
  SendIcon,
  Settings2Icon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useState, type ComponentType, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type PreviewView = "defaults" | "advanced" | "composer" | "apps";
type Policy = "ask" | "allow" | "block";

const PREVIEW_VIEWS: ReadonlyArray<{ id: PreviewView; label: string }> = [
  { id: "defaults", label: "Default permissions" },
  { id: "advanced", label: "Advanced" },
  { id: "composer", label: "New session" },
  { id: "apps", label: "Connect apps" },
];

const DEFAULT_GROUPS = [
  {
    id: "standard",
    name: "Standard",
    description: "Files, code, terminal, and browser for everyday work.",
    icon: SparklesIcon,
    enabled: true,
  },
  {
    id: "research",
    name: "Research",
    description: "Web, workspace knowledge, documents, and connected read tools.",
    icon: SearchIcon,
    enabled: true,
  },
  {
    id: "development",
    name: "Development",
    description: "Repositories, code editing, terminal, and pull requests.",
    icon: Code2Icon,
    enabled: true,
  },
  {
    id: "communication",
    name: "Communication",
    description: "Mail and messaging, with approval before agents send.",
    icon: MessageSquareIcon,
    enabled: false,
  },
] as const;

const BUILT_IN_CAPABILITIES = [
  {
    id: "files",
    name: "Files",
    description: "Read and edit files selected for the session.",
    icon: FileTextIcon,
  },
  {
    id: "knowledge",
    name: "Workspace knowledge",
    description: "Search approved documents and workspace knowledge.",
    icon: SearchIcon,
  },
  {
    id: "code",
    name: "Code and terminal",
    description: "Inspect repositories, edit code, and run commands.",
    icon: Code2Icon,
  },
  {
    id: "browser",
    name: "Web and browser",
    description: "Research the web and use browser sessions.",
    icon: Globe2Icon,
  },
] as const;

const CONNECTED_APP_POLICIES = [
  {
    id: "gmail",
    name: "Gmail",
    icon: MailIcon,
    actions: [
      { id: "gmail-read", name: "Read mail", detail: "Search and read messages." },
      { id: "gmail-draft", name: "Create drafts", detail: "Prepare draft messages." },
      { id: "gmail-send", name: "Send mail", detail: "Send a message or existing draft." },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    icon: MessageSquareIcon,
    actions: [
      { id: "slack-read", name: "Read messages", detail: "Search approved conversations." },
      { id: "slack-send", name: "Send messages", detail: "Post in approved channels." },
    ],
  },
  {
    id: "github",
    name: "GitHub",
    icon: GitBranchIcon,
    actions: [
      { id: "github-read", name: "Read repositories", detail: "Inspect approved repositories." },
      { id: "github-pr", name: "Create pull requests", detail: "Open a pull request." },
      { id: "github-push", name: "Push changes", detail: "Push commits to a branch." },
    ],
  },
] as const;

const APPS = [
  {
    id: "slack",
    name: "Slack",
    description: "Search conversations and work with your team.",
    icon: MessageSquareIcon,
    connected: true,
  },
  {
    id: "github",
    name: "GitHub",
    description: "Read code and open pull requests in approved repositories.",
    icon: GitBranchIcon,
    connected: false,
  },
  {
    id: "drive",
    name: "Google Drive",
    description: "Read selected folders and publish approved files.",
    icon: FolderIcon,
    connected: false,
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Search, draft, and send mail with your approval.",
    icon: MailIcon,
    connected: true,
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search and update pages in selected workspaces.",
    icon: FileTextIcon,
    connected: false,
  },
  {
    id: "linear",
    name: "Linear",
    description: "Find issues, update projects, and coordinate delivery.",
    icon: BlocksIcon,
    connected: false,
  },
  {
    id: "figma",
    name: "Figma",
    description: "Read frames, components, and comments from design files.",
    icon: Grid2X2Icon,
    connected: false,
  },
  {
    id: "custom",
    name: "Custom API",
    description: "Connect an approved OpenAPI or GraphQL endpoint.",
    icon: PlugIcon,
    connected: false,
  },
] as const;

type AppItem = (typeof APPS)[number];

export function CapabilityUxV4Route() {
  const [view, setView] = useState<PreviewView>("defaults");

  return (
    <main className="min-h-dvh bg-bg text-fg" data-capability-ux-v4="">
      <PreviewBar view={view} onChange={setView} />
      {view === "composer" ? (
        <ComposerPreview onOpenSettings={() => setView("defaults")} />
      ) : (
        <SettingsPreview view={view} onChange={setView} />
      )}
    </main>
  );
}

function PreviewBar({
  view,
  onChange,
}: {
  view: PreviewView;
  onChange: (view: PreviewView) => void;
}) {
  return (
    <div className="sticky top-0 z-40 border-b border-border bg-bg/95 backdrop-blur">
      <div className="mx-auto flex h-11 max-w-[90rem] items-center gap-4 overflow-x-auto px-4 sm:px-6">
        <span className="shrink-0 text-2xs font-semibold uppercase tracking-[0.12em] text-fg-subtle">
          Capability UX preview
        </span>
        <nav aria-label="Preview views" className="flex h-full items-center gap-1">
          {PREVIEW_VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => onChange(item.id)}
              className={cn(
                "h-8 shrink-0 rounded-md px-3 text-xs font-medium transition-colors",
                view === item.id
                  ? "bg-surface-2 text-fg"
                  : "text-fg-muted hover:bg-surface hover:text-fg",
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

function SettingsPreview({
  view,
  onChange,
}: {
  view: Exclude<PreviewView, "composer">;
  onChange: (view: PreviewView) => void;
}) {
  return (
    <div className="mx-auto grid min-h-[calc(100dvh-2.75rem)] max-w-[90rem] lg:grid-cols-[14rem_minmax(0,1fr)]">
      <SettingsNavigation view={view} onChange={onChange} />
      <div className="min-w-0 px-4 py-7 sm:px-8 lg:px-12 lg:py-10">
        <div className="mx-auto max-w-5xl">
          {view === "defaults" ? <DefaultsView onAdvanced={() => onChange("advanced")} /> : null}
          {view === "advanced" ? <AdvancedView onDefaults={() => onChange("defaults")} /> : null}
          {view === "apps" ? <ConnectAppsView /> : null}
        </div>
      </div>
    </div>
  );
}

function SettingsNavigation({
  view,
  onChange,
}: {
  view: Exclude<PreviewView, "composer">;
  onChange: (view: PreviewView) => void;
}) {
  const links = [
    { id: "defaults" as const, label: "Capabilities", icon: Grid2X2Icon },
    { id: "apps" as const, label: "Connections", icon: Globe2Icon },
  ];
  return (
    <aside className="border-b border-border bg-surface/25 px-4 py-4 lg:border-r lg:border-b-0 lg:px-3 lg:py-6">
      <button
        type="button"
        className="mb-4 inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg lg:mb-7"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to sessions
      </button>
      <p className="px-2 text-sm font-semibold">Settings</p>
      <nav aria-label="Settings" className="mt-3 flex gap-1 overflow-x-auto lg:flex-col">
        <SettingsNavButton icon={Settings2Icon} label="General" />
        <SettingsNavButton icon={UsersIcon} label="Members" />
        {links.map((link) => (
          <SettingsNavButton
            key={link.id}
            icon={link.icon}
            label={link.label}
            selected={view === link.id || (link.id === "defaults" && view === "advanced")}
            onClick={() => onChange(link.id)}
          />
        ))}
        <SettingsNavButton icon={BotIcon} label="Models" />
        <SettingsNavButton icon={KeyRoundIcon} label="API keys" />
      </nav>
    </aside>
  );
}

function SettingsNavButton({
  icon: Icon,
  label,
  selected = false,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-left text-sm lg:w-full",
        selected ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface hover:text-fg",
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}

function DefaultsView({ onAdvanced }: { onAdvanced: () => void }) {
  const [groups, setGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(DEFAULT_GROUPS.map((group) => [group.id, group.enabled])),
  );
  return (
    <section>
      <PageHeading
        eyebrow="Capabilities"
        title="Default permissions for new sessions"
        description="Choose the capabilities that are available when people start a session."
        action={
          <Button type="button" variant="secondary" size="sm" onClick={onAdvanced}>
            <Settings2Icon />
            Advanced
          </Button>
        }
      />
      <div className="grid gap-3 border-t border-border pt-6 md:grid-cols-2">
        {DEFAULT_GROUPS.map((group) => {
          const Icon = group.icon;
          return (
            <div
              key={group.id}
              className="flex min-h-28 items-start gap-3 rounded-2xl border border-border bg-surface/45 p-4"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-surface text-fg-muted">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{group.name}</p>
                <p className="mt-1 text-xs leading-5 text-fg-muted">{group.description}</p>
              </div>
              <Toggle
                label={`${group.name} default`}
                checked={groups[group.id] ?? false}
                onChange={(checked) =>
                  setGroups((current) => ({ ...current, [group.id]: checked }))
                }
              />
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-fg-subtle">
        Workspace policy and connected-account permissions still apply.
      </p>
    </section>
  );
}

function AdvancedView({ onDefaults }: { onDefaults: () => void }) {
  const [builtIns, setBuiltIns] = useState<Record<string, boolean>>({
    files: true,
    knowledge: true,
    code: true,
    browser: true,
  });
  const [policies, setPolicies] = useState<Record<string, Policy>>({
    "gmail-read": "allow",
    "gmail-draft": "allow",
    "gmail-send": "ask",
    "slack-read": "allow",
    "slack-send": "ask",
    "github-read": "allow",
    "github-pr": "ask",
    "github-push": "ask",
  });
  const setAllPolicies = (policy: Policy) =>
    setPolicies(
      Object.fromEntries(
        CONNECTED_APP_POLICIES.flatMap((app) => app.actions.map((action) => [action.id, policy])),
      ),
    );

  return (
    <section>
      <PageHeading
        eyebrow="Capabilities"
        title="Advanced permissions"
        description="Control built-in capabilities separately from actions in connected apps."
        action={
          <Button type="button" variant="ghost" size="sm" onClick={onDefaults}>
            <ArrowLeftIcon />
            Defaults
          </Button>
        }
      />

      <div className="space-y-8 border-t border-border pt-6">
        <section aria-labelledby="built-in-heading">
          <div className="mb-3">
            <h2 id="built-in-heading" className="text-sm font-semibold">
              OpenGeni capabilities
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              Choose what is available in a new session. These are not connected-app permissions.
            </p>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-surface/35">
            {BUILT_IN_CAPABILITIES.map((capability) => {
              const Icon = capability.icon;
              return (
                <div
                  key={capability.id}
                  className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface text-fg-muted">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{capability.name}</p>
                    <p className="mt-0.5 text-xs text-fg-muted">{capability.description}</p>
                  </div>
                  <Toggle
                    label={capability.name}
                    checked={builtIns[capability.id] ?? false}
                    onChange={(checked) =>
                      setBuiltIns((current) => ({ ...current, [capability.id]: checked }))
                    }
                  />
                </div>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="app-policy-heading">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="app-policy-heading" className="text-sm font-semibold">
                Connected app actions
              </h2>
              <p className="mt-1 text-xs text-fg-muted">
                Decide whether agents may act directly, ask first, or never use an app action.
              </p>
            </div>
            <div
              className="inline-flex w-fit rounded-lg border border-border bg-surface p-0.5"
              aria-label="Set every connected app action"
            >
              {(["ask", "allow", "block"] as const).map((policy) => (
                <button
                  key={policy}
                  type="button"
                  onClick={() => setAllPolicies(policy)}
                  className="rounded-md px-2.5 py-1.5 text-xs capitalize text-fg-muted hover:bg-surface-2 hover:text-fg"
                >
                  {policy} all
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            {CONNECTED_APP_POLICIES.map((app) => (
              <AppPolicyCard
                key={app.id}
                app={app}
                policies={policies}
                onPolicy={(id, policy) => setPolicies((current) => ({ ...current, [id]: policy }))}
              />
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

function AppPolicyCard({
  app,
  policies,
  onPolicy,
}: {
  app: (typeof CONNECTED_APP_POLICIES)[number];
  policies: Record<string, Policy>;
  onPolicy: (id: string, policy: Policy) => void;
}) {
  const Icon = app.icon;
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface/35">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="grid size-7 place-items-center rounded-lg border border-border bg-surface">
          <Icon className="size-3.5" />
        </span>
        <h3 className="text-sm font-semibold">{app.name}</h3>
      </div>
      {app.actions.map((action) => (
        <div
          key={action.id}
          className="flex flex-col gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:flex-row sm:items-center"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{action.name}</p>
            <p className="mt-0.5 text-xs text-fg-muted">{action.detail}</p>
          </div>
          <PolicyControl
            label={`${app.name}: ${action.name}`}
            value={policies[action.id] ?? "ask"}
            onChange={(policy) => onPolicy(action.id, policy)}
          />
        </div>
      ))}
    </div>
  );
}

function ComposerPreview({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [selectedCapabilities, setSelectedCapabilities] = useState<Record<string, boolean>>({
    files: true,
    knowledge: true,
    code: true,
    browser: false,
  });
  const enabledCount = Object.values(selectedCapabilities).filter(Boolean).length + 2;
  return (
    <div className="flex min-h-[calc(100dvh-2.75rem)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-3xl">
        <div className="mb-7 text-center">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            What should the agent do?
          </h1>
          <p className="mt-2 text-sm text-fg-muted">Start a session with the tools you need.</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/55 p-3 shadow-sm">
          <textarea
            aria-label="Task"
            placeholder="Describe a task for the agent..."
            className="min-h-28 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-fg-subtle"
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
            <ToolsMenu
              selection={selectedCapabilities}
              onChange={setSelectedCapabilities}
              enabledCount={enabledCount}
              onOpenSettings={onOpenSettings}
            />
            <Pill icon={FolderIcon} label="Default" />
            <Pill icon={GitBranchIcon} label="1 repository" />
            <div className="min-w-3 flex-1" />
            <Pill icon={SparklesIcon} label="GPT-5.6 Sol · High" />
            <Button variant="ghost" size="icon-sm" aria-label="Voice input">
              <MicIcon />
            </Button>
            <Button size="icon-sm" aria-label="Send">
              <SendIcon />
            </Button>
          </div>
        </div>
        <p className="mt-3 text-center text-xs text-fg-subtle">
          One Tools control stays in the composer. Detailed defaults and policies live in Settings.
        </p>
      </div>
    </div>
  );
}

function ToolsMenu({
  selection,
  onChange,
  enabledCount,
  onOpenSettings,
}: {
  selection: Record<string, boolean>;
  onChange: (selection: Record<string, boolean>) => void;
  enabledCount: number;
  onOpenSettings: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" className="max-w-36 rounded-full">
          <PlugIcon />
          <span className="truncate">Tools · {enabledCount}</span>
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={8}
        className="w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border-border bg-surface p-2 shadow-xl"
      >
        <div className="px-2 pt-1 pb-2">
          <p className="text-sm font-semibold">Tools for this session</p>
          <p className="mt-0.5 text-xs text-fg-muted">
            Choose capabilities, not individual commands.
          </p>
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          {BUILT_IN_CAPABILITIES.map((capability) => {
            const Icon = capability.icon;
            return (
              <button
                key={capability.id}
                type="button"
                onClick={() =>
                  onChange({ ...selection, [capability.id]: !(selection[capability.id] ?? false) })
                }
                className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-2"
              >
                <Icon className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{capability.name}</span>
                  <span className="block truncate text-xs text-fg-muted">
                    {capability.description}
                  </span>
                </span>
                <SelectionMark selected={selection[capability.id] ?? false} />
              </button>
            );
          })}
        </div>
        <div className="mt-3 px-2">
          <p className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
            Connected apps
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <AppChip icon={MailIcon} label="Gmail" />
            <AppChip icon={MessageSquareIcon} label="Slack" />
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          className="mt-3 flex w-full items-center justify-between rounded-lg px-2 py-2 text-xs font-medium text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          Manage defaults and app permissions
          <ChevronRightIcon className="size-3.5" />
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConnectAppsView() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"browse" | "connected">("browse");
  const [selected, setSelected] = useState<AppItem | null>(null);
  const visibleApps = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return APPS.filter((app) => (filter === "connected" ? app.connected : true)).filter(
      (app) =>
        normalized.length === 0 ||
        app.name.toLowerCase().includes(normalized) ||
        app.description.toLowerCase().includes(normalized),
    );
  }, [filter, query]);

  return (
    <section>
      <PageHeading
        eyebrow="Capabilities"
        title="Connect apps"
        description="Bring approved services and custom APIs into this workspace."
        action={
          <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
            {(["browse", "connected"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs capitalize",
                  filter === value ? "bg-surface-2 text-fg" : "text-fg-muted hover:text-fg",
                )}
              >
                {value}
              </button>
            ))}
          </div>
        }
      />
      <div className="border-t border-border pt-5">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search apps"
            aria-label="Search apps"
            className="h-10 rounded-xl pl-9"
          />
        </div>
        <h2 className="mt-6 text-sm font-semibold">
          {filter === "connected" ? "Connected" : "Featured"}
        </h2>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {visibleApps.map((app) => (
            <AppCatalogRow key={app.id} app={app} onOpen={() => setSelected(app)} />
          ))}
        </div>
        {visibleApps.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">
            No apps match this search.
          </div>
        ) : null}
        <div className="mt-8 flex flex-col gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold">Custom APIs</h2>
            <p className="mt-1 text-xs text-fg-muted">
              Add a workspace-managed OpenAPI or GraphQL connector.
            </p>
          </div>
          <Button variant="secondary" size="sm">
            Add custom API
          </Button>
        </div>
      </div>
      <AppDetailDialog app={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </section>
  );
}

function AppCatalogRow({ app, onOpen }: { app: AppItem; onOpen: () => void }) {
  const Icon = app.icon;
  return (
    <div className="group flex min-w-0 items-center gap-2 rounded-xl border border-border bg-surface/40 p-2 transition-colors hover:border-border-strong">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-bg">
          <Icon className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{app.name}</span>
          <span className="mt-0.5 block truncate text-xs text-fg-muted">{app.description}</span>
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-fg-subtle" />
      </button>
      <button
        type="button"
        aria-label={app.connected ? `${app.name} connected` : `Connect ${app.name}`}
        onClick={onOpen}
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
          app.connected
            ? "border-status-idle/30 bg-status-idle/10 text-status-idle"
            : "border-border text-fg-muted hover:border-border-strong hover:text-fg",
        )}
      >
        {app.connected ? <CheckIcon className="size-4" /> : <PlugIcon className="size-4" />}
      </button>
    </div>
  );
}

function AppDetailDialog({
  app,
  onOpenChange,
}: {
  app: AppItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [available, setAvailable] = useState(true);
  if (!app) return null;
  const Icon = app.icon;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border px-5 py-4 pr-12 text-left">
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-surface">
              <Icon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base">{app.name}</DialogTitle>
              <DialogDescription className="mt-1 line-clamp-2 text-xs">
                {app.description}
              </DialogDescription>
            </div>
            <span
              className={cn(
                "mr-1 rounded-full border px-2 py-1 text-2xs font-medium",
                app.connected
                  ? "border-status-idle/30 text-status-idle"
                  : "border-border text-fg-muted",
              )}
            >
              {app.connected ? "Connected" : "Not connected"}
            </span>
          </div>
        </DialogHeader>
        <div className="space-y-5 px-5 py-5">
          <section>
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Connection
            </h3>
            <dl className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface/40 text-xs">
              <div className="flex justify-between gap-4 px-3 py-2.5">
                <dt className="text-fg-muted">Account</dt>
                <dd className="font-medium">
                  {app.connected ? "bendik@opengeni.ai" : "No account connected"}
                </dd>
              </div>
              <div className="flex justify-between gap-4 px-3 py-2.5">
                <dt className="text-fg-muted">Available to</dt>
                <dd className="font-medium">This workspace</dd>
              </div>
            </dl>
          </section>
          <section>
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Access
            </h3>
            <div className="mt-2 flex items-center gap-2 rounded-xl border border-border bg-surface/40 px-3 py-2.5 text-sm">
              <FolderIcon className="size-4 text-fg-muted" />
              <span className="flex-1">Approved workspace content</span>
              <button type="button" className="text-xs font-medium text-brand hover:underline">
                Edit
              </button>
            </div>
          </section>
          <section>
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Session default
            </h3>
            <div className="mt-2 flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Available in new sessions</p>
                <p className="mt-0.5 text-xs text-fg-muted">
                  People can turn it off for an individual session.
                </p>
              </div>
              <Toggle
                label={`${app.name} available in new sessions`}
                checked={available}
                onChange={setAvailable}
              />
            </div>
          </section>
          <section>
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              What agents can do
            </h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {["Search", "Read", "Create drafts", "Send with approval"].map((label) => (
                <span
                  key={label}
                  className="rounded-full border border-border bg-surface px-2 py-1 text-2xs text-fg-muted"
                >
                  {label}
                </span>
              ))}
            </div>
          </section>
        </div>
        <DialogFooter className="border-t border-border bg-surface/45 px-5 py-3">
          {app.connected ? (
            <>
              <Button variant="ghost">Disconnect</Button>
              <Button variant="secondary">Reconnect</Button>
            </>
          ) : (
            <Button>Connect {app.name}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-fg-subtle">
          {eyebrow}
        </p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-fg-muted">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

function PolicyControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Policy;
  onChange: (value: Policy) => void;
}) {
  return (
    <div
      className="inline-flex w-fit shrink-0 rounded-lg border border-border bg-surface p-0.5"
      role="group"
      aria-label={label}
    >
      {(["ask", "allow", "block"] as const).map((policy) => (
        <button
          key={policy}
          type="button"
          aria-pressed={value === policy}
          onClick={() => onChange(policy)}
          className={cn(
            "rounded-md px-2.5 py-1.5 text-xs capitalize transition-colors",
            value === policy
              ? "bg-surface-2 font-medium text-fg shadow-sm"
              : "text-fg-muted hover:text-fg",
          )}
        >
          {policy}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        checked ? "border-brand bg-brand" : "border-border bg-surface-2",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-3.5 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-[1.05rem]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function SelectionMark({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded border",
        selected ? "border-brand bg-brand text-white" : "border-border bg-surface",
      )}
      aria-hidden
    >
      {selected ? <CheckIcon className="size-3" /> : null}
    </span>
  );
}

function AppChip({
  icon: Icon,
  label,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 py-1 text-xs text-fg-muted">
      <Icon className="size-3.5" />
      {label}
    </span>
  );
}

function Pill({
  icon: Icon,
  label,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <Button variant="secondary" size="sm" className="max-w-40 rounded-full">
      <Icon />
      <span className="truncate">{label}</span>
      <ChevronDownIcon className="size-3" />
    </Button>
  );
}
