import { useEffect, useRef, useState } from "react";
import {
  Rows3Icon,
  ListIcon,
  PanelTopIcon,
  SearchIcon,
  PanelRightIcon,
  CircleDotIcon,
  ListChecksIcon,
  CheckIcon,
  ArrowRightIcon,
  MoonIcon,
  SunIcon,
  DownloadIcon,
  CopyIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  LayersIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { categories, selectionText, type CategoryId, type Favorites } from "./options";
import {
  PreferenceRows,
  ResourceList,
  ViewTabs,
  SearchToolbar,
  DetailSurface,
  ConnectionDetailsForm,
  SingleChoice,
  MultipleChoice,
  connectionSamples,
  type RowItem,
} from "./candidates";
import { cn } from "@/lib/utils";

const icons = {
  rows: Rows3Icon,
  lists: ListIcon,
  tabs: PanelTopIcon,
  search: SearchIcon,
  details: PanelRightIcon,
  selection: CircleDotIcon,
  multiple: ListChecksIcon,
};
const initialRows: RowItem[] = [
  {
    id: "voice",
    title: "Voice input",
    description: "Allow voice input in the chat composer.",
    group: "Conversation",
    checked: true,
  },
  {
    id: "notifications",
    title: "Desktop notifications",
    description: "Notify you when an agent needs attention.",
    group: "Notifications",
    checked: true,
  },
  {
    id: "sound",
    title: "Notification sounds",
    description: "Play a sound with desktop notifications.",
    group: "Notifications",
    checked: false,
  },
];

export function ComponentGallery() {
  const [categoryId, setCategoryId] = useState<CategoryId>("rows");
  const category = categories.find((item) => item.id === categoryId)!;
  const [favorites, setFavorites] = useState<Favorites>({});
  const [theme, setTheme] = useState("dark");
  const [layout, setLayout] = useState("compare");
  const [focused, setFocused] = useState<string>("compact");
  const [rows, setRows] = useState(initialRows);
  const [disabled, setDisabled] = useState(false);
  const [view, setView] = useState("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("recent");
  const [selected, setSelected] = useState(["github"]);
  const [name, setName] = useState("Engineering GitHub");
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.dataset.ogTheme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  function navigate(id: CategoryId) {
    setCategoryId(id);
    setFocused(categories.find((item) => item.id === id)!.options[0].id);
    setQuery("");
    setStatus("all");
    setView("all");
    setMessage("");
    contentRef.current?.scrollTo({ top: 0 });
  }
  const results = connectionSamples.filter(
    (item) =>
      (view === "all" || item.status === "Connected") &&
      (status === "all" || item.status === status) &&
      `${item.name} ${item.detail}`.toLowerCase().includes(query.toLowerCase()),
  );
  const example = (option: string) => {
    if (categoryId === "rows")
      return (
        <PreferenceRows
          variant={option as "compact" | "comfortable" | "grouped"}
          items={rows}
          disabled={disabled}
          onChange={(id, checked) =>
            setRows((current) =>
              current.map((item) => (item.id === id ? { ...item, checked } : item)),
            )
          }
        />
      );
    if (categoryId === "lists")
      return (
        <ResourceList
          variant={option as "simple" | "metadata" | "table"}
          items={connectionSamples}
          onDetails={setDetail}
        />
      );
    if (categoryId === "tabs")
      return (
        <ViewTabs variant={option as "line" | "segmented"} value={view} onChange={setView}>
          <ResourceList variant="simple" items={results} onDetails={setDetail} />
        </ViewTabs>
      );
    if (categoryId === "search") {
      const toolbar = (
        <SearchToolbar query={query} onQuery={setQuery} status={status} onStatus={setStatus} />
      );
      return (
        <>
          {option === "above" && toolbar}
          <ViewTabs variant="line" value={view} onChange={setView}>
            {option === "below" && toolbar}
            <ResourceList variant="simple" items={results} onDetails={setDetail} />
          </ViewTabs>
        </>
      );
    }
    if (categoryId === "details")
      return (
        <>
          <p className="mb-1 text-sm font-medium">{name}</p>
          <p className="mb-5 text-xs text-fg-muted">GitHub · Workspace connection</p>
          <DetailSurface
            variant={option as "inline" | "sheet" | "dialog"}
            title="Connection details"
            description="Same fields, different presentation. Sample data only."
          >
            {(close) => (
              <ConnectionDetailsForm
                key={name}
                name={name}
                onSave={(next) => {
                  setName(next);
                  setMessage("Connection name updated across the examples only.");
                  close();
                }}
                onCancel={close}
              />
            )}
          </DetailSurface>
        </>
      );
    if (categoryId === "selection")
      return (
        <SingleChoice variant={option as "select" | "radio"} value={sort} onChange={setSort} />
      );
    if (option === "visible") return <MultipleChoice selected={selected} onChange={setSelected} />;
    return (
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger asChild>
          <Button variant="outline" className="w-full justify-between">
            Include connections
            <span className="text-xs text-fg-muted">{selected.length} selected</span>
          </Button>
        </CollapsibleTrigger>
        <p className="my-3 text-xs leading-5 text-fg-muted">
          {connectionSamples
            .filter((item) => selected.includes(item.id))
            .map((item) => item.name)
            .join(", ") || "None selected"}
        </p>
        <CollapsibleContent>
          <div className="mt-4 border-t border-border pt-4">
            <MultipleChoice selected={selected} onChange={setSelected} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };
  const summary = selectionText(favorites, notes);
  const chosenCount = Object.values(favorites).filter(Boolean).length;
  async function copyChoices() {
    try {
      await navigator.clipboard.writeText(summary);
      setMessage("Preferences copied. Paste them into our conversation when you are ready.");
    } catch {
      summaryRef.current?.focus();
      summaryRef.current?.select();
      setMessage(
        "Clipboard access is unavailable here. The text is selected below; copy it manually or download it.",
      );
    }
  }
  function downloadChoices() {
    const url = URL.createObjectURL(new Blob([summary], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "opengeni-component-preferences.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="flex h-dvh flex-col bg-bg text-fg">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-surface/40 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <LayersIcon className="size-4" />
          </span>
          <div>
            <p className="text-sm font-semibold tracking-tight">
              OpenGeni <span className="font-normal text-fg-muted">/ Component studio</span>
            </p>
            <p className="mt-0.5 text-2xs text-fg-muted">
              Explore first. Choose together. Implement later.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setSummaryOpen(true);
              setMessage("");
            }}
          >
            Your choices{" "}
            <span className="rounded bg-surface-2 px-1.5 text-xs">
              {chosenCount}/{categories.length}
            </span>
          </Button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[230px_minmax(0,1fr)] lg:grid-rows-1">
        <aside className="border-b border-border bg-surface/20 px-4 py-3 lg:overflow-y-auto lg:border-r lg:border-b-0 lg:p-5">
          <label className="grid gap-2 lg:hidden">
            <span className="sr-only">Component category</span>
            <Select
              aria-label="Component category"
              value={categoryId}
              onChange={(event) => navigate(event.target.value as CategoryId)}
            >
              {categories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </Select>
          </label>
          <div className="hidden lg:block">
            <p className="mb-4 px-2 text-2xs font-semibold uppercase tracking-widest text-fg-muted">
              Choose by use case
            </p>
            <nav aria-label="Component categories" className="grid gap-1">
              {categories.map((item) => {
                const Icon = icons[item.id];
                return (
                  <button
                    key={item.id}
                    aria-current={categoryId === item.id ? "page" : undefined}
                    aria-label={item.title}
                    aria-description={favorites[item.id] ? "Preference selected" : undefined}
                    onClick={() => navigate(item.id)}
                    className={cn(
                      "flex min-h-11 items-center gap-2.5 rounded-md px-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      categoryId === item.id
                        ? "bg-surface-3 font-medium"
                        : "text-fg-muted hover:bg-surface-2",
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="flex-1">{item.title}</span>
                    {favorites[item.id] && (
                      <CheckIcon aria-hidden="true" className="size-3.5 text-brand" />
                    )}
                  </button>
                );
              })}
            </nav>
            <div className="mt-8 border-t border-border px-2 pt-5">
              <p className="text-xs font-medium">A visual decision, not a rollout</p>
              <p className="mt-2 text-xs leading-5 text-fg-muted">
                Existing functionality, meaningful icons, and the Insights dashboard stay as they
                are.
              </p>
              <p className="mt-3 text-xs leading-5 text-fg-muted">
                Your favorites are local to this open page. Copy or download them before closing.
              </p>
            </div>
          </div>
        </aside>
        <main ref={contentRef} className="min-h-0 min-w-0 overflow-y-auto overscroll-y-contain">
          <div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-7 lg:py-9">
            <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-2xl">
                <p className="mb-2 text-2xs font-semibold uppercase tracking-widest text-brand">
                  {String(categories.findIndex((item) => item.id === categoryId) + 1).padStart(
                    2,
                    "0",
                  )}{" "}
                  / Compare components
                </p>
                <h1 className="text-2xl font-semibold tracking-tight">{category.title}</h1>
                <p className="mt-2 text-sm leading-6 text-fg-muted">{category.description}</p>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  aria-label="Comparison layout"
                  value={layout}
                  onChange={(event) => setLayout(event.target.value)}
                >
                  <option value="compare">Side by side</option>
                  <option value="focus">One at a time</option>
                </Select>
                {layout === "focus" && (
                  <Select
                    aria-label="Focused option"
                    value={focused}
                    onChange={(event) => setFocused(event.target.value)}
                  >
                    {category.options.map((option, index) => (
                      <option key={option.id} value={option.id}>
                        {String.fromCharCode(65 + index)} · {option.title}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            </div>
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 text-xs text-fg-muted">
              <span className="flex items-center gap-2">
                <SlidersHorizontalIcon className="size-3.5" />
                Working controls · Shared example state · No live writes
              </span>
              {categoryId === "rows" && (
                <label className="flex min-h-9 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={disabled}
                    onChange={(event) => setDisabled(event.target.checked)}
                    className="accent-brand"
                  />
                  Show disabled state
                </label>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRows(initialRows);
                  setDisabled(false);
                  setView("all");
                  setQuery("");
                  setStatus("all");
                  setSort("recent");
                  setSelected(["github"]);
                  setName("Engineering GitHub");
                  setMessage("Examples reset. Your favorites are unchanged.");
                }}
              >
                <RotateCcwIcon />
                Reset examples
              </Button>
            </div>
            {message && !summaryOpen && (
              <p role="status" className="mb-4 rounded-md bg-surface-2 px-4 py-3 text-xs">
                {message}
              </p>
            )}
            <div
              className={cn(
                "grid items-start gap-5",
                layout === "compare"
                  ? category.options.length === 3
                    ? "xl:grid-cols-3"
                    : "xl:grid-cols-2"
                  : "mx-auto max-w-3xl",
              )}
            >
              {category.options.map(
                (option, index) =>
                  (layout === "compare" || option.id === focused) && (
                    <section
                      key={`${categoryId}-${option.id}`}
                      aria-label={`Option ${String.fromCharCode(65 + index)}: ${option.title}`}
                      className={cn(
                        "min-w-0 rounded-xl border bg-surface/25",
                        favorites[categoryId] === option.id ? "border-brand/70" : "border-border",
                      )}
                    >
                      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-xs font-semibold text-fg-muted">
                          {String.fromCharCode(65 + index)}
                        </span>
                        <h2 className="text-sm font-semibold">{option.title}</h2>
                      </div>
                      <div className="min-w-0 px-5 py-5 sm:px-6">{example(option.id)}</div>
                      <div className="border-t border-border px-5 py-4">
                        <p className="text-xs leading-5">
                          <span className="font-medium">Best for </span>
                          <span className="text-fg-muted">{option.use}</span>
                        </p>
                        <p className="mt-2 text-xs leading-5">
                          <span className="font-medium">Tradeoff </span>
                          <span className="text-fg-muted">{option.tradeoff}</span>
                        </p>
                        <Button
                          className="mt-4 w-full"
                          aria-pressed={favorites[categoryId] === option.id}
                          variant={favorites[categoryId] === option.id ? "default" : "outline"}
                          onClick={() =>
                            setFavorites((current) => ({
                              ...current,
                              [categoryId]:
                                current[categoryId] === option.id ? undefined : option.id,
                            }))
                          }
                        >
                          {favorites[categoryId] === option.id ? (
                            <>
                              <CheckIcon />
                              Preferred for this use case
                            </>
                          ) : (
                            <>
                              Prefer {String.fromCharCode(65 + index)}
                              <ArrowRightIcon />
                            </>
                          )}
                        </Button>
                      </div>
                    </section>
                  ),
              )}
            </div>
            <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
              <p className="max-w-2xl text-xs leading-5 text-fg-muted">
                No universal winner is required. You can mix patterns by use case or leave a
                category undecided. These are reusable candidate components; production setup flows
                will be reviewed after we select the patterns.
              </p>
              <Button
                variant="ghost"
                onClick={() =>
                  navigate(
                    categories[
                      (categories.findIndex((item) => item.id === categoryId) + 1) %
                        categories.length
                    ]!.id,
                  )
                }
              >
                Next use case
                <ArrowRightIcon />
              </Button>
            </div>
          </div>
        </main>
      </div>
      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Your component preferences</DialogTitle>
            <DialogDescription>
              For discussion—not implementation approval. Nothing is saved to your account or sent
              to the agent. Copy or download before closing this page.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-2 text-sm">
            Anything you would change?
            <Textarea
              aria-label="Anything you would change?"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="For example: B for everyday settings, A for long permission lists…"
            />
          </label>
          <label className="grid gap-2 text-sm">
            Selection summary
            <Textarea
              aria-label="Selection summary"
              ref={summaryRef}
              readOnly
              value={summary}
              rows={10}
              className="text-xs leading-5"
            />
          </label>
          {message && (
            <p role="status" className="text-xs leading-5 text-fg-muted">
              {message}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={downloadChoices}>
              <DownloadIcon />
              Download choices
            </Button>
            <Button onClick={() => void copyChoices()}>
              <CopyIcon />
              Copy choices
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{connectionSamples.find((item) => item.id === detail)?.name}</DialogTitle>
            <DialogDescription>
              {connectionSamples.find((item) => item.id === detail)?.detail}. Sample connection; no
              provider requests are made.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            Status: {connectionSamples.find((item) => item.id === detail)?.status}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setDetail(null);
              navigate("details");
            }}
          >
            Compare detail presentations
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
