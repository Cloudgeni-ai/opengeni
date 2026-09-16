import { useId, useState, type ReactNode } from "react";
import {
  GitBranchIcon,
  MessageSquareIcon,
  FolderIcon,
  MoreHorizontalIcon,
  SearchIcon,
  ChevronDownIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SettingsSwitch } from "@/components/ui/settings-patterns";
import { FormField, DataScroller } from "@/components/ui/content-layout";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type RowItem = {
  id: string;
  title: string;
  description: string;
  group: string;
  checked: boolean;
};
/** Candidate components are controlled, data-driven exports, not gallery-only lookalikes. */
export function PreferenceRows({
  variant,
  items,
  onChange,
  disabled = false,
}: {
  variant: "compact" | "comfortable" | "grouped";
  items: RowItem[];
  onChange: (id: string, value: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const row = (item: RowItem) => (
    <div
      key={item.id}
      className={cn(
        "flex items-center gap-3 border-b border-border last:border-0",
        variant === "compact" ? "py-1.5" : "py-4",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.title}</p>
        <p id={`${id}-${item.id}`} className="mt-1 text-xs leading-5 text-fg-muted">
          {item.description}
        </p>
      </div>
      <SettingsSwitch
        aria-label={item.title}
        aria-describedby={`${id}-${item.id}`}
        checked={item.checked}
        onCheckedChange={(next) => onChange(item.id, next)}
        disabled={disabled}
      />
    </div>
  );
  return (
    <div>
      {variant === "grouped"
        ? [...new Set(items.map((item) => item.group))].map((group) => (
            <section key={group} className="mb-5 last:mb-0">
              <h3 className="border-b border-border pb-2 text-2xs font-semibold uppercase tracking-wider text-fg-muted">
                {group}
              </h3>
              {items.filter((item) => item.group === group).map(row)}
            </section>
          ))
        : items.map(row)}
    </div>
  );
}

export const connectionSamples = [
  {
    id: "github",
    name: "GitHub",
    detail: "Repositories and pull requests",
    status: "Connected",
    icon: GitBranchIcon,
  },
  {
    id: "slack",
    name: "Slack",
    detail: "Messages and channels",
    status: "Connected",
    icon: MessageSquareIcon,
  },
  {
    id: "drive",
    name: "Google Drive",
    detail: "Documents and folders",
    status: "Not connected",
    icon: FolderIcon,
  },
];
export type ResourceItem = {
  id: string;
  name: string;
  detail: string;
  status: string;
  icon: typeof GitBranchIcon;
};
export function ResourceList({
  variant,
  items,
  onDetails,
}: {
  variant: "simple" | "metadata" | "table";
  items: ResourceItem[];
  onDetails: (id: string) => void;
}) {
  const menu = (item: ResourceItem) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${item.name}`}>
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onDetails(item.id)}>View details</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  if (!items.length)
    return (
      <EmptyState
        title="No matching connections"
        description="Try another search or change the filter."
      />
    );
  if (variant === "table")
    return (
      <DataScroller aria-label="Connections table">
        <table className="w-full min-w-[360px] text-left text-xs">
          <caption className="sr-only">Connections and their status</caption>
          <thead className="border-b border-border text-fg-muted">
            <tr>
              <th scope="col" className="py-3 font-medium">
                Connection
              </th>
              <th scope="col" className="px-2 font-medium">
                Status
              </th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-border last:border-0">
                <td className="py-4">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <item.icon aria-hidden="true" className="size-4" />
                    {item.name}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-fg-muted">{item.detail}</span>
                </td>
                <td className="px-2 whitespace-nowrap text-fg-muted">{item.status}</td>
                <td>{menu(item)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataScroller>
    );
  return (
    <div>
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            "flex items-center gap-3 border-b border-border last:border-0",
            variant === "simple" ? "py-3" : "py-5",
          )}
        >
          <span
            className={cn(
              "shrink-0 text-fg-muted",
              variant === "metadata" &&
                "flex size-9 items-center justify-center rounded-md bg-surface-2",
            )}
          >
            <item.icon aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{item.name}</p>
            <p className="mt-1 text-xs leading-5 text-fg-muted">{item.detail}</p>
            {variant === "metadata" ? (
              <Badge variant="secondary" className="mt-2">
                {item.status}
              </Badge>
            ) : (
              <span className="mt-0.5 block text-2xs text-fg-muted">{item.status}</span>
            )}
          </div>
          {menu(item)}
        </div>
      ))}
    </div>
  );
}

export function ViewTabs({
  variant,
  value,
  onChange,
  children,
}: {
  variant: "line" | "segmented";
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <Tabs value={value} onValueChange={onChange}>
      <div
        className={cn(
          "mb-3 max-w-full overflow-x-auto pb-1",
          variant === "line" && "border-b border-border",
        )}
      >
        <TabsList variant={variant === "line" ? "line" : "default"} aria-label="Connection views">
          <TabsTrigger value="all">All · 3</TabsTrigger>
          <TabsTrigger value="connected">Connected · 2</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value={value}>{children}</TabsContent>
    </Tabs>
  );
}
export function SearchToolbar({
  query,
  onQuery,
  status,
  onStatus,
}: {
  query: string;
  onQuery: (value: string) => void;
  status: string;
  onStatus: (value: string) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      <div className="relative min-w-0 flex-1 basis-40">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
        />
        <Input
          type="search"
          aria-label="Search active view"
          placeholder="Search active view…"
          className="pl-9"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      <Select
        aria-label="Connection status"
        value={status}
        onChange={(event) => onStatus(event.target.value)}
      >
        <option value="all">Any status</option>
        <option value="Connected">Connected</option>
        <option value="Not connected">Not connected</option>
      </Select>
    </div>
  );
}

export function DetailSurface({
  variant,
  title,
  description,
  children,
}: {
  variant: "inline" | "sheet" | "dialog";
  title: string;
  description: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = <Button variant="outline">Edit details</Button>;
  if (variant === "inline")
    return (
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="outline">
            {open ? "Hide details" : "Edit details"}
            <ChevronDownIcon />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-5 border-t border-border pt-5">
            <h3 className="mb-1 text-sm font-semibold">{title}</h3>
            <p className="mb-5 text-xs leading-5 text-fg-muted">{description}</p>
            {children(() => setOpen(false))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  if (variant === "sheet")
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent className="w-full max-w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">{children(() => setOpen(false))}</div>
        </SheetContent>
      </Sheet>
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children(() => setOpen(false))}
      </DialogContent>
    </Dialog>
  );
}
export function ConnectionDetailsForm({
  name,
  onSave,
  onCancel,
}: {
  name: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const id = useId();
  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim()) onSave(draft.trim());
      }}
    >
      <FormField label="Connection name" hint="Changes apply only to these gallery examples.">
        <Input
          required
          maxLength={80}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </FormField>
      <div>
        <p id={id} className="text-xs leading-5 text-fg-muted">
          GitHub · Workspace connection. Authorization and provider setup are outside this component
          comparison.
        </p>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!draft.trim()}>
          Apply to examples
        </Button>
      </div>
    </form>
  );
}
export const sortOptions = [
  { id: "recent", label: "Recently used", description: "Keep active connections at the top." },
  { id: "name", label: "Name", description: "Show connections alphabetically." },
  { id: "status", label: "Connection status", description: "Group connections by availability." },
];
export function SingleChoice({
  variant,
  value,
  onChange,
}: {
  variant: "select" | "radio";
  value: string;
  onChange: (value: string) => void;
}) {
  const name = useId();
  if (variant === "select")
    return (
      <FormField label="Sort connections">
        <Select value={value} onChange={(event) => onChange(event.target.value)}>
          {sortOptions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </Select>
        <span className="text-xs font-normal leading-5 text-fg-muted">
          {sortOptions.find((item) => item.id === value)?.description}
        </span>
      </FormField>
    );
  return (
    <fieldset>
      <legend className="mb-3 text-sm font-medium">Sort connections</legend>
      <div className="grid gap-3">
        {sortOptions.map((item) => (
          <label
            key={item.id}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md py-2"
          >
            <input
              type="radio"
              name={name}
              value={item.id}
              checked={value === item.id}
              onChange={() => onChange(item.id)}
              className="mt-1 size-4 shrink-0 accent-brand"
            />
            <span>
              <span className="block text-sm">{item.label}</span>
              <span className="mt-1 block text-xs leading-5 text-fg-muted">{item.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
export function MultipleChoice({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (selected: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const items = connectionSamples.filter((item) =>
    item.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <fieldset>
      <legend className="mb-3 text-sm font-medium">Include connections</legend>
      <Input
        type="search"
        aria-label="Find connections to include"
        placeholder="Find a connection…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <p className="my-3 text-xs text-fg-muted">
        {selected.length} selected · Multiple choices allowed
      </p>
      {items.map((item) => (
        <label
          key={item.id}
          className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-border last:border-0"
        >
          <input
            type="checkbox"
            checked={selected.includes(item.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, item.id]
                  : selected.filter((id) => id !== item.id),
              )
            }
            className="size-4 accent-brand"
          />
          <item.icon aria-hidden="true" className="size-4 text-fg-muted" />
          <span className="text-sm">{item.name}</span>
        </label>
      ))}
      {!items.length && <p className="py-4 text-xs text-fg-muted">No matching connections.</p>}
    </fieldset>
  );
}
