// Sidebar: the links and groups above your chats (docs/sidebar-layout.md).
// "Yours" is the workspace default with your own changes (add, hide,
// reorder, reset); admins also edit the "Workspace default" everyone starts
// from. Items you can change are renamed in place and take an icon. Under
// Navigation: whether apps are rows in the Sessions list, and which built-in
// rail entries show.
import {
  AppWindowIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  FolderIcon,
  LinkIcon,
  ListIcon,
  PlusIcon,
} from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type {
  NewSidebarItem,
  ResolvedSidebarItem,
  SidebarLayoutChange,
  SidebarLiveListKind,
} from "@opengeni/sdk";
import { agentInitialsAvatar } from "@opengeni/contracts";
import {
  isSidebarAppPath,
  isSidebarExternalUrl,
  readResolvedSidebarOptions,
  SIDEBAR_LABEL_MAX_CHARS,
  SIDEBAR_NAV_ENTRIES,
  type SidebarNavEntry,
} from "@opengeni/contracts/sidebar-layout";
import { useAppContext } from "@opengeni/react/app/app-context";
import { SessionAvatar } from "@opengeni/react/app/components/session/session-avatar";
import { Button } from "@opengeni/react/ui/button";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@opengeni/react/ui/dropdown-menu";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Field, TextInput } from "@opengeni/react/ui/field";
import { MoreMenu, RowButton } from "@opengeni/react/ui/page-actions";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { Section } from "@opengeni/react/ui/section";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { SelectMenu } from "@opengeni/react/ui/select-menu";
import { SettingRow } from "@opengeni/react/ui/setting-row";
import { Switch } from "@opengeni/react/ui/switch";
import { useSidebarLayout } from "@/components/sidebar-layout/use-sidebar-layout";
import { inAppLinkPath } from "@/components/sidebar-layout/in-app-link";
import { IconMenu, SidebarIcon } from "@/components/sidebar-layout/sidebar-icons";
import { pathHasAppPage } from "@/lib/onboarding-return";

type Scope = "personal" | "workspace";
type AddKind = "app" | "agent" | "link" | "group" | "live_list";

const ADD_LABELS: Record<AddKind, string> = {
  app: "App",
  agent: "Agent",
  link: "Link",
  group: "Group",
  live_list: "List",
};

const LIST_OPTIONS: { value: SidebarLiveListKind; label: string }[] = [
  { value: "pinned_apps", label: "Pinned apps" },
  { value: "recent_apps", label: "Recent apps" },
];

const TOP_LEVEL = "__top";

function itemIcon(
  item: ResolvedSidebarItem,
  hasPage: (pathname: string) => boolean,
  workspaceId: string,
) {
  const className = "size-4 shrink-0 text-fg-muted";
  if ((item.type === "app" || item.type === "link" || item.type === "group") && item.icon)
    return <SidebarIcon name={item.icon} fallback={AppWindowIcon} className={className} />;
  if (item.type === "agent")
    return (
      <SessionAvatar
        avatar={item.avatar}
        name={item.label}
        workspaceId={workspaceId}
        seed={item.agentId}
        size="xs"
      />
    );
  if (item.type === "group") return <FolderIcon aria-hidden="true" className={className} />;
  if (item.type === "link")
    return inAppLinkPath(item.url, window.location.origin, hasPage) !== null ? (
      <LinkIcon aria-hidden="true" className={className} />
    ) : (
      <ArrowUpRightIcon aria-hidden="true" className={className} />
    );
  if (item.type === "live_list") return <ListIcon aria-hidden="true" className={className} />;
  return <AppWindowIcon aria-hidden="true" className={className} />;
}

function itemDetail(item: ResolvedSidebarItem): string | null {
  if (item.type === "app") return item.path;
  if (item.type === "link") return item.url.replace(/^https:\/\//u, "");
  if (item.type === "live_list") return `Up to ${item.limit}`;
  return null;
}

/** An item's name, edited in place: Enter or leaving the field saves, Escape cancels. */
export function RenameField({
  label,
  group = true,
  onSave,
  onDone,
}: {
  label: string;
  /** A group's name (the default) or another item's. */
  group?: boolean;
  onSave: (label: string) => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(label);
  const input = useRef<HTMLInputElement>(null);
  // The menu that opened it hands focus back to its button as it closes;
  // take it after that.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  // Enter saves and closes the field; the blur that may follow must not save again.
  const finished = useRef(false);
  const finish = (next: string | null) => {
    if (finished.current) return;
    finished.current = true;
    if (next && next !== label) onSave(next);
    onDone();
  };
  const save = () => finish(value.trim());
  return (
    <TextInput
      ref={input}
      aria-label={group ? "Group name" : "Name"}
      value={value}
      maxLength={SIDEBAR_LABEL_MAX_CHARS}
      onChange={(event) => setValue(event.target.value)}
      onBlur={save}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          save();
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
      }}
      className="h-8"
    />
  );
}

function ItemRow({
  item,
  siblings,
  indent,
  scope,
  workspaceId,
  onChange,
}: {
  item: ResolvedSidebarItem;
  /** The ids of the item's level, in order; moves name a neighbour. */
  siblings: readonly string[];
  indent?: boolean;
  scope: Scope;
  workspaceId: string;
  onChange: (changes: SidebarLayoutChange[]) => void;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const detail = itemDetail(item);
  const index = siblings.indexOf(item.id);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const following = index >= 0 ? siblings[index + 1] : undefined;
  const fromWorkspace = scope === "personal" && item.origin === "workspace";
  // The default's items are edited in the workspace default; yours, here.
  const canEdit = !fromWorkspace;
  return (
    <div
      className={
        indent
          ? "flex min-h-12 items-center gap-3 py-2 pl-7"
          : "flex min-h-12 items-center gap-3 py-2"
      }
    >
      {itemIcon(item, (path) => pathHasAppPage(router, path), workspaceId)}
      {renaming ? (
        <div className="min-w-0 flex-1">
          <RenameField
            label={item.label}
            group={item.type === "group"}
            onSave={(label) => onChange([{ op: "update", itemId: item.id, label }])}
            onDone={() => setRenaming(false)}
          />
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg">{item.label}</div>
          {detail || fromWorkspace ? (
            <div className="truncate text-xs text-fg-muted">
              {[fromWorkspace ? "Workspace" : null, detail].filter(Boolean).join(" · ")}
            </div>
          ) : null}
        </div>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${item.label} up`}
        disabled={previous === undefined}
        onClick={() => onChange([{ op: "move", itemId: item.id, beforeId: previous }])}
        className="text-fg-subtle hover:text-fg pointer-coarse:size-11"
      >
        <ArrowUpIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${item.label} down`}
        disabled={following === undefined}
        onClick={() => onChange([{ op: "move", itemId: item.id, afterId: following }])}
        className="text-fg-subtle hover:text-fg pointer-coarse:size-11"
      >
        <ArrowDownIcon />
      </Button>
      <MoreMenu
        label={`More for ${item.label}`}
        quiet
        onCloseAutoFocus={(event) => {
          // Rename focuses its field instead.
          if (renaming) event.preventDefault();
        }}
      >
        {canEdit ? (
          <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
        ) : null}
        {canEdit && (item.type === "app" || item.type === "link" || item.type === "group") ? (
          <IconMenu
            value={item.icon}
            onSelect={(icon) => onChange([{ op: "update", itemId: item.id, icon }])}
          />
        ) : null}
        {canEdit && item.type === "live_list" ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Show</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-28">
              {[3, 5, 10, 20].map((size) => (
                <DropdownMenuItem
                  key={size}
                  onSelect={() => onChange([{ op: "update", itemId: item.id, limit: size }])}
                >
                  <span className="flex-1">{size} apps</span>
                  <DropdownMenuCheck checked={item.limit === size} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuItem
          variant={fromWorkspace ? "default" : "destructive"}
          onSelect={() => onChange([{ op: "remove", itemId: item.id }])}
        >
          {fromWorkspace ? "Hide" : "Remove"}
        </DropdownMenuItem>
      </MoreMenu>
    </div>
  );
}

function ItemRows({
  items,
  scope,
  workspaceId,
  onChange,
}: {
  items: ResolvedSidebarItem[];
  scope: Scope;
  workspaceId: string;
  onChange: (changes: SidebarLayoutChange[]) => void;
}) {
  const rows: ReactNode[] = [];
  const topIds = items.map((item) => item.id);
  items.forEach((item) => {
    rows.push(
      <ItemRow
        key={item.id}
        item={item}
        siblings={topIds}
        scope={scope}
        workspaceId={workspaceId}
        onChange={onChange}
      />,
    );
    if (item.type === "group") {
      const childIds = item.items.map((child) => child.id);
      item.items.forEach((child) =>
        rows.push(
          <ItemRow
            key={child.id}
            item={child}
            siblings={childIds}
            indent
            scope={scope}
            workspaceId={workspaceId}
            onChange={onChange}
          />,
        ),
      );
    }
  });
  return <>{rows}</>;
}

function useAppOptions(workspaceId: string, query: string) {
  const { client } = useAppContext();
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      void client
        .listArtifactCatalog(workspaceId, {
          kind: "site",
          status: "active",
          sort: "updated",
          limit: 50,
          ...(query.trim() ? { q: query.trim() } : {}),
          signal: abort.signal,
        })
        .then((page) =>
          setOptions(page.items.map((item) => ({ value: item.id, label: item.title }))),
        )
        .catch(() => undefined)
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 150);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [client, query, workspaceId]);
  return { options, loading };
}

/** The agents this person can see, to link one. */
function useAgentOptions(workspaceId: string, enabled: boolean) {
  const { client } = useAppContext();
  const [options, setOptions] = useState<{ value: string; label: string; leading: ReactNode }[]>(
    [],
  );
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setLoading(true);
    setError(null);
    void client
      .listAgents(workspaceId)
      .then((agents) => {
        if (!current) return;
        setOptions(
          agents.map((agent) => ({
            value: agent.id,
            label: agent.name,
            leading: (
              <SessionAvatar
                avatar={agent.avatar ?? agentInitialsAvatar(agent.name, agent.id)}
                name={agent.name}
                workspaceId={workspaceId}
                seed={agent.id}
              />
            ),
          })),
        );
      })
      .catch((caught: unknown) => {
        if (current) setError(userErrorText(caught));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [attempt, client, enabled, workspaceId]);
  return { options, loading, error, retry: () => setAttempt((value) => value + 1) };
}

export function AddForm({
  kind,
  workspaceId,
  groups,
  onAdd,
  onCancel,
}: {
  kind: AddKind;
  workspaceId: string;
  groups: { value: string; label: string }[];
  onAdd: (item: NewSidebarItem, groupId: string | undefined) => Promise<void>;
  onCancel: () => void;
}) {
  const [appQuery, setAppQuery] = useState("");
  const apps = useAppOptions(workspaceId, appQuery);
  const agents = useAgentOptions(workspaceId, kind === "agent");
  const [appId, setAppId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("https://");
  const [list, setList] = useState<SidebarLiveListKind>("recent_apps");
  const [group, setGroup] = useState(TOP_LEVEL);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const pathError =
    submitted && path.trim() && !isSidebarAppPath(path.trim())
      ? "Start with / (for example /releases)"
      : undefined;
  const urlError =
    submitted && !isSidebarExternalUrl(url.trim()) ? "Use an https:// address" : undefined;
  const labelError =
    submitted && (kind === "link" || kind === "group") && !label.trim() ? "Add a name" : undefined;
  const appError = submitted && kind === "app" && !appId ? "Choose an app" : undefined;
  const agentError = submitted && kind === "agent" && !agentId ? "Choose an agent" : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    const name = label.trim();
    let item: NewSidebarItem | null = null;
    if (kind === "app" && appId && (!path.trim() || isSidebarAppPath(path.trim())))
      item = {
        type: "app",
        appId,
        ...(path.trim() ? { path: path.trim() } : {}),
        ...(name ? { label: name } : {}),
      };
    else if (kind === "agent" && agentId)
      item = { type: "agent", agentId, ...(name ? { label: name } : {}) };
    else if (kind === "link" && name && isSidebarExternalUrl(url.trim()))
      item = { type: "link", url: url.trim(), label: name };
    else if (kind === "group" && name) item = { type: "group", label: name };
    else if (kind === "live_list")
      item = { type: "live_list", list, ...(name ? { label: name } : {}) };
    if (!item) return;
    setSaving(true);
    void onAdd(item, kind === "group" || group === TOP_LEVEL ? undefined : group).finally(() =>
      setSaving(false),
    );
  };
  return (
    <form
      onSubmit={submit}
      className="grid gap-4 rounded-[14px] border border-border bg-surface px-5 py-4"
      aria-label={`Add ${ADD_LABELS[kind].toLowerCase()}`}
    >
      {kind === "app" ? (
        <>
          <Field label="App" error={appError}>
            <SelectMenu
              variant="combobox"
              options={apps.options}
              value={appId}
              onValueChange={setAppId}
              placeholder="Choose an app"
              searchPlaceholder="Search apps"
              onSearchChange={setAppQuery}
              filterLocally={false}
              searching={apps.loading}
              emptyMessage="No apps found"
            />
          </Field>
          <Field
            label="Page"
            optional
            hint="A page inside the app, such as /releases"
            error={pathError}
          >
            <TextInput
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/"
            />
          </Field>
        </>
      ) : null}
      {kind === "agent" ? (
        <Field
          label="Agent"
          error={
            agents.error ? (
              <>
                {`Couldn't load agents. ${agents.error} `}
                <button type="button" className="og-link" onClick={agents.retry}>
                  Try again
                </button>
              </>
            ) : (
              agentError
            )
          }
        >
          <SelectMenu
            variant="combobox"
            options={agents.options}
            value={agentId}
            onValueChange={setAgentId}
            placeholder="Choose an agent"
            searchPlaceholder="Search agents"
            searching={agents.loading}
            emptyMessage={agents.error ? "Couldn't load agents" : "No agents found"}
          />
        </Field>
      ) : null}
      {kind === "link" ? (
        <Field label="Address" error={urlError}>
          <TextInput
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            inputMode="url"
          />
        </Field>
      ) : null}
      {kind === "live_list" ? (
        <Field label="Shows">
          <SelectMenu options={LIST_OPTIONS} value={list} onValueChange={setList} />
        </Field>
      ) : null}
      <Field
        label="Name"
        optional={kind === "app" || kind === "agent" || kind === "live_list"}
        error={labelError}
      >
        <TextInput
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={80}
        />
      </Field>
      {kind !== "group" && groups.length > 0 ? (
        <Field label="Group">
          <SelectMenu
            options={[{ value: TOP_LEVEL, label: "None" }, ...groups]}
            value={group}
            onValueChange={setGroup}
          />
        </Field>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          Add {ADD_LABELS[kind].toLowerCase()}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const NAV_ENTRY_LABELS: Record<SidebarNavEntry, string> = {
  inbox: "Inbox",
  capabilities: "Capabilities",
  knowledge: "Knowledge",
  automations: "Automations",
  agents: "Agents",
  meetings: "Meetings",
  artifacts: "Artifacts",
};

/**
 * The rest of the navigation, for the scope shown: apps as rows of their own
 * in the Sessions list, and which built-in rail entries show.
 */
function NavigationSection({
  options,
  onChange,
}: {
  options: { sessionsShowApps: boolean; hiddenNavEntries: string[] };
  onChange: (changes: SidebarLayoutChange[]) => void;
}) {
  const hidden = new Set(options.hiddenNavEntries);
  return (
    <Section title="Navigation" variant="group">
      <SettingRow
        label="Apps in Sessions"
        control={
          <Switch
            aria-label="Apps in Sessions"
            checked={options.sessionsShowApps}
            onCheckedChange={(checked) => onChange([{ op: "options", sessionsShowApps: checked }])}
          />
        }
      />
      <SettingRow
        label="Rail entries"
        control={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                {hidden.size === 0
                  ? "All shown"
                  : `${SIDEBAR_NAV_ENTRIES.length - hidden.size} of ${SIDEBAR_NAV_ENTRIES.length} shown`}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {SIDEBAR_NAV_ENTRIES.map((entry) => (
                <DropdownMenuCheckboxItem
                  key={entry}
                  checked={!hidden.has(entry)}
                  onSelect={(event) => {
                    event.preventDefault();
                    const next = SIDEBAR_NAV_ENTRIES.filter((each) =>
                      each === entry ? !hidden.has(entry) : hidden.has(each),
                    );
                    onChange([{ op: "options", hiddenNavEntries: next }]);
                  }}
                >
                  {NAV_ENTRY_LABELS[entry]}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
    </Section>
  );
}

export function SidebarCustomizeRoute({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const { layout, failed, update } = useSidebarLayout(workspaceId);
  const [scope, setScope] = useState<Scope>("personal");
  const [adding, setAdding] = useState<AddKind | null>(null);
  const canEditWorkspace = layout?.workspace.canEdit === true;
  const personalAvailable = layout?.personal.available !== false;
  const effectiveScope: Scope =
    scope === "workspace" && canEditWorkspace
      ? "workspace"
      : personalAvailable
        ? "personal"
        : "workspace";
  const items = useMemo(
    () => (effectiveScope === "workspace" ? layout?.workspace.items : layout?.items) ?? [],
    [effectiveScope, layout],
  );
  const groups = items
    .filter((item) => item.type === "group")
    .map((item) => ({ value: item.id, label: item.label }));
  const change = async (changes: SidebarLayoutChange[]) => {
    try {
      await update({ scope: effectiveScope, changes });
    } catch (error) {
      toast.error("Couldn't change the sidebar", {
        description: userErrorText(error),
      });
      throw error;
    }
  };
  const onChange = (changes: SidebarLayoutChange[]) => void change(changes).catch(() => undefined);
  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" disabled={!layout || (!personalAvailable && !canEditWorkspace)}>
          <PlusIcon />
          Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {(Object.keys(ADD_LABELS) as AddKind[]).map((kind) => (
          <DropdownMenuItem key={kind} onSelect={() => setAdding(kind)}>
            {ADD_LABELS[kind]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <ContentPage width="standard">
      <PageHeader
        title="Sidebar"
        description={
          effectiveScope === "workspace"
            ? "What everyone in this workspace starts with."
            : "Links and groups above your chats."
        }
        actions={addMenu}
      />
      {canEditWorkspace && personalAvailable ? (
        <SegmentedControl
          aria-label="Whose sidebar"
          options={[
            { value: "personal", label: "Yours" },
            { value: "workspace", label: "Workspace default" },
          ]}
          value={effectiveScope}
          onValueChange={(next) => {
            setScope(next);
            setAdding(null);
          }}
          className="mb-6 self-start"
        />
      ) : null}
      <div className="grid gap-8">
        {adding ? (
          <AddForm
            key={`${effectiveScope}:${adding}`}
            kind={adding}
            workspaceId={workspaceId}
            groups={groups}
            onCancel={() => setAdding(null)}
            onAdd={async (item, groupId) => {
              await change([{ op: "add", item, ...(groupId ? { groupId } : {}) }]);
              setAdding(null);
            }}
          />
        ) : null}
        {layout ? (
          items.length ? (
            <Section variant="group" aria-label="Sidebar items">
              <ItemRows
                items={items}
                scope={effectiveScope}
                workspaceId={workspaceId}
                onChange={onChange}
              />
            </Section>
          ) : (
            <p className="text-sm text-fg-muted">
              Nothing here yet. Add an app, an agent, a link or a group.
            </p>
          )
        ) : failed ? (
          <p className="text-sm text-fg-muted">Couldn't load the sidebar. Try again shortly.</p>
        ) : null}
        {effectiveScope === "personal" && layout && layout.hidden.length > 0 ? (
          <Section title="Hidden" variant="group">
            {layout.hidden.map(({ item }) => (
              <div key={item.id} className="flex min-h-12 items-center gap-3 py-2">
                {itemIcon(item, (path) => pathHasAppPage(router, path), workspaceId)}
                <div className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {item.label}
                </div>
                <RowButton onClick={() => onChange([{ op: "show", itemId: item.id }])}>
                  Show
                </RowButton>
              </div>
            ))}
          </Section>
        ) : null}
        {layout && (effectiveScope === "workspace" || personalAvailable) ? (
          <NavigationSection
            options={
              effectiveScope === "workspace"
                ? readResolvedSidebarOptions(layout.workspace.options)
                : readResolvedSidebarOptions(layout.options)
            }
            onChange={onChange}
          />
        ) : null}
        {effectiveScope === "personal" && layout?.personal.customized ? (
          <div>
            <RowButton onClick={() => onChange([{ op: "reset" }])}>
              Reset to workspace default
            </RowButton>
          </div>
        ) : null}
      </div>
    </ContentPage>
  );
}
