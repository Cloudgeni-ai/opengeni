import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowUpRightIcon,
  CheckIcon,
  LayersIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SparklesIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { PageHeader } from "@/components/ui/page-header";
import { SettingsNavigation } from "@/components/ui/settings-navigation";
import { ContentPage, FormField } from "@/components/ui/content-layout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChoiceGroup,
  CheckboxSetting,
  ListToolbar,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  ToggleSetting,
} from "@/components/ui/settings-patterns";
import { cn } from "@/lib/utils";
import { pageDescriptions, resources, settingsPages, type SettingsScope } from "./catalog";

type PreviewDialog = {
  title: string;
  description: string;
  field?: string;
  confirm: string;
  destructive?: boolean;
  onConfirm?: (value: string) => void;
};
const learningOptions = [
  { value: "off", label: "Off", description: "Agents do not retain new knowledge." },
  {
    value: "review",
    label: "Review first",
    description: "Review proposed changes before they are published.",
  },
  {
    value: "automatic",
    label: "Automatic",
    description: "Publish supported findings without a review step.",
  },
] as const;

export function SettingsPreview() {
  const [scope, setScope] = useState<SettingsScope>("workspace");
  const [page, setPage] = useState("General");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [theme, setTheme] = useState("dark");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.ogTheme = theme;
  }, [theme]);
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<PreviewDialog | null>(null);
  const [dialogValue, setDialogValue] = useState("");
  const [values, setValues] = useState<Record<string, string>>({
    workspaceName: "Product team",
    organizationName: "Acme Studio",
    learning: "review",
  });
  const [switches, setSwitches] = useState<Record<string, boolean>>({
    "Voice input": true,
    "Desktop notifications": true,
    GitHub: true,
    Slack: true,
  });
  const [resourceLists, setResourceLists] = useState(resources);
  const [savedName, setSavedName] = useState("Product team");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [tab, setTab] = useState("all");
  const [stateExample, setStateExample] = useState("populated");
  const key = (name: string) => `${scope}:${page}:${name}`;
  const value = (name: string, fallback: string) => values[key(name)] ?? fallback;
  const setValue = (name: string, next: string) =>
    setValues((current) => ({ ...current, [key(name)]: next }));
  const isChecked = (name: string, fallback = false) =>
    switches[key(name)] ?? switches[name] ?? fallback;
  const setChecked = (name: string, next: boolean) => {
    setSwitches((current) => ({ ...current, [key(name)]: next }));
    setNotice(`${name} ${next ? "enabled" : "disabled"} in this preview.`);
  };
  const navigate = (next: string, nextScope = scope) => {
    setScope(nextScope);
    setPage(next);
    setNavigationOpen(false);
    setQuery("");
    setFilter("all");
    setTab("all");
    setStateExample("populated");
    setNotice("");
  };
  const openDialog = (next: PreviewDialog) => {
    setDialogValue("");
    setDialog(next);
  };
  const toggle = (title: string, description: string, fallback = false, disabled = false) => (
    <ToggleSetting
      key={title}
      title={title}
      description={description}
      checked={isChecked(title, fallback)}
      disabled={disabled}
      onCheckedChange={(next) => setChecked(title, next)}
    />
  );
  const selectRow = (title: string, description: string, options: readonly string[]) => (
    <SettingsRow
      title={title}
      description={description}
      control={
        <Select
          aria-label={title}
          value={value(title, options[0]!)}
          onChange={(event) => {
            setValue(title, event.target.value);
            setNotice(`${title} updated in this preview.`);
          }}
        >
          {options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </Select>
      }
    />
  );
  const action = (title: string, description: string, label: string) => (
    <SettingsRow
      title={title}
      description={description}
      control={
        <Button
          variant="outline"
          onClick={() =>
            label === "Manage members"
              ? navigate("Members", "workspace")
              : openDialog({
                  title: label,
                  description:
                    "This is an interaction preview. No account, billing, security, or workspace changes will be made.",
                  confirm: "Done",
                })
          }
        >
          {label}
        </Button>
      }
    />
  );

  const list = (name: string, options?: { toggles?: boolean; add?: string }) => {
    const all = resourceLists[name] ?? [];
    const visible = all.filter(
      (item) =>
        `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()) &&
        (filter === "all" || item.status === filter) &&
        (tab !== "invited" || item.status === "Invited") &&
        (tab !== "members" || item.status !== "Invited"),
    );
    return (
      <div>
        <ListToolbar
          query={query}
          onQueryChange={setQuery}
          placeholder={`Search ${name.toLowerCase()}`}
          filters={
            <Select
              aria-label="Filter by status"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              {[...new Set(all.map((item) => item.status))].map((status) => (
                <option key={status}>{status}</option>
              ))}
            </Select>
          }
          actions={
            options?.add && (
              <Button
                onClick={() =>
                  openDialog({
                    title: options.add!,
                    description:
                      "Add a sample item to this preview only. No API requests will be sent.",
                    field: "Name",
                    confirm: "Add to preview",
                    onConfirm: (nameValue) => {
                      setResourceLists((current) => {
                        let uniqueName = nameValue;
                        let suffix = 2;
                        while ((current[name] ?? []).some((item) => item.name === uniqueName))
                          uniqueName = `${nameValue} (${suffix++})`;
                        return {
                          ...current,
                          [name]: [
                            ...(current[name] ?? []),
                            {
                              name: uniqueName,
                              description: "Added in this preview · Not saved to your workspace",
                              status: "Preview",
                            },
                          ],
                        };
                      });
                    },
                  })
                }
              >
                <PlusIcon />
                {options.add}
              </Button>
            )
          }
        />
        {!visible.length ? (
          <EmptyState
            icon={<SearchIcon className="size-4" />}
            title="No matching results"
            description="Try another search or clear the filters."
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                  setTab("all");
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <SettingsSection title={`${name} · ${visible.length}`}>
            {visible.map((item) => (
              <SettingsRow
                key={item.name}
                icon={
                  name.includes("Members") || name.includes("People") ? (
                    <UsersIcon />
                  ) : (
                    <LayersIcon />
                  )
                }
                title={item.name}
                description={item.description}
                control={
                  <>
                    <Badge variant="secondary">{item.status}</Badge>
                    {options?.toggles ? (
                      <SettingsSwitch
                        aria-label={`Enable ${item.name}`}
                        checked={isChecked(item.name)}
                        disabled={item.status === "Not connected"}
                        onCheckedChange={(next) => setChecked(item.name, next)}
                      />
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Actions for ${item.name}`}
                          >
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() =>
                              openDialog({
                                title: item.name,
                                description: `${item.description}. This is sample data; no live resource is connected.`,
                                confirm: "Done",
                              })
                            }
                          >
                            View details
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              openDialog({
                                title: `Remove ${item.name}?`,
                                description:
                                  "This removes only this sample row. Your actual settings and resources are unchanged.",
                                confirm: "Remove from preview",
                                destructive: true,
                                onConfirm: () =>
                                  setResourceLists((current) => ({
                                    ...current,
                                    [name]: (current[name] ?? []).filter(
                                      (_, row) => row !== all.indexOf(item),
                                    ),
                                  })),
                              })
                            }
                          >
                            Remove from preview
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </>
                }
              />
            ))}
          </SettingsSection>
        )}
      </div>
    );
  };

  const renderContent = (): ReactNode => {
    if (page === "General")
      return (
        <>
          <SettingsSection
            title="Workspace identity"
            description="A clear name helps everyone find the right workspace."
          >
            <div className="grid gap-4 p-5">
              <FormField label="Workspace name">
                <Input
                  value={values.workspaceName}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, workspaceName: event.target.value }))
                  }
                />
              </FormField>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-fg-muted">
                  Visible to everyone in this workspace.
                </span>
                <Button
                  disabled={!values.workspaceName?.trim() || savedName === values.workspaceName}
                  onClick={() => {
                    setSavedName(values.workspaceName!);
                    setNotice("Workspace name saved in this preview only.");
                  }}
                >
                  Save changes
                </Button>
              </div>
            </div>
          </SettingsSection>
          <SettingsSection
            title="Preferences"
            description="Workspace defaults for everyday conversations."
          >
            {toggle("Voice input", "Allow voice input in the chat composer.", true)}
            {toggle(
              "Desktop notifications",
              "Get notified when an agent needs your attention.",
              true,
            )}
            {toggle(
              "Portable context compaction",
              "Use portable context when continuing long conversations.",
            )}
          </SettingsSection>
          <SettingsSection title="Workspace access">
            {action("Members", "3 people have access to this workspace.", "Manage members")}
          </SettingsSection>
        </>
      );
    if (page === "Agent learning" || page === "Knowledge")
      return (
        <>
          <ChoiceGroup
            label="How agents retain knowledge"
            value={value("learning", "review")}
            onChange={(next) => {
              setValue("learning", next);
              setNotice("Learning mode updated in this preview.");
            }}
            options={learningOptions}
          />
          <SettingsSection
            title="Learning sources"
            description="Apply the same row pattern to independent source controls."
          >
            {toggle("Conversations", "Retain useful facts and decisions from conversations.", true)}
            {toggle(
              "Files and documents",
              "Learn from sources deliberately selected as references.",
              true,
            )}
            {toggle("Task outcomes", "Retain supported causes, fixes, and results.", true)}
          </SettingsSection>
          <SettingsSection title="Review and guidance">
            {action(
              "Pending proposals",
              "Review changes before they become accepted knowledge.",
              "Review proposals",
            )}
            {action(
              "Standing instructions",
              "Manage the rules agents follow in this workspace.",
              "View instructions",
            )}
          </SettingsSection>
        </>
      );
    if (page === "Models")
      return (
        <>
          <SettingsSection
            title="Default model"
            description="Model selection must retain the production model-policy picker and its payment-source labels."
          >
            <SettingsRow
              icon={<SparklesIcon />}
              title="Use the existing model-policy picker"
              description="This preview does not substitute a simplified model selector. Live model availability, policy, and billing are not connected."
              control={
                <Button variant="outline" disabled>
                  Requires live model policy
                </Button>
              }
            />
          </SettingsSection>
          <SettingsSection title="AI connections">
            {action(
              "OpenGeni credits",
              "Payment source · Usage billed to your organization's credits.",
              "View credits",
            )}
            {action(
              "Codex subscription",
              "Payment source · Connect your own subscription.",
              "Manage Codex",
            )}
            {action(
              "SuperGrok subscription",
              "Payment source · Connect your own subscription.",
              "Manage SuperGrok",
            )}
            {action(
              "Workspace AI Gateway",
              "Payment source · Workspace-managed provider configuration.",
              "Configure gateway",
            )}
          </SettingsSection>
        </>
      );
    if (page === "Members" || page === "People & invitations")
      return (
        <Tabs value={tab} onValueChange={setTab}>
          <div className="mb-5 max-w-full overflow-x-auto border-b border-border pb-1">
            <TabsList variant="line" aria-label="Membership views">
              <TabsTrigger value="all">All people</TabsTrigger>
              <TabsTrigger value="members">Members</TabsTrigger>
              <TabsTrigger value="invited">Invitations</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value={tab}>{list(page, { add: "Invite person" })}</TabsContent>
        </Tabs>
      );
    if (page === "Capabilities" || page === "Integrations")
      return (
        <>
          {list(page, { toggles: true, add: "Add connection" })}
          <p className="text-xs leading-5 text-fg-muted">
            Connection setup and authorization remain in the existing production flows. These
            switches demonstrate workspace availability only.
          </p>
        </>
      );
    if (page === "Overview")
      return (
        <>
          <SettingsSection title="Organization identity">
            <div className="p-5">
              <FormField label="Organization name">
                <Input
                  value={values.organizationName}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, organizationName: event.target.value }))
                  }
                />
              </FormField>
              <div className="mt-4 flex justify-end">
                <Button
                  onClick={() => setNotice("Organization identity saved in this preview only.")}
                >
                  Save changes
                </Button>
              </div>
            </div>
          </SettingsSection>
          {list("Overview", { add: "Create workspace" })}
        </>
      );
    if (page === "Security" || page === "Recovery")
      return (
        <>
          <SettingsSection title="Sign-in and recovery">
            {action("Passkeys", "Use a passkey to sign in securely.", "Manage passkeys")}
            {action("Password", "Manage your account password.", "Change password")}
            {action(
              "Recovery options",
              "Review available ways to recover access.",
              "Review recovery",
            )}
          </SettingsSection>
          <SettingsSection title="Active sessions">
            <SettingsRow
              icon={<ShieldCheckIcon />}
              title="This browser"
              description="Sample session · Linux · Current session"
              control={<Badge variant="secondary">Current</Badge>}
            />
            {action("Other sessions", "Review and end sessions on other devices.", "View sessions")}
          </SettingsSection>
        </>
      );
    if (page === "Retention")
      return (
        <>
          <SettingsSection
            title="Data retention"
            description="Example policy controls. Available periods must come from organization policy during integration."
          >
            {selectRow("Conversation history", "How long completed conversations are retained.", [
              "Keep until deleted",
              "90 days",
              "30 days",
            ])}
            {selectRow("Audit history", "How long organization activity records are retained.", [
              "Organization default",
              "1 year",
              "90 days",
            ])}
          </SettingsSection>
          <SettingsSection title="Before data is removed">
            {toggle("Notify administrators", "Send a notification before scheduled removal.", true)}
          </SettingsSection>
        </>
      );
    if (page === "Billing" || page === "Insights")
      return (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              ["Credits available", "$240.00"],
              ["Usage this month", "$36.80"],
              ["Conversations", "128"],
            ].map(([label, amount]) => (
              <div key={label} className="rounded-lg border border-border bg-surface/40 p-5">
                <p className="text-xs text-fg-muted">{label}</p>
                <p className="mt-2 text-2xl font-semibold tracking-tight">{amount}</p>
                <p className="mt-2 text-xs text-fg-subtle">Sample data</p>
              </div>
            ))}
          </div>
          <SettingsSection title="Usage and billing">
            {action(
              "Usage breakdown",
              "Review usage by workspace and payment source.",
              "View usage",
            )}
            {action("Billing details", "Manage payment and invoice information.", "Manage billing")}
          </SettingsSection>
        </>
      );
    if (page === "Danger zone")
      return (
        <SettingsSection
          title="Delete workspace"
          description="Destructive actions are isolated from routine preferences."
        >
          <SettingsRow
            title={`Delete ${savedName}`}
            description="Production deletion requires the existing permissions, impact checks, and confirmation flow."
            control={
              <Button
                variant="destructive"
                onClick={() =>
                  openDialog({
                    title: "Preview deletion confirmation",
                    description:
                      "No deletion is possible from this Site. This dialog demonstrates the shared destructive-action presentation only.",
                    confirm: "Close preview",
                    destructive: true,
                  })
                }
              >
                Delete workspace
              </Button>
            }
          />
        </SettingsSection>
      );
    if (page === "Pattern library")
      return (
        <>
          <div className="rounded-lg border border-border bg-surface/40 p-5 text-sm leading-6 text-fg-muted">
            One hierarchy: page header → tabs when needed → search and filters → section → rows. Use
            rows for resources and preferences, choice groups for mutually exclusive policies, and
            cards only for genuinely distinct summaries.
          </div>
          <ChoiceGroup
            label="Mutually exclusive choices"
            value={value("example", "review")}
            onChange={(next) => setValue("example", next)}
            options={learningOptions}
          />
          <SettingsSection title="Setting rows">
            {toggle(
              "Enabled setting",
              "The label, explanation, and control share one row anatomy.",
              true,
            )}
            {toggle(
              "Disabled setting",
              "Explain why a control is unavailable, rather than hiding it.",
              false,
              true,
            )}
            <SettingsRow
              title="Saving setting"
              description="The control is disabled while the update is pending."
              control={
                <SettingsSwitch
                  aria-label="Saving setting"
                  checked
                  saving
                  onCheckedChange={() => {}}
                />
              }
            />
            {selectRow("Single selection", "Use the shared native select for short option lists.", [
              "Workspace default",
              "Enabled",
              "Disabled",
            ])}
          </SettingsSection>
          <SettingsSection
            title="Multiple selection"
            description="Checkboxes select membership in a set; switches turn a setting on or off."
          >
            {[
              ["Read conversations", "Include conversation-reading permission."],
              ["Read files", "Include file-reading permission."],
              ["Manage workspace", "Include administrative permission."],
            ].map(([title, description]) => (
              <CheckboxSetting
                key={title}
                title={title!}
                description={description!}
                checked={isChecked(title!)}
                onCheckedChange={(next) => setChecked(title!, next)}
              />
            ))}
          </SettingsSection>
          <SettingsSection title="Buttons and menus">
            <SettingsRow
              title="Action hierarchy"
              description="One primary action; secondary actions are outlined; row menus use an icon button."
              control={
                <>
                  <Button onClick={() => setNotice("Primary action clicked.")}>Primary</Button>
                  <Button variant="outline" onClick={() => setNotice("Secondary action clicked.")}>
                    Secondary
                  </Button>
                  <Button variant="ghost" onClick={() => setNotice("Tertiary action clicked.")}>
                    Tertiary
                  </Button>
                </>
              }
            />
          </SettingsSection>
          <Tabs value={stateExample} onValueChange={setStateExample}>
            <div className="mb-4 max-w-full overflow-x-auto">
              <TabsList variant="line" aria-label="List states">
                {["populated", "empty", "loading", "error"].map((state) => (
                  <TabsTrigger key={state} value={state}>
                    {state[0]!.toUpperCase() + state.slice(1)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <TabsContent value={stateExample}>
              {stateExample === "populated" ? (
                list("Members")
              ) : stateExample === "empty" ? (
                <EmptyState
                  icon={<UsersIcon className="size-4" />}
                  title="No members yet"
                  description="Invite someone to collaborate in this workspace."
                  action={
                    <Button onClick={() => setNotice("Invitation flow example opened.")}>
                      <PlusIcon />
                      Invite person
                    </Button>
                  }
                />
              ) : stateExample === "loading" ? (
                <div
                  role="status"
                  aria-label="Loading members"
                  className="space-y-3 rounded-lg border border-border p-5"
                >
                  {[0, 1, 2].map((row) => (
                    <div key={row} className="h-10 animate-pulse rounded-md bg-surface-2" />
                  ))}
                  <span className="sr-only">Loading members</span>
                </div>
              ) : (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-status-failed/40 p-5"
                >
                  <div>
                    <p className="text-sm font-medium">Couldn't load members</p>
                    <p className="mt-1 text-xs text-fg-muted">
                      Example error state. Existing rows should remain visible during refresh
                      failures.
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => setStateExample("populated")}>
                    Retry
                  </Button>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </>
      );
    return list(page, {
      add:
        page === "API keys"
          ? "Create API key"
          : page === "Machines"
            ? "Connect machine"
            : page === "Rigs"
              ? "Create rig"
              : "Add item",
    });
  };

  return (
    <div
      className={cn("settings-preview h-dvh bg-bg font-sans text-fg", theme === "dark" && "dark")}
      data-og-theme={theme}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface/60 px-4 py-2.5 text-xs">
          <span className="flex flex-wrap items-center gap-2">
            <span className="size-1.5 rounded-full bg-brand" />
            <strong className="whitespace-nowrap font-medium">Settings review</strong>
            <span className="text-fg-muted">Real components · Sample data · No live writes</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "Light appearance" : "Dark appearance"}
          </Button>
        </div>
        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-1">
          <SettingsNavigation title={page} open={navigationOpen} onOpenChange={setNavigationOpen}>
            <div className="mb-7 flex items-center gap-2 px-2 text-sm font-semibold">
              <span className="flex size-7 items-center justify-center rounded-md bg-brand/15 text-brand">
                <SparklesIcon className="size-4" />
              </span>
              OpenGeni
            </div>
            <p className="mb-3 px-2 text-xs text-fg-muted">Settings / UI review</p>
            <div className="mb-6 grid gap-2">
              <label
                htmlFor="settings-scope"
                className="px-2 text-2xs font-semibold uppercase tracking-wider text-fg-subtle"
              >
                Settings scope
              </label>
              <Select
                id="settings-scope"
                className="w-full"
                value={scope}
                onChange={(event) => {
                  const next = event.target.value as SettingsScope;
                  navigate(settingsPages[next][0], next);
                }}
              >
                <option value="workspace">Workspace</option>
                <option value="organization">Organization</option>
                <option value="personal">Personal</option>
                <option value="patterns">Pattern library</option>
              </Select>
            </div>
            <p className="mb-3 truncate px-2 text-sm font-medium">
              {scope === "workspace"
                ? savedName
                : scope === "organization"
                  ? values.organizationName
                  : scope === "personal"
                    ? "alex@example.com"
                    : "Shared UI patterns"}
            </p>
            <nav aria-label="Settings pages" className="flex flex-col gap-1">
              {settingsPages[scope].map((name) => (
                <button
                  key={name}
                  aria-current={page === name ? "page" : undefined}
                  onClick={() => navigate(name)}
                  className={cn(
                    "flex min-h-10 items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    page === name
                      ? "bg-surface-3 font-medium text-fg"
                      : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  <Settings2Icon aria-hidden="true" className="size-4 shrink-0 opacity-60" />
                  {name}
                </button>
              ))}
            </nav>
            {scope !== "patterns" && (
              <Button
                className="mt-7 w-full justify-start text-xs"
                variant="ghost"
                onClick={() => navigate("Pattern library", "patterns")}
              >
                <LayersIcon />
                Explore shared patterns
                <ArrowUpRightIcon className="ml-auto" />
              </Button>
            )}
          </SettingsNavigation>
          <main className="flex min-h-0 min-w-0 flex-col">
            <ContentPage
              key={`${scope}:${page}`}
              width="standard"
              className="max-w-5xl gap-6 py-7 lg:py-10"
            >
              <PageHeader
                icon={<Settings2Icon className="size-4" />}
                title={page}
                description={pageDescriptions[page]}
              />
              {notice && (
                <div
                  role="status"
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-4 py-3 text-xs"
                >
                  <span className="flex items-center gap-2">
                    <CheckIcon className="size-4 text-brand" />
                    {notice}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Dismiss notification"
                    onClick={() => setNotice("")}
                  >
                    <XIcon />
                  </Button>
                </div>
              )}
              <div className="grid min-w-0 gap-7">{renderContent()}</div>
              <footer className="mt-4 border-t border-border pt-4 text-xs leading-5 text-fg-subtle">
                Implementation preview · Components are imported from the web UI source. Backend
                actions, permissions, and provider setup remain unconnected pending review.
              </footer>
            </ContentPage>
          </main>
        </div>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog?.title}</DialogTitle>
            <DialogDescription>{dialog?.description}</DialogDescription>
          </DialogHeader>
          {dialog?.field && (
            <FormField label={dialog.field}>
              <Input
                autoFocus
                value={dialogValue}
                onChange={(event) => setDialogValue(event.target.value)}
              />
            </FormField>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant={dialog?.destructive ? "destructive" : "default"}
              disabled={!!dialog?.field && !dialogValue.trim()}
              onClick={() => {
                dialog?.onConfirm?.(dialogValue.trim());
                setNotice("Preview interaction completed. No live changes were made.");
                setDialog(null);
              }}
            >
              {dialog?.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
