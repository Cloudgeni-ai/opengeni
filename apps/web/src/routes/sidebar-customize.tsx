// Sidebar: the links and groups above your chats (docs/sidebar-layout.md).
// "Yours" is the workspace default with your own changes (add, hide,
// reorder, reset); admins also edit the "Workspace default" everyone starts
// from.
import {
  AppWindowIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  FolderIcon,
  ListIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type {
  NewSidebarItem,
  ResolvedSidebarItem,
  SidebarLayoutChange,
  SidebarLiveListKind,
} from "@opengeni/sdk";
import { isSidebarAppPath, isSidebarExternalUrl } from "@opengeni/contracts/sidebar-layout";
import { useAppContext } from "@opengeni/react/app/app-context";
import { Button } from "@opengeni/react/ui/button";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@opengeni/react/ui/dropdown-menu";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Field, TextInput } from "@opengeni/react/ui/field";
import { MoreMenu, RowButton } from "@opengeni/react/ui/page-actions";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { Section } from "@opengeni/react/ui/section";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { SelectMenu } from "@opengeni/react/ui/select-menu";
import { useSidebarLayout } from "@/components/sidebar-layout/use-sidebar-layout";

type Scope = "personal" | "workspace";
type AddKind = "app" | "link" | "group" | "live_list";

const ADD_LABELS: Record<AddKind, string> = {
  app: "App",
  link: "Link",
  group: "Group",
  live_list: "List",
};

const LIST_OPTIONS: { value: SidebarLiveListKind; label: string }[] = [
  { value: "pinned_apps", label: "Pinned apps" },
  { value: "recent_apps", label: "Recent apps" },
];

const TOP_LEVEL = "__top";

function itemIcon(item: ResolvedSidebarItem) {
  const className = "size-4 shrink-0 text-fg-muted";
  if (item.type === "group") return <FolderIcon aria-hidden="true" className={className} />;
  if (item.type === "link") return <ArrowUpRightIcon aria-hidden="true" className={className} />;
  if (item.type === "live_list") return <ListIcon aria-hidden="true" className={className} />;
  return <AppWindowIcon aria-hidden="true" className={className} />;
}

function itemDetail(item: ResolvedSidebarItem): string | null {
  if (item.type === "app") return item.path;
  if (item.type === "link") return item.url.replace(/^https:\/\//u, "");
  if (item.type === "live_list") return `Up to ${item.limit}`;
  return null;
}

function ItemRow({
  item,
  index,
  count,
  indent,
  scope,
  onChange,
}: {
  item: ResolvedSidebarItem;
  index: number;
  count: number;
  indent?: boolean;
  scope: Scope;
  onChange: (changes: SidebarLayoutChange[]) => void;
}) {
  const detail = itemDetail(item);
  const fromWorkspace = scope === "personal" && item.origin === "workspace";
  return (
    <div
      className={indent ? "flex min-h-12 items-center gap-3 py-2 pl-7" : "flex min-h-12 items-center gap-3 py-2"}
    >
      {itemIcon(item)}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg">{item.label}</div>
        {detail || fromWorkspace ? (
          <div className="truncate text-xs text-fg-muted">
            {[fromWorkspace ? "Workspace" : null, detail].filter(Boolean).join(" · ")}
          </div>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${item.label} up`}
        disabled={index === 0}
        onClick={() => onChange([{ op: "move", itemId: item.id, index: index - 1 }])}
        className="text-fg-subtle hover:text-fg pointer-coarse:size-11"
      >
        <ArrowUpIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${item.label} down`}
        disabled={index === count - 1}
        onClick={() => onChange([{ op: "move", itemId: item.id, index: index + 1 }])}
        className="text-fg-subtle hover:text-fg pointer-coarse:size-11"
      >
        <ArrowDownIcon />
      </Button>
      <MoreMenu label={`More for ${item.label}`} quiet>
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
  onChange,
}: {
  items: ResolvedSidebarItem[];
  scope: Scope;
  onChange: (changes: SidebarLayoutChange[]) => void;
}) {
  const rows: ReactNode[] = [];
  items.forEach((item, index) => {
    rows.push(
      <ItemRow
        key={item.id}
        item={item}
        index={index}
        count={items.length}
        scope={scope}
        onChange={onChange}
      />,
    );
    if (item.type === "group")
      item.items.forEach((child, childIndex) =>
        rows.push(
          <ItemRow
            key={child.id}
            item={child}
            index={childIndex}
            count={item.items.length}
            indent
            scope={scope}
            onChange={onChange}
          />,
        ),
      );
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
        .then((page) => setOptions(page.items.map((item) => ({ value: item.id, label: item.title }))))
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

function AddForm({
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
  const [appId, setAppId] = useState<string | null>(null);
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
  const appError = submitted && kind === "app" && !appId ? "Choose an App" : undefined;
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
    else if (kind === "link" && name && isSidebarExternalUrl(url.trim()))
      item = { type: "link", url: url.trim(), label: name };
    else if (kind === "group" && name) item = { type: "group", label: name };
    else if (kind === "live_list") item = { type: "live_list", list, ...(name ? { label: name } : {}) };
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
              placeholder="Choose an App"
              searchPlaceholder="Search Apps"
              onSearchChange={setAppQuery}
              filterLocally={false}
              searching={apps.loading}
              emptyMessage="No Apps found"
            />
          </Field>
          <Field label="Page" optional hint="A page inside the App, such as /releases" error={pathError}>
            <TextInput value={path} onChange={(event) => setPath(event.target.value)} placeholder="/" />
          </Field>
        </>
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
        optional={kind === "app" || kind === "live_list"}
        error={labelError}
      >
        <TextInput value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} />
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

export function SidebarCustomizeRoute({ workspaceId }: { workspaceId: string }) {
  const { layout, failed, update } = useSidebarLayout(workspaceId);
  const [scope, setScope] = useState<Scope>("personal");
  const [adding, setAdding] = useState<AddKind | null>(null);
  const canEditWorkspace = layout?.workspace.canEdit === true;
  const personalAvailable = layout?.personal.available !== false;
  const effectiveScope: Scope =
    scope === "workspace" && canEditWorkspace ? "workspace" : personalAvailable ? "personal" : "workspace";
  const items = useMemo(
    () =>
      (effectiveScope === "workspace" ? layout?.workspace.items : layout?.items) ?? [],
    [effectiveScope, layout],
  );
  const groups = items
    .filter((item) => item.type === "group")
    .map((item) => ({ value: item.id, label: item.label }));
  const change = async (changes: SidebarLayoutChange[]) => {
    try {
      await update({ scope: effectiveScope, changes });
    } catch (error) {
      toast.error("Couldn't change the sidebar", { description: userErrorText(error) });
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
              <ItemRows items={items} scope={effectiveScope} onChange={onChange} />
            </Section>
          ) : (
            <p className="text-sm text-fg-muted">Nothing here yet. Add an App, a link or a group.</p>
          )
        ) : failed ? (
          <p className="text-sm text-fg-muted">Couldn't load the sidebar. Try again shortly.</p>
        ) : null}
        {effectiveScope === "personal" && layout && layout.hidden.length > 0 ? (
          <Section title="Hidden" variant="group">
            {layout.hidden.map(({ item }) => (
              <div key={item.id} className="flex min-h-12 items-center gap-3 py-2">
                {itemIcon(item)}
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
        {effectiveScope === "personal" && layout?.personal.customized ? (
          <div>
            <RowButton onClick={() => onChange([{ op: "reset" }])}>Reset to workspace default</RowButton>
          </div>
        ) : null}
      </div>
    </ContentPage>
  );
}
