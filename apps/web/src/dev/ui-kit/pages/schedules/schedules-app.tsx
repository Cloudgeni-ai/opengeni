/**
 * The Schedules page preview: the list, each schedule's detail page, the
 * New/Edit schedule pages, the Rename dialog and the delete confirm, inside
 * the app frame. Detail, create and edit are pages in the content column with
 * a back link; only Rename and Delete are small centered dialogs. Everything
 * runs on fixtures; nothing touches the network.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CalendarClockIcon,
  CopyIcon,
  GitPullRequestIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SunriseIcon,
  Trash2Icon,
  TrendingUpIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DestructiveConfirmPanel, showUndoToast } from "@/components/ui/destructive-confirm";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FormFrame } from "@/components/ui/form-dialog";
import { Disclosure } from "@/components/ui/disclosure";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  EmptyState,
  EmptyStateLink,
  EmptyStateTemplate,
  EmptyStateTemplates,
} from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import {
  ListRow,
  ListRowSkeleton,
  RowList,
  useRowListVariant,
  type RowListColumn,
} from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { PageHeader, PageHeaderStyleProvider } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

import {
  KIT_NOW,
  KIT_TIME_ZONE,
  personById,
  scheduleTemplates,
  type ScheduleRun,
} from "../../fixtures";
import { AppFrame, FrameOverlay } from "./frame";
import {
  cadenceShort,
  createItem,
  displayName,
  draftFromTemplate,
  draftOf,
  duplicateDraft,
  emptyDraft,
  initialItems,
  nextRunOf,
  permissionsFor,
  runTimeLabel,
  sortItems,
  type ScheduleDraft,
  type ScheduleItem,
  type SchedulesQuestions,
} from "./model";
import { SchedulePage, type ScheduleDetailProps } from "./schedule-detail";
import { ScheduleForm } from "./schedule-form";
import { useSchedulePicks, type SchedulePicks } from "./use-picks";

const TIME = { now: KIT_NOW, timeZone: KIT_TIME_ZONE };

export type SchedulesDataState = "ready" | "empty" | "loading" | "error";

export type InitialForm =
  | { mode: "create" }
  | { mode: "template"; templateId: string }
  | { mode: "edit"; id: string };

interface FormState {
  mode: "create" | "edit";
  editingId?: string;
  initial: ScheduleDraft;
  /** Go back to this schedule's page on Cancel (the form was opened from it). */
  returnTo?: string;
}

const TEMPLATE_ICONS: Record<string, ReactNode> = {
  "template-morning-brief": <SunriseIcon />,
  "template-dependency-pr": <GitPullRequestIcon />,
  "template-cost-anomaly": <TrendingUpIcon />,
};

/**
 * Resource rows name the owner only on someone else's schedule, so the one
 * that behaves differently (you can't edit or run it) stands out.
 */
const COLUMNS: RowListColumn[] = [
  { id: "next", label: "Next run", width: 112 },
  { id: "last", label: "Last run", width: 148 },
  { id: "owner", label: "Owner", width: 96 },
];

/** Tables fill every cell, so the owner column says "You" on yours. */
const TABLE_COLUMNS: RowListColumn[] = [
  { id: "next", label: "Next run", width: 128 },
  { id: "last", label: "Last run", width: 164 },
  { id: "owner", label: "Owner", width: 104 },
];

/** The owner column only exists when someone else owns one of the schedules. */
function columnsFor(picks: SchedulePicks, items: readonly ScheduleItem[]): RowListColumn[] {
  const columns = picks.rowList === "table" ? TABLE_COLUMNS : COLUMNS;
  const shared = items.some((item) => !personById(item.ownerId).isYou);
  return shared ? columns : columns.filter((column) => column.id !== "owner");
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ----------------------------------------------------------------------------
   Row cells.
   -------------------------------------------------------------------------- */

function NextRunCell({ item }: { item: ScheduleItem }) {
  const next = nextRunOf(item);
  if (item.state === "paused") return <span className="text-fg-subtle">Paused</span>;
  if (!next) return <span className="text-fg-subtle">No runs left</span>;
  return <RelativeTime date={next} format="absolute" {...TIME} />;
}

/** Table cells are 14px once the columns show; the dot badge matches them there. */
const TABLE_BADGE = "@[640px]/list:text-sm @[640px]/list:leading-5";

function LastRunCell({ item, running }: { item: ScheduleItem; running: boolean }) {
  const table = useRowListVariant() === "table";
  const badgeClass = table ? TABLE_BADGE : undefined;
  if (running) return <StatusBadge variant="dot" status="running" className={badgeClass} />;
  const { lastRun } = item;
  if (lastRun.status === "never" || !lastRun.at) {
    return <span className="text-fg-subtle">Never run</span>;
  }
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1">
      <StatusBadge
        variant="dot"
        status={lastRun.status === "failed" ? "failed" : "succeeded"}
        className={cn(lastRun.status === "failed" && "text-danger", badgeClass)}
      />
      <RelativeTime date={lastRun.at} inSentence {...TIME} />
    </span>
  );
}

/** Someone else's name and avatar ("You" in tables, where every cell is filled). */
function OwnerCell({ ownerId }: { ownerId: string }) {
  const owner = personById(ownerId);
  if (owner.isYou) return <span className="text-fg-subtle">You</span>;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle">
      <Avatar className="size-5">
        <AvatarFallback className="bg-surface-3 text-2xs font-semibold text-fg-muted">
          {owner.initials}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate">{owner.name}</span>
    </span>
  );
}

/* ----------------------------------------------------------------------------
   The app.
   -------------------------------------------------------------------------- */

export interface SchedulesAppProps {
  dataState?: SchedulesDataState;
  questions: SchedulesQuestions;
  /** False: this server has no managed sandboxes and no machine is connected. */
  canRunSchedules?: boolean;
  /** Saving the form fails with a server error. */
  saveFails?: boolean;
  /** Open the form when the preview first renders (the form page preview). */
  initialForm?: InitialForm;
  /** Open this schedule's page when the preview first renders. */
  initialDetailId?: string;
}

export function SchedulesApp({
  dataState = "ready",
  questions,
  canRunSchedules = true,
  saveFails = false,
  initialForm,
  initialDetailId,
}: SchedulesAppProps) {
  const picks = useSchedulePicks();
  const [load, setLoad] = useState<SchedulesDataState>(dataState);
  const [items, setItems] = useState<ScheduleItem[]>(() =>
    dataState === "empty" ? [] : initialItems(),
  );
  const [form, setForm] = useState<FormState | null>(() => {
    if (!initialForm) return null;
    if (initialForm.mode === "create") {
      return { mode: "create", initial: emptyDraft(questions) };
    }
    if (initialForm.mode === "template") {
      return {
        mode: "create",
        initial: draftFromTemplate(initialForm.templateId, questions),
      };
    }
    const item = initialItems().find((each) => each.id === initialForm.id);
    return item ? { mode: "edit", editingId: item.id, initial: draftOf(item) } : null;
  });
  const [detailId, setDetailId] = useState<string | null>(initialDetailId ?? null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
  const [savingActive, setSavingActive] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  const later = useCallback((ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, ms);
    timers.current.add(timer);
  }, []);

  const sorted = useMemo(() => sortItems(items), [items]);
  const byId = useCallback((id: string | null) => items.find((item) => item.id === id), [items]);
  const detailItem = byId(detailId);
  const deleteItem = byId(deleteId);
  const renameItem = byId(renameId);

  const updateItem = useCallback((id: string, patch: Partial<ScheduleItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  /* ---------------------------------------------------------------- actions */

  const setActive = useCallback(
    (item: ScheduleItem, active: boolean, options: { viaSwitch?: boolean } = {}) => {
      const apply = () => {
        updateItem(item.id, { state: active ? "active" : "paused" });
        if (active) {
          const next = nextRunOf({ ...item, state: "active" });
          toast.success(`Resumed ${item.name}`, {
            description: next ? `Next run ${runTimeLabel(next)}.` : undefined,
          });
        } else {
          showUndoToast({
            title: `Paused ${item.name}`,
            description: "It won't run until you resume it.",
            icon: <PauseIcon />,
            onUndo: () => updateItem(item.id, { state: "active" }),
          });
        }
      };
      if (!options.viaSwitch) {
        apply();
        return;
      }
      setSavingActive(item.id);
      later(450, () => {
        setSavingActive(null);
        apply();
      });
    },
    [later, updateItem],
  );

  const runNow = useCallback(
    (item: ScheduleItem) => {
      setRunning((current) => new Set(current).add(item.id));
      toast(`Started ${item.name}`, { description: "The run's chat shows up in Agents." });
      later(3200, () => {
        setRunning((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
        const run: ScheduleRun = {
          id: `${item.id}-run-${Date.now()}`,
          status: "succeeded",
          statusLabel: "Succeeded",
          startedAt: KIT_NOW.toISOString(),
          startedLabel: "Just now",
          durationLabel: "3 s",
          triggerLabel: "Run now by you",
          outcome: "Finished. Open the chat to see what it found.",
        };
        setItems((current) =>
          current.map((each) =>
            each.id === item.id
              ? {
                  ...each,
                  runs: [run, ...each.runs],
                  lastRun: { status: "succeeded", at: KIT_NOW.toISOString() },
                }
              : each,
          ),
        );
      });
    },
    [later],
  );

  const openCreate = useCallback((initial: ScheduleDraft) => {
    setDetailId(null);
    setForm({ mode: "create", initial });
  }, []);

  const openEdit = useCallback((item: ScheduleItem, fromDetail: boolean) => {
    setDetailId(null);
    setForm({
      mode: "edit",
      editingId: item.id,
      initial: draftOf(item),
      returnTo: fromDetail ? item.id : undefined,
    });
  }, []);

  /** Cancel: back to where the form was opened from. */
  const cancelForm = useCallback(() => {
    const returnTo = form?.returnTo;
    setForm(null);
    if (returnTo) setDetailId(returnTo);
  }, [form?.returnTo]);

  /** Saved: the schedule's own page. */
  const savedId = useRef<string | null>(null);
  const finishForm = useCallback(() => {
    setForm(null);
    setDetailId(savedId.current);
    savedId.current = null;
  }, []);

  const saveForm = useCallback(
    (draft: ScheduleDraft) => {
      if (form?.mode === "edit" && form.editingId) {
        const id = form.editingId;
        updateItem(id, { ...draft, name: displayName(draft) });
        savedId.current = id;
        toast.success("Changes saved", { description: displayName(draft) });
        return;
      }
      const created = createItem(draft);
      setItems((current) => [...current, created]);
      savedId.current = created.id;
      setHighlightId(created.id);
      later(2600, () => setHighlightId((current) => (current === created.id ? null : current)));
      const next = nextRunOf(created);
      toast.success("Schedule created", {
        description: next ? `First run ${runTimeLabel(next)}.` : undefined,
        action: { label: "Run once now", onClick: () => runNow(created) },
      });
    },
    [form, later, runNow, updateItem],
  );

  const deleteNow = useCallback((item: ScheduleItem) => {
    setItems((current) => current.filter((each) => each.id !== item.id));
    setDetailId((current) => (current === item.id ? null : current));
  }, []);

  const requestDelete = useCallback(
    (item: ScheduleItem) => {
      if (picks.confirm === "undo") {
        const index = items.findIndex((each) => each.id === item.id);
        deleteNow(item);
        showUndoToast({
          title: `Deleted ${item.name}`,
          icon: <Trash2Icon />,
          onUndo: () =>
            setItems((current) => {
              const next = [...current];
              next.splice(Math.max(0, index), 0, item);
              return next;
            }),
        });
        return;
      }
      setDeleteId(item.id);
    },
    [deleteNow, items, picks.confirm],
  );

  const copyLink = useCallback((item: ScheduleItem) => {
    const url = `https://app.opengeni.ai/workspaces/design-preview/schedules?schedule=${item.id}`;
    void navigator.clipboard?.writeText(url).catch(() => undefined);
    toast("Link copied", { description: "Anyone with access to Design preview can open it." });
  }, []);

  const detailProps = useCallback(
    (item: ScheduleItem): ScheduleDetailProps => ({
      item,
      perms: permissionsFor(item, questions),
      questions,
      picks,
      running: running.has(item.id),
      savingActive: savingActive === item.id,
      onActiveChange: (active) => setActive(item, active, { viaSwitch: true }),
      onRunNow: () => runNow(item),
      onEdit: () => openEdit(item, true),
      onDuplicate: () => openCreate(duplicateDraft(item)),
      onRename: () => setRenameId(item.id),
      onCopyLink: () => copyLink(item),
      onDelete: () => requestDelete(item),
      onOpenRun: (run) =>
        toast("Opens the chat for this run", {
          description: `${run.statusLabel} · ${run.startedLabel}. Chats aren't part of this preview.`,
        }),
      onOpenVariableSet: (name) =>
        toast(`Opens ${name}`, { description: "Variable sets has its own page preview." }),
    }),
    [
      copyLink,
      openCreate,
      openEdit,
      picks,
      questions,
      requestDelete,
      runNow,
      running,
      savingActive,
      setActive,
    ],
  );

  const retry = () => {
    setLoad("loading");
    later(900, () => setLoad("ready"));
  };

  /* ---------------------------------------------------------------- views */

  const editing = form?.editingId ? byId(form.editingId) : undefined;
  const viewKey = form
    ? `form-${form.mode}-${form.editingId ?? "new"}`
    : detailItem
      ? `detail-${detailItem.id}`
      : "list";

  let view: ReactNode;
  if (form) {
    view = (
      <ScheduleForm
        key={viewKey}
        mode={form.mode}
        initial={form.initial}
        // From the schedule's page the back link already names it.
        editingName={form.returnTo ? undefined : editing?.name}
        backLabel={form.returnTo && editing ? editing.name : "Schedules"}
        questions={questions}
        picks={picks}
        canRunSchedules={canRunSchedules}
        saveFails={saveFails}
        onCancel={cancelForm}
        onSave={saveForm}
        onDone={finishForm}
        className="-mx-4 -mt-6 -mb-16 sm:-mx-6 lg:-mx-8"
      />
    );
  } else if (detailItem) {
    view = <SchedulePage props={detailProps(detailItem)} onBack={() => setDetailId(null)} />;
  } else {
    view = (
      <ListPage
        load={load}
        items={sorted}
        picks={picks}
        questions={questions}
        running={running}
        highlightId={highlightId}
        onNew={() => openCreate(emptyDraft(questions))}
        onTemplate={(templateId) => openCreate(draftFromTemplate(templateId, questions))}
        onOpen={(item) => setDetailId(item.id)}
        onSetActive={(item, active) => setActive(item, active)}
        onRunNow={runNow}
        onEdit={(item) => openEdit(item, false)}
        onDuplicate={(item) => openCreate(duplicateDraft(item))}
        onDelete={requestDelete}
        onRetry={retry}
      />
    );
  }

  return (
    <AppFrame
      itemSize={picks.navItemSize}
      viewKey={viewKey}
      onNavigate={(id) => {
        if (id !== "schedules") return;
        setForm(null);
        setDetailId(null);
      }}
    >
      {view}

      <FrameOverlay
        open={Boolean(renameItem)}
        onClose={() => setRenameId(null)}
        label={renameItem ? `Rename ${renameItem.name}` : undefined}
        focus="field"
      >
        {renameItem ? (
          <RenameDialog
            item={renameItem}
            onClose={() => setRenameId(null)}
            onRenamed={(name) => {
              updateItem(renameItem.id, { name });
              toast.success("Renamed", { description: name });
            }}
          />
        ) : null}
      </FrameOverlay>

      <FrameOverlay
        open={Boolean(deleteItem)}
        onClose={() => setDeleteId(null)}
        label={deleteItem ? `Delete ${deleteItem.name}?` : undefined}
      >
        {deleteItem ? (
          <DeleteConfirm
            item={deleteItem}
            picks={picks}
            onClose={() => setDeleteId(null)}
            onDeleted={() => {
              deleteNow(deleteItem);
              toast(`Deleted ${deleteItem.name}`);
            }}
          />
        ) : null}
      </FrameOverlay>
    </AppFrame>
  );
}

/* ----------------------------------------------------------------------------
   Rename: a one-field prompt, so a small centered dialog rather than a page.
   -------------------------------------------------------------------------- */

function RenameDialog({
  item,
  onClose,
  onRenamed,
}: {
  item: ScheduleItem;
  onClose: () => void;
  onRenamed: (name: string) => void;
}) {
  const [name, setName] = useState(item.name);
  const [error, setError] = useState<string | undefined>();
  return (
    <FormFrame
      variant="dialog"
      title="Rename schedule"
      submitLabel="Rename"
      pendingLabel="Renaming…"
      onCancel={onClose}
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          setError("Enter a name.");
          return false;
        }
        if (trimmed.length > 80) {
          setError("Keep the name under 80 characters.");
          return false;
        }
        await wait(400);
        onRenamed(trimmed);
        return true;
      }}
      onSubmitted={onClose}
      className="max-w-none @max-[639px]/frame:rounded-b-none @max-[639px]/frame:border-b-0"
    >
      <FieldStack>
        <Field
          label="Name"
          error={error}
          hint="Shown in the list and as the title of each run's chat."
        >
          <TextInput
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError(undefined);
            }}
            suppressAutofill
          />
        </Field>
      </FieldStack>
    </FormFrame>
  );
}

/* ----------------------------------------------------------------------------
   Delete confirm.
   -------------------------------------------------------------------------- */

function DeleteConfirm({
  item,
  picks,
  onClose,
  onDeleted,
}: {
  item: ScheduleItem;
  picks: SchedulePicks;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const next = nextRunOf(item);
  return (
    <DestructiveConfirmPanel
      variant={picks.confirm === "type-to-confirm" ? "type-to-confirm" : "consequences"}
      title={`Delete ${item.name}?`}
      consequences={[
        next ? `It stops running. The next run was ${runTimeLabel(next)}.` : "It won't run again.",
        "Chats from earlier runs stay in Agents.",
        "This can't be undone. Pause it instead to keep it for later.",
      ]}
      confirmText={item.name}
      confirmLabel="Delete schedule"
      pendingLabel="Deleting…"
      onConfirm={async () => {
        await wait(600);
        onDeleted();
      }}
      onClose={onClose}
      className="max-w-none @max-[639px]/frame:rounded-b-none @max-[639px]/frame:border-b-0"
    />
  );
}

/* ----------------------------------------------------------------------------
   The list page.
   -------------------------------------------------------------------------- */

interface ListPageProps {
  load: SchedulesDataState;
  items: ScheduleItem[];
  picks: SchedulePicks;
  questions: SchedulesQuestions;
  running: ReadonlySet<string>;
  highlightId: string | null;
  onNew: () => void;
  onTemplate: (templateId: string) => void;
  onOpen: (item: ScheduleItem) => void;
  onSetActive: (item: ScheduleItem, active: boolean) => void;
  onRunNow: (item: ScheduleItem) => void;
  onEdit: (item: ScheduleItem) => void;
  onDuplicate: (item: ScheduleItem) => void;
  onDelete: (item: ScheduleItem) => void;
  onRetry: () => void;
}

function ListPage(props: ListPageProps) {
  const { load, items, picks } = props;
  const empty = load === "empty" || (load === "ready" && items.length === 0);
  const showHeaderAction = !empty;
  return (
    <PageHeaderStyleProvider variant={picks.headerVariant} icon={picks.headerIcon}>
      <PageHeader
        icon={<CalendarClockIcon />}
        title="Schedules"
        description="Recurring agent work in this workspace."
        actions={
          showHeaderAction ? (
            <Button type="button" onClick={props.onNew} className="pointer-coarse:h-11">
              <PlusIcon aria-hidden="true" />
              New schedule
            </Button>
          ) : undefined
        }
      />
      <div className="mt-6 min-w-0">
        {load === "loading" ? (
          <RowList
            label="Schedules"
            variant={picks.rowList}
            columns={columnsFor(picks, items)}
            busy
          >
            <ListRowSkeleton count={4} />
          </RowList>
        ) : load === "error" ? (
          <ErrorMessage
            align="center"
            title="Couldn't load schedules"
            reference="req_7f3a9c2e41b8"
            action={
              <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
                Try again
              </Button>
            }
          >
            Check your connection, then try again. Your schedules keep running either way.
          </ErrorMessage>
        ) : empty ? (
          <SchedulesEmpty picks={picks} onNew={props.onNew} onTemplate={props.onTemplate} />
        ) : (
          <ScheduleList {...props} />
        )}
      </div>
    </PageHeaderStyleProvider>
  );
}

function SchedulesEmpty({
  picks,
  onNew,
  onTemplate,
}: {
  picks: SchedulePicks;
  onNew: () => void;
  onTemplate: (templateId: string) => void;
}) {
  if (picks.emptyState === "inline") {
    return (
      <EmptyState
        variant="inline"
        title="No schedules yet."
        description="Have the agent do something on a rhythm, like a morning brief."
        action={<EmptyStateLink onClick={onNew}>New schedule</EmptyStateLink>}
      />
    );
  }
  return (
    <EmptyState
      variant="page"
      icon={<CalendarClockIcon />}
      title="No schedules yet"
      description="Have the agent do something on a rhythm, like a morning brief or a weekly dependency PR."
      action={
        <Button type="button" onClick={onNew} className="pointer-coarse:h-11">
          <PlusIcon aria-hidden="true" />
          New schedule
        </Button>
      }
      className="pt-12"
      templates={
        <EmptyStateTemplates>
          {scheduleTemplates.map((template) => (
            <EmptyStateTemplate
              key={template.id}
              icon={TEMPLATE_ICONS[template.id]}
              title={template.name}
              description={template.description}
              meta={template.cadenceLabel}
              onSelect={() => onTemplate(template.id)}
            />
          ))}
        </EmptyStateTemplates>
      }
    />
  );
}

function RowMenu({ item, props }: { item: ScheduleItem; props: ListPageProps }) {
  const perms = permissionsFor(item, props.questions);
  const paused = item.state === "paused";
  return (
    <>
      {perms.own ? null : (
        <>
          <DropdownMenuLabel className="max-w-64 px-2 py-1.5 text-xs leading-4.5 font-normal text-fg-muted">
            {perms.ownerName} owns this schedule. Only {perms.ownerFirstName} can{" "}
            {perms.canPauseOrDelete ? "edit or run it." : "change or run it."}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem
        disabled={!perms.canEditOrRun || props.running.has(item.id)}
        onSelect={() => props.onRunNow(item)}
      >
        <PlayIcon />
        Run now
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!perms.canPauseOrDelete}
        onSelect={() => props.onSetActive(item, paused)}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
        {paused ? "Resume" : "Pause"}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!perms.canEditOrRun} onSelect={() => props.onEdit(item)}>
        <PencilIcon />
        Edit
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => props.onDuplicate(item)}>
        <CopyIcon />
        Duplicate
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        disabled={!perms.canPauseOrDelete}
        onSelect={() => props.onDelete(item)}
      >
        <Trash2Icon />
        Delete
      </DropdownMenuItem>
    </>
  );
}

function ScheduleRows({ items, props }: { items: ScheduleItem[]; props: ListPageProps }) {
  return items.map((item) => {
    const paused = item.state === "paused";
    const perms = permissionsFor(item, props.questions);
    const isRunning = props.running.has(item.id);
    return (
      <ListRow
        key={item.id}
        leading={<LogoTile icon={paused ? <PauseIcon /> : <CalendarClockIcon />} />}
        title={paused ? <span className="text-fg-muted">{item.name}</span> : item.name}
        description={cadenceShort(item.cadence)}
        cells={{
          next: <NextRunCell item={item} />,
          last: <LastRunCell item={item} running={isRunning} />,
          // Resource rows leave the cell empty on your own schedules.
          owner:
            personById(item.ownerId).isYou && props.picks.rowList !== "table" ? undefined : (
              <OwnerCell ownerId={item.ownerId} />
            ),
        }}
        control={
          paused && perms.canPauseOrDelete ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => props.onSetActive(item, true)}
              aria-label={`Resume ${item.name}`}
              className="h-7 rounded-[10px] px-2 pointer-coarse:h-11"
            >
              <PlayIcon aria-hidden="true" />
              Resume
            </Button>
          ) : null
        }
        menu={<RowMenu item={item} props={props} />}
        menuLabel={`More actions for ${item.name}`}
        onOpen={() => props.onOpen(item)}
        selected={props.highlightId === item.id}
      />
    );
  });
}

function ScheduleList(props: ListPageProps) {
  const { items, picks, questions } = props;
  if (questions.q25OneList) {
    return (
      <RowList label="Schedules" variant={picks.rowList} columns={columnsFor(picks, items)}>
        <ScheduleRows items={items} props={props} />
      </RowList>
    );
  }
  // Today's shape (Q25 answered No): paused schedules behind a closed section.
  const active = items.filter((item) => item.state === "active");
  const paused = items.filter((item) => item.state === "paused");
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {active.length > 0 ? (
        <RowList
          label="Active schedules"
          variant={picks.rowList}
          columns={columnsFor(picks, items)}
        >
          <ScheduleRows items={active} props={props} />
        </RowList>
      ) : (
        <EmptyState
          variant="inline"
          title="Nothing is scheduled to run right now."
          description="Resume a paused schedule, or create a new one."
        />
      )}
      {paused.length > 0 ? (
        <Disclosure
          variant={picks.disclosure === "inline" ? "inline" : "row"}
          title="Paused"
          summary={`${paused.length} ${paused.length === 1 ? "schedule" : "schedules"} · ${paused.map((item) => item.name).join(", ")}`}
        >
          <RowList
            label="Paused schedules"
            variant={picks.rowList}
            columns={columnsFor(picks, items)}
          >
            <ScheduleRows items={paused} props={props} />
          </RowList>
        </Disclosure>
      ) : null}
    </div>
  );
}
