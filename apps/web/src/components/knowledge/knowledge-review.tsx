import type {
  AgentInstructionReviewItem,
  KnowledgeEntryRecord,
  KnowledgeEntrySummary,
  KnowledgeReviewBatch,
  SkillRecord,
  SkillSummary,
} from "@opengeni/sdk";
import {
  ArrowUpRightIcon,
  BookOpenIcon,
  CheckCheckIcon,
  InboxIcon,
  ScrollTextIcon,
  WandSparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { notifyKnowledgeReviewUpdated } from "@/components/rail/use-knowledge-review-indicator";
import { Button } from "@/components/ui/button";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { DetailPage, DetailPageBody, DetailPageHeader } from "@/components/ui/detail-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import { DiffView } from "@/components/ui/diff-view";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, TextArea, TextInput } from "@/components/ui/field";
import { InAppHelpLink } from "@/components/in-app-help-link";
import { InlineHelp } from "@/components/ui/inline-help";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { inAppClick } from "@/lib/in-app-click";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ToolbarSummary } from "@/components/ui/toolbar";
import { useAppContext } from "@/context";
import { canManageWorkspaceSettings, hasAccountPermission } from "@/lib/permissions";

import { errorText } from "./knowledge-data";
import { Markdown } from "./knowledge-markdown";
import { KNOWLEDGE_KIND_LABEL, KNOWLEDGE_SCOPE_LABEL } from "./knowledge-labels";
import { firstReviewableEntry } from "./knowledge-review-order";

/* ----------------------------------------------------------------------------
   Review: changes agents proposed while Learning is set to Review first.
   One flat list, one row per change (what it is, where it came from, when).
   A row opens the change's own page: the proposal as it reads, where it came
   from, and one action row (Reject, Edit, Approve and next). Approving moves
   straight on to the next change; after the last one you are back on the
   list.
   -------------------------------------------------------------------------- */

type ReviewKind = "knowledge" | "instruction" | "skill";

const KIND_ICON: Record<ReviewKind, LucideIcon> = {
  knowledge: BookOpenIcon,
  instruction: ScrollTextIcon,
  skill: WandSparklesIcon,
};

const KIND_LABEL: Record<ReviewKind, string> = {
  knowledge: "Knowledge",
  instruction: "Instructions",
  skill: "Skill",
};

type Origin =
  | { kind: "chat"; name: string; sessionId: string; unnamed?: boolean }
  | { kind: "schedule"; name: string; taskId: string }
  | { kind: "none"; name: string };

export type ReviewItem =
  | {
      kind: "knowledge";
      key: string;
      title: string;
      createdAt: string;
      origin: Origin;
      batch: KnowledgeReviewBatch;
      entry: KnowledgeEntrySummary;
    }
  | {
      kind: "instruction";
      key: string;
      title: string;
      createdAt: string;
      origin: Origin;
      item: AgentInstructionReviewItem;
    }
  | {
      kind: "skill";
      key: string;
      title: string;
      createdAt: string | null;
      origin: Origin;
      skill: SkillSummary;
    };

/** The exact proposal a decision was made on, so a newer one is not hidden. */
function reviewItemRevision(item: ReviewItem): string {
  if (item.kind === "knowledge") return item.entry.revision.id;
  if (item.kind === "instruction") return item.item.revisionId;
  return item.skill.pendingRevisionIds.join(",");
}

function hiddenId(key: string, revision: string): string {
  return `${key}\u0000${revision}`;
}

interface ReviewGroup {
  key: string;
  origin: Origin;
  batch?: KnowledgeReviewBatch;
  items: ReviewItem[];
}

function batchOrigin(batch: KnowledgeReviewBatch): Origin {
  if (batch.scheduledTaskId)
    return { kind: "schedule", name: batch.title ?? "A schedule", taskId: batch.scheduledTaskId };
  if (batch.sessionId)
    return { kind: "chat", name: batch.title ?? "A chat", sessionId: batch.sessionId };
  return { kind: "none", name: batch.title ?? "Earlier changes" };
}

/* ------------------------------------------------------------------ queue */

export interface ReviewQueue {
  items: ReviewItem[];
  groups: ReviewGroup[];
  count: number;
  /** More than one page of something is waiting. */
  partial: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Everything waiting for this viewer's OK, loaded once for the tab count and the tab. */
export function useReviewQueue(workspaceId: string, refresh: number): ReviewQueue {
  const context = useAppContext();
  const workspace = context.workspaces.find((each) => each.id === workspaceId) ?? null;
  const canManage = canManageWorkspaceSettings(
    context.accessContext,
    workspace,
    context.managedSelfContext,
  );
  const canManageOrganization = workspace
    ? hasAccountPermission(context.accessContext, workspace.accountId, "account:admin")
    : false;
  const [state, setState] = useState<{
    items: ReviewItem[];
    partial: boolean;
    error: string | null;
  } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let current = true;
    const { client } = context;
    void (async () => {
      const failures: string[] = [];
      let partial = false;
      const items: ReviewItem[] = [];
      const [batches, instructions, skills] = await Promise.allSettled([
        client.listKnowledgeReviewBatches(workspaceId, { limit: 20 }),
        canManage
          ? client.listAgentInstructionReviews(workspaceId)
          : Promise.resolve({ entries: [], nextCursor: null }),
        client.listWorkspaceSkills(workspaceId, { limit: 100 }),
      ]);
      if (batches.status === "fulfilled") {
        partial ||= Boolean(batches.value.nextCursor);
        const pages = await Promise.allSettled(
          batches.value.batches.map((batch) =>
            client.listKnowledgeEntries(workspaceId, {
              view: "needs_review",
              reviewBatchId: batch.id,
              limit: 50,
            }),
          ),
        );
        pages.forEach((page, index) => {
          const batch = batches.value.batches[index]!;
          if (page.status === "rejected") {
            failures.push(errorText(page.reason));
            return;
          }
          partial ||= Boolean(page.value.nextCursor);
          for (const entry of page.value.entries) {
            items.push({
              kind: "knowledge",
              key: `knowledge:${entry.id}`,
              title: entry.revision.title,
              createdAt: entry.revision.createdAt,
              origin: batchOrigin(batch),
              batch,
              entry,
            });
          }
        });
      } else failures.push(errorText(batches.reason));
      if (instructions.status === "fulfilled") {
        partial ||= Boolean(instructions.value.nextCursor);
        for (const item of instructions.value.entries) {
          items.push({
            kind: "instruction",
            key: `instruction:${item.revisionId}`,
            title: "Workspace instructions",
            createdAt: item.createdAt,
            origin: item.sessionId
              ? { kind: "chat", name: "a chat", sessionId: item.sessionId, unnamed: true }
              : { kind: "none", name: "Instruction changes" },
            item,
          });
        }
      } else failures.push(errorText(instructions.reason));
      if (skills.status === "fulfilled") {
        partial ||= Boolean(skills.value.nextCursor);
        for (const skill of skills.value.skills) {
          const allowed =
            skill.scope === "user" ||
            (skill.scope === "organization" ? canManageOrganization : canManage);
          if (!skill.pendingRevisionIds.length || !allowed) continue;
          items.push({
            kind: "skill",
            key: `skill:${skill.id}`,
            title: skill.title ?? skill.stableKey,
            createdAt: null,
            origin: { kind: "none", name: "Skills" },
            skill,
          });
        }
      } else failures.push(errorText(skills.reason));
      if (current) setState({ items, partial, error: failures.length ? failures[0]! : null });
    })();
    return () => {
      current = false;
    };
  }, [context, workspaceId, canManage, canManageOrganization, refresh, retry]);

  const groups = useMemo(() => {
    const result: ReviewGroup[] = [];
    for (const item of state?.items ?? []) {
      const key =
        item.kind === "knowledge"
          ? `batch:${item.batch.id}`
          : item.origin.kind === "chat"
            ? `chat:${item.origin.sessionId}`
            : `${item.kind}`;
      const group = result.find((each) => each.key === key);
      if (group) group.items.push(item);
      else
        result.push({
          key,
          origin: item.origin,
          ...(item.kind === "knowledge" ? { batch: item.batch } : {}),
          items: [item],
        });
    }
    return result;
  }, [state]);
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  return {
    items,
    groups,
    count: items.length,
    partial: state?.partial ?? false,
    loading: state === null,
    error: state?.error ?? null,
    reload: useCallback(() => setRetry((value) => value + 1), []),
  };
}

/* ------------------------------------------------------------------ flow */

export interface ReviewFlow {
  /** What still waits: the queue without the changes decided here. */
  items: ReviewItem[];
  /** The change whose page is open, or null. */
  selected: ReviewItem | null;
  /** A change was approved or rejected: hide it and move on if it was open. */
  decided: (item: ReviewItem) => void;
  /** Several at once (Approve all from one chat). */
  decidedMany: (items: ReviewItem[]) => void;
  /** A change another one depends on was decided from that change's page. */
  prerequisiteDone: (entryId: string, revisionId: string) => void;
}

/**
 * Which change is open and what has been decided. Decided changes stay hidden
 * until a refetch no longer lists that exact revision: a refetch that started
 * before the decision still carries it and must not bring it back, while a
 * renewed proposal (a new revision) shows again.
 */
export function useReviewFlow({
  queue,
  openKey,
  open,
  onChanged,
}: {
  queue: ReviewQueue;
  /** The open change's key, from the URL or local state. */
  openKey: string | null;
  /** Open a change's page (a key) or go back to the list (null). */
  open: (key: string | null, options: { replace: boolean }) => void;
  onChanged: () => void;
}): ReviewFlow {
  const [hidden, setHidden] = useState<ReadonlyMap<string, string>>(new Map());
  // The page being left after a decision stays on screen until the next one
  // opens, so moving on never flashes "already reviewed".
  const [leaving, setLeaving] = useState<string | null>(null);
  const items = useMemo(
    () => queue.items.filter((item) => hidden.get(item.key) !== reviewItemRevision(item)),
    [queue.items, hidden],
  );
  useEffect(
    () =>
      setHidden((prior) => {
        const listed = new Set(
          queue.items.map((item) => hiddenId(item.key, reviewItemRevision(item))),
        );
        const next = new Map(
          [...prior].filter(([key, revision]) => listed.has(hiddenId(key, revision))),
        );
        return next.size === prior.size ? prior : next;
      }),
    [queue.items],
  );
  useEffect(() => {
    if (leaving && openKey !== leaving) setLeaving(null);
  }, [openKey, leaving]);

  const latest = useRef({ items, openKey, open, onChanged });
  latest.current = { items, openKey, open, onChanged };

  const decidedMany = useCallback((decided: ReviewItem[]) => {
    const { items: list, openKey: current, open: go, onChanged: changed } = latest.current;
    const keys = new Set(decided.map((item) => item.key));
    setHidden((prior) => {
      const next = new Map(prior);
      for (const item of decided) next.set(item.key, reviewItemRevision(item));
      return next;
    });
    // Only a decision on the change that is open moves the reviewer on: one
    // that completes after they opened another change leaves them there.
    if (current && keys.has(current)) {
      const index = list.findIndex((item) => item.key === current);
      const following =
        list.slice(index + 1).find((item) => !keys.has(item.key)) ??
        list
          .slice(0, Math.max(index, 0))
          .reverse()
          .find((item) => !keys.has(item.key)) ??
        null;
      setLeaving(current);
      go(following?.key ?? null, { replace: true });
    }
    notifyKnowledgeReviewUpdated();
    changed();
  }, []);
  const decided = useCallback((item: ReviewItem) => decidedMany([item]), [decidedMany]);
  const prerequisiteDone = useCallback((entryId: string, revisionId: string) => {
    setHidden((prior) => new Map(prior).set(`knowledge:${entryId}`, revisionId));
    latest.current.onChanged();
  }, []);

  const selected = openKey
    ? (items.find((item) => item.key === openKey) ??
      (openKey === leaving ? (queue.items.find((item) => item.key === openKey) ?? null) : null))
    : null;
  return { items, selected, decided, decidedMany, prerequisiteDone };
}

/* ------------------------------------------------------------------ list */

const WHEN_COLUMNS: RowListColumn[] = [
  { id: "when", label: "Proposed", width: 112, align: "end", hideLabel: true },
];

/** The type in words: "Requirement" for knowledge, "Instructions", "Skill". */
function reviewTypeLabel(item: ReviewItem): string {
  return item.kind === "knowledge"
    ? KNOWLEDGE_KIND_LABEL[item.entry.revision.kind]
    : KIND_LABEL[item.kind];
}

/** "From chat Migrate billing…", as plain text for a row. */
function originText(origin: Origin): string | null {
  if (origin.kind === "chat") return origin.unnamed ? "From a chat" : `From chat ${origin.name}`;
  if (origin.kind === "schedule") return `From schedule ${origin.name}`;
  return null;
}

function ReviewTile({ kind }: { kind: ReviewKind }) {
  const Icon = KIND_ICON[kind];
  return <LogoTile icon={<Icon />} name={KIND_LABEL[kind]} />;
}

export interface ReviewListProps {
  items: ReviewItem[];
  queue: Pick<ReviewQueue, "loading" | "error" | "partial" | "reload">;
  onOpen: (item: ReviewItem) => void;
  /** A link per row, so a change can be opened in a new tab. */
  hrefFor?: (item: ReviewItem) => string;
  /** Why the list is empty, in one sentence (it depends on Learning). */
  emptyDescription: string;
  onOpenLearning?: () => void;
}

/** Every change waiting for review, one row each. */
export function ReviewList({
  items,
  queue,
  onOpen,
  hrefFor,
  emptyDescription,
  onOpenLearning,
}: ReviewListProps) {
  const retry = (
    <Button type="button" size="sm" variant="outline" onClick={queue.reload}>
      Try again
    </Button>
  );
  if (queue.loading) {
    return (
      <RowList label="Changes waiting for review" columns={WHEN_COLUMNS} flush busy>
        <ListRowSkeleton count={3} />
      </RowList>
    );
  }
  if (queue.error && !items.length) {
    return (
      <Notice
        tone="failed"
        title="Couldn't load the changes waiting for review"
        action={retry}
        actionLayout="responsive"
      >
        {queue.error}
      </Notice>
    );
  }
  if (!items.length) {
    return (
      <EmptyState
        variant="page"
        icon={<InboxIcon />}
        title="You're all caught up"
        description={emptyDescription}
        action={
          onOpenLearning ? (
            <Button
              type="button"
              variant="outline"
              onClick={onOpenLearning}
              className="pointer-coarse:h-11"
            >
              Learning settings
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {queue.error ? (
        <Notice
          tone="failed"
          title="Some changes couldn't be loaded"
          action={retry}
          actionLayout="responsive"
        >
          {queue.error}
        </Notice>
      ) : null}
      <RowList label="Changes waiting for review" columns={WHEN_COLUMNS} flush>
        {items.map((item) => {
          const href = hrefFor?.(item);
          const archive = item.kind === "knowledge" && item.entry.revision.change === "archive";
          return (
            <ListRow
              key={item.key}
              leading={<ReviewTile kind={item.kind} />}
              title={item.title}
              meta={[reviewTypeLabel(item), originText(item.origin)].filter(
                (part): part is string => Boolean(part),
              )}
              status={
                archive ? (
                  <StatusBadge variant="dot" tone="neutral">
                    Archive request
                  </StatusBadge>
                ) : undefined
              }
              cells={item.createdAt ? { when: <RelativeTime date={item.createdAt} /> } : {}}
              indicator="open"
              {...(href
                ? {
                    href,
                    linkProps: {
                      onClick: inAppClick(() => onOpen(item)),
                    },
                  }
                : { onOpen: () => onOpen(item) })}
            />
          );
        })}
      </RowList>
      {queue.partial ? (
        <ToolbarSummary>
          More changes are waiting. They show up here as you work through these.
        </ToolbarSummary>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ tab */

export interface ReviewTabProps {
  workspaceId: string;
  queue: ReviewQueue;
  emptyDescription: string;
  onOpenLearning?: () => void;
  onOpenEntry: (id: string) => void;
  onChanged: () => void;
}

/**
 * The list and each change's page in one place, with the open change kept in
 * local state. The Knowledge page keeps it in the URL instead and draws the
 * page itself; this is the same flow for embedding and tests.
 */
export function ReviewTab({
  workspaceId,
  queue,
  emptyDescription,
  onOpenLearning,
  onOpenEntry,
  onChanged,
}: ReviewTabProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const flow = useReviewFlow({
    queue,
    openKey,
    open: (key) => setOpenKey(key),
    onChanged,
  });
  if (openKey) {
    return (
      <ReviewItemPage
        workspaceId={workspaceId}
        flow={flow}
        loading={queue.loading}
        onBack={() => setOpenKey(null)}
        onOpenEntry={onOpenEntry}
      />
    );
  }
  return (
    <ReviewList
      items={flow.items}
      queue={queue}
      onOpen={(item) => setOpenKey(item.key)}
      emptyDescription={emptyDescription}
      {...(onOpenLearning ? { onOpenLearning } : {})}
    />
  );
}

/* --------------------------------------------------------------- page */

export interface ReviewItemPageProps {
  workspaceId: string;
  flow: ReviewFlow;
  /** The queue is still loading, so a missing change may yet appear. */
  loading: boolean;
  onBack: () => void;
  onOpenEntry: (id: string) => void;
}

/** One change waiting for review, on its own page with a back link to the list. */
export function ReviewItemPage({
  workspaceId,
  flow,
  loading,
  onBack,
  onOpenEntry,
}: ReviewItemPageProps) {
  const item = flow.selected;
  const back = { label: "Review", onClick: onBack };
  if (!item) {
    return (
      <DetailPage back={back}>
        {loading ? (
          <PageSkeleton />
        ) : (
          <EmptyState
            variant="page"
            icon={<InboxIcon />}
            title="This change isn't waiting any more"
            description="Someone may have approved or rejected it already, or the agent replaced it with a newer one."
            action={
              <Button type="button" onClick={onBack} className="pointer-coarse:h-11">
                Back to Review
              </Button>
            }
          />
        )}
      </DetailPage>
    );
  }
  const batchId = item.kind === "knowledge" ? item.batch.id : null;
  const batch = batchId
    ? flow.items.filter((each) => each.kind === "knowledge" && each.batch.id === batchId)
    : [];
  return (
    <DetailPage back={back}>
      <ReviewDetail
        key={item.key}
        workspaceId={workspaceId}
        item={item}
        remaining={flow.items.length}
        batch={batch.length > 1 ? batch : []}
        onDone={() => flow.decided(item)}
        onBatchDone={flow.decidedMany}
        onPrerequisiteDone={flow.prerequisiteDone}
        onOpenEntry={onOpenEntry}
      />
    </DetailPage>
  );
}

function PageSkeleton() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-8">
      <span role="status" className="sr-only">
        Loading the change
      </span>
      <div className="flex items-start gap-4">
        <Skeleton className="size-10 rounded-[10px] bg-surface-2" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
          <Skeleton className="h-5 w-2/5 rounded-full bg-surface-2" />
          <Skeleton className="h-3.5 w-1/3 rounded-full bg-surface-2" />
        </div>
      </div>
      <BodySkeleton />
    </div>
  );
}

function BodySkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2.5">
      {["w-4/5", "w-3/5", "w-2/3"].map((width) => (
        <Skeleton key={width} className={`h-3.5 rounded-full bg-surface-2 ${width}`} />
      ))}
    </div>
  );
}

/** "From chat <Migrate billing…>" with the chat or schedule as a link. */
function OriginLink({ workspaceId, origin }: { workspaceId: string; origin: Origin }) {
  const navigate = useNavigate();
  if (origin.kind === "none") return null;
  const href =
    origin.kind === "chat"
      ? `/workspaces/${workspaceId}/sessions/${origin.sessionId}`
      : `/workspaces/${workspaceId}/schedules?taskId=${origin.taskId}`;
  const unnamed = origin.kind === "chat" && origin.unnamed;
  const link = (
    <a
      href={href}
      onClick={inAppClick(() => void navigate({ href }))}
      className="rounded-[4px] text-fg underline decoration-fg/25 underline-offset-2 hover:decoration-fg"
    >
      {unnamed ? "a chat" : origin.name}
    </a>
  );
  return (
    <span>
      {unnamed ? "From " : origin.kind === "chat" ? "From chat " : "From schedule "}
      {link}
    </span>
  );
}

/** Knowledge text as it reads: paragraphs, line breaks kept. */
function PlainText({ text }: { text: string }) {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm leading-6 break-words text-fg">
      {paragraphs.map((paragraph, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- paragraphs of one static text
        <p key={index} className="whitespace-pre-wrap">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

type Loaded =
  | {
      kind: "knowledge";
      record: KnowledgeEntryRecord;
      before: string;
      beforeTitle: string | null;
      /** The selected change needs this one first. */
      requiredFor: string | null;
    }
  | { kind: "instruction"; before: string | null }
  | { kind: "skill"; record: SkillRecord; before: string };

function skillText(record: SkillRecord): string {
  return [...record.files]
    .sort((left, right) =>
      left.path === "SKILL.md"
        ? -1
        : right.path === "SKILL.md"
          ? 1
          : left.path.localeCompare(right.path),
    )
    .map((file) => (record.files.length > 1 ? `## ${file.path}\n${file.content}` : file.content))
    .join("\n\n");
}

type Pending = "approve" | "reject" | "all" | null;

function ReviewDetail({
  workspaceId,
  item,
  remaining,
  batch,
  onDone,
  onBatchDone,
  onPrerequisiteDone,
  onOpenEntry,
}: {
  workspaceId: string;
  item: ReviewItem;
  remaining: number;
  /** Knowledge from the same chat or schedule, when there is more than this one. */
  batch: ReviewItem[];
  onDone: () => void;
  onBatchDone: (items: ReviewItem[]) => void;
  onPrerequisiteDone: (entryId: string, revisionId: string) => void;
  onOpenEntry: (id: string) => void;
}) {
  const { client } = useAppContext();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState<Pending>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    // Set on every mount: StrictMode mounts, unmounts and mounts again.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A queue refetch hands over a new object for the same proposal; reload only
  // when the proposal itself changes, never re-read one that was just decided.
  const itemRef = useRef(item);
  itemRef.current = item;
  const itemIdentity = hiddenId(item.key, reviewItemRevision(item));
  useEffect(() => {
    let current = true;
    const proposal = itemRef.current;
    setLoaded(null);
    setLoadError(null);
    void (async (): Promise<Loaded> => {
      if (proposal.kind === "knowledge") {
        const record = await firstReviewableEntry(proposal.entry.id, (id, options) =>
          client.getKnowledgeEntry(workspaceId, id, options),
        );
        const published = record.publishedRevisionId
          ? await client
              .getKnowledgeEntry(workspaceId, record.id, { revisionId: record.publishedRevisionId })
              .catch(() => null)
          : null;
        return {
          kind: "knowledge",
          record,
          before: published?.revision.entry.content ?? "",
          beforeTitle: published?.revision.entry.title ?? null,
          requiredFor: record.id === proposal.entry.id ? null : proposal.title,
        };
      }
      if (proposal.kind === "instruction") {
        const target = proposal.item.target;
        const policies = await client.listWorkspaceInstructionPolicies(workspaceId, {
          kind: target.kind,
          scope: target.scope,
          ...(target.roleKey ? { roleKey: target.roleKey } : {}),
          limit: 1,
        });
        const head = policies.activeHeads.find(
          (candidate) =>
            candidate.kind === target.kind &&
            candidate.scope === target.scope &&
            candidate.roleKey === target.roleKey,
        );
        const baseline = head
          ? await client.getWorkspaceInstructionPolicyRevision(workspaceId, head.revisionId)
          : null;
        return { kind: "instruction", before: baseline?.content ?? null };
      }
      const record = await client.readWorkspaceSkill(
        workspaceId,
        proposal.skill.id,
        proposal.skill.pendingRevisionIds[0],
      );
      const active = proposal.skill.activeRevisionId
        ? await client
            .readWorkspaceSkill(workspaceId, proposal.skill.id, proposal.skill.activeRevisionId)
            .catch(() => null)
        : null;
      return { kind: "skill", record, before: active ? skillText(active) : "" };
    })()
      .then((value) => {
        if (current) setLoaded(value);
      })
      .catch((reason: unknown) => {
        if (current) setLoadError(errorText(reason));
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, itemIdentity, retry]);

  const act = async (
    kind: Exclude<Pending, null>,
    run: () => Promise<unknown>,
    message: string,
  ) => {
    setPending(kind);
    setActionError(null);
    try {
      await run();
      toast(message);
      if (loaded?.kind === "knowledge" && loaded.requiredFor) {
        // A prerequisite is done; the change the reviewer picked is next.
        setEditing(false);
        setRetry((value) => value + 1);
        onPrerequisiteDone(loaded.record.id, loaded.record.revision.id);
        notifyKnowledgeReviewUpdated();
      } else {
        onDone();
      }
    } catch (reason) {
      if (alive.current) setActionError(errorText(reason));
    } finally {
      if (alive.current) setPending(null);
    }
  };

  const decide = (decision: "approve" | "reject", edited?: { title: string; content: string }) => {
    if (!loaded) return;
    if (loaded.kind === "knowledge") {
      const record = loaded.record;
      void act(
        decision,
        () =>
          client.reviewKnowledgeEntry(workspaceId, {
            operationId: crypto.randomUUID(),
            entryId: record.id,
            revisionId: record.revision.id,
            expectedVersion: record.version,
            decision,
            ...(edited
              ? {
                  entry: { ...record.revision.entry, title: edited.title, content: edited.content },
                }
              : {}),
          }),
        `${decision === "approve" ? "Approved" : "Rejected"}: ${record.revision.entry.title}`,
      );
    } else if (loaded.kind === "instruction" && item.kind === "instruction") {
      void act(
        decision,
        () =>
          client.reviewAgentInstruction(workspaceId, {
            operationId: crypto.randomUUID(),
            revisionId: item.item.revisionId,
            decision,
            reason: `${decision === "approve" ? "Approved" : "Rejected"} in Knowledge review`,
          }),
        decision === "approve"
          ? "Approved. New messages use the updated instructions."
          : "Rejected the instruction change",
      );
    } else if (loaded.kind === "skill") {
      const skill = loaded.record;
      if (!skill.revisionId) return;
      const request = {
        operationId: crypto.randomUUID(),
        revisionId: skill.revisionId,
        expectedRevisionId: skill.activeRevisionId,
        expectedScopeVersion: skill.scopeVersion,
        ...(skill.removalOperationId ? { removalOperationId: skill.removalOperationId } : {}),
        reason: `${decision === "approve" ? "Approved" : "Rejected"} in Knowledge review`,
      };
      void act(
        decision,
        () =>
          decision === "approve"
            ? client.approveWorkspaceSkill(workspaceId, skill.id, request)
            : client.rejectWorkspaceSkill(workspaceId, skill.id, request),
        decision === "approve"
          ? skill.removalOperationId
            ? `Deleted the skill ${item.title}`
            : `Approved: ${item.title}. It's in Skills in Capabilities.`
          : `Rejected: ${item.title}`,
      );
    }
  };

  const approveBatch = () => {
    const entries = batch.flatMap((each) => (each.kind === "knowledge" ? [each.entry] : []));
    setPending("all");
    setActionError(null);
    void client
      .reviewKnowledgeEntries(workspaceId, {
        entries: entries.slice(0, 100).map((entry) => ({
          operationId: crypto.randomUUID(),
          entryId: entry.id,
          revisionId: entry.revision.id,
          expectedVersion: entry.version,
          decision: "approve" as const,
        })),
      })
      .then(() => {
        toast(`Approved ${entries.length} changes`);
        onBatchDone(batch);
      })
      .catch((reason: unknown) => {
        if (alive.current) setActionError(errorText(reason));
      })
      .finally(() => {
        if (alive.current) setPending(null);
      });
  };

  /* ---------------------------------------------------------- header */

  const record = loaded?.kind === "knowledge" ? loaded.record : null;
  const archiveRequest = record?.revision.change === "archive";
  const removal = loaded?.kind === "skill" && Boolean(loaded.record.removalOperationId);
  const title = record ? record.revision.entry.title : item.title;
  const busy = pending !== null;
  const canEditFirst = loaded?.kind === "knowledge" && !archiveRequest;
  const approveLabel =
    pending === "approve"
      ? removal
        ? "Deleting…"
        : "Approving…"
      : removal
        ? "Delete skill"
        : archiveRequest
          ? remaining > 1
            ? "Archive and next"
            : "Archive"
          : remaining > 1
            ? "Approve and next"
            : "Approve";
  const batchFrom =
    item.origin.kind === "chat"
      ? " from this chat"
      : item.origin.kind === "schedule"
        ? " from this schedule"
        : "";
  const menuItems =
    record || batch.length > 1 ? (
      <>
        {record ? (
          <DropdownMenuItem onSelect={() => onOpenEntry(record.id)}>
            <ArrowUpRightIcon />
            Open entry
          </DropdownMenuItem>
        ) : null}
        {batch.length > 1 ? (
          <DropdownMenuItem disabled={busy} onSelect={approveBatch}>
            <CheckCheckIcon />
            {`Approve all ${batch.length}${batchFrom}`}
          </DropdownMenuItem>
        ) : null}
      </>
    ) : null;
  const actions =
    loaded && !editing ? (
      <>
        <RowButton disabled={busy} onClick={() => decide("reject")}>
          {pending === "reject" ? "Rejecting…" : "Reject"}
        </RowButton>
        {canEditFirst && record ? (
          <RowButton
            disabled={busy}
            onClick={() => {
              setDraftTitle(record.revision.entry.title);
              setDraft(record.revision.entry.content);
              setDraftError(null);
              setActionError(null);
              setEditing(true);
            }}
          >
            Edit
          </RowButton>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={removal ? "destructive" : "default"}
          disabled={busy}
          onClick={() => (removal ? setConfirmDelete(true) : decide("approve"))}
          className="rounded-[10px] pointer-coarse:h-11"
        >
          {approveLabel}
        </Button>
        {menuItems ? <MoreMenu label={`More actions for ${title}`}>{menuItems}</MoreMenu> : null}
      </>
    ) : null;

  const header = (
    <DetailPageHeader
      leading={<ReviewTile kind={item.kind} />}
      title={title}
      // Type, scope and time first; the chat or schedule it came from last,
      // since its name is the part that runs long.
      meta={[
        reviewTypeLabel(item),
        item.kind === "knowledge" && item.entry.scope !== "workspace"
          ? KNOWLEDGE_SCOPE_LABEL[item.entry.scope]
          : null,
        item.createdAt ? (
          <span key="at">
            proposed <RelativeTime date={item.createdAt} inSentence />
          </span>
        ) : null,
        item.origin.kind === "none" ? null : (
          <OriginLink key="origin" workspaceId={workspaceId} origin={item.origin} />
        ),
      ]}
      actions={actions}
    />
  );

  /* ------------------------------------------------------------ body */

  let body: ReactNode;
  if (loadError) {
    body = (
      <DetailSection>
        <Notice
          tone="failed"
          title="Couldn't load this change"
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRetry((value) => value + 1)}
            >
              Try again
            </Button>
          }
          actionLayout="responsive"
        >
          {item.kind === "instruction"
            ? `Approving is off until the current instructions load, so nothing is replaced unseen. ${loadError}`
            : loadError}
        </Notice>
      </DetailSection>
    );
  } else if (!loaded) {
    body = (
      <DetailSection>
        <span role="status" className="sr-only">
          Loading the change
        </span>
        <BodySkeleton />
      </DetailSection>
    );
  } else if (editing && record) {
    body = (
      <DetailSection
        title="Edit before approving"
        description="What you save is what agents use. The agent's version stays in History."
      >
        <form
          className="flex max-w-[640px] min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draftTitle.trim() || (!draft.trim() && record.revision.entry.kind !== "group")) {
              setDraftError("The change can't be empty. Reject it instead.");
              return;
            }
            decide("approve", { title: draftTitle.trim(), content: draft.trim() });
          }}
        >
          <Field label="Title">
            <TextInput
              value={draftTitle}
              maxLength={1024}
              onChange={(event) => setDraftTitle(event.target.value)}
            />
          </Field>
          <Field label="What agents should know" error={draftError ?? undefined}>
            <TextArea
              rows={8}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setDraftError(null);
              }}
            />
          </Field>
          {actionError ? (
            <p role="alert" className="text-sm text-danger">
              Couldn't save your decision. {actionError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(false)}
              className="pointer-coarse:h-11"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy} className="pointer-coarse:h-11">
              {busy ? "Saving…" : "Save and approve"}
            </Button>
          </div>
        </form>
      </DetailSection>
    );
  } else {
    body = (
      <>
        {actionError ? (
          <DetailSection>
            <Notice tone="failed" title="Couldn't save your decision" live="assertive">
              {actionError}
            </Notice>
          </DetailSection>
        ) : null}
        <ProposalBody
          workspaceId={workspaceId}
          item={item}
          loaded={loaded}
          archiveRequest={Boolean(archiveRequest)}
          removal={removal}
        />
      </>
    );
  }

  return (
    <>
      {header}
      {loaded?.kind === "knowledge" && loaded.requiredFor ? (
        <Notice tone="waiting" title="Review this first" className="mt-6">
          “{loaded.requiredFor}” depends on this change, so it comes first.
        </Notice>
      ) : null}
      <DetailPageBody className="mt-2">{body}</DetailPageBody>
      {removal ? (
        <DestructiveConfirm
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete ${item.title}?`}
          consequences={[
            "Agents can no longer use this skill.",
            "Every saved version of it is deleted.",
            "Chats that used it stay as they are.",
            "This can't be undone.",
          ]}
          confirmLabel="Delete skill"
          pendingLabel="Deleting…"
          onConfirm={() => {
            decide("approve");
          }}
        />
      ) : null}
    </>
  );
}

/** The proposal as it reads: new text plainly, a change with what differs marked. */
function ProposalBody({
  workspaceId,
  item,
  loaded,
  archiveRequest,
  removal,
}: {
  workspaceId: string;
  item: ReviewItem;
  loaded: Loaded;
  archiveRequest: boolean;
  removal: boolean;
}) {
  const markdown = loaded.kind !== "knowledge";
  const before = loaded.kind === "instruction" ? (loaded.before ?? "") : loaded.before;
  const after =
    loaded.kind === "knowledge"
      ? loaded.record.revision.entry.content
      : loaded.kind === "instruction" && item.kind === "instruction"
        ? item.item.content
        : loaded.kind === "skill"
          ? skillText(loaded.record)
          : "";
  const read = (text: string) => (markdown ? <Markdown text={text} /> : <PlainText text={text} />);

  // Asking to remove something: say so, and show what goes away as it reads.
  if (archiveRequest || removal) {
    return (
      <DetailSection
        title={archiveRequest ? "What agents know now" : "What the skill says now"}
        description={
          archiveRequest
            ? "An agent asked to archive this. Agents stop using it once you approve, and you can restore it later."
            : "An agent asked to delete this skill. Approving deletes it and all its versions. This can't be undone."
        }
      >
        {before.trim() ? (
          read(before)
        ) : (
          <p className="text-sm text-fg-muted">There's no text to show.</p>
        )}
      </DetailSection>
    );
  }

  const renamed =
    loaded.kind === "knowledge" &&
    loaded.beforeTitle &&
    loaded.beforeTitle !== loaded.record.revision.entry.title
      ? loaded.beforeTitle
      : null;
  const fresh = !before.trim();
  const sectionTitle = fresh
    ? loaded.kind === "knowledge"
      ? "What agents will know"
      : loaded.kind === "instruction"
        ? "New instructions"
        : "What the skill says"
    : "What changes";

  return (
    <>
      <DetailSection
        title={sectionTitle}
        description={
          fresh
            ? undefined
            : `${renamed ? `Renamed from “${renamed}”. ` : ""}Added text is highlighted and removed text is struck through.`
        }
      >
        {fresh ? (
          read(after)
        ) : (
          <DiffView
            before={before}
            after={after}
            variant="prose"
            format={markdown ? "markdown" : "text"}
            bare
            hideStats
            label={`Changes to ${item.title}`}
            className="[&>div]:px-0 [&>div]:py-0 [&>p]:px-0"
            emptyMessage="The text doesn't change. Only its details, like collections or sources, do."
          />
        )}
      </DetailSection>
      {loaded.kind === "instruction" && item.kind === "instruction" && item.item.reason ? (
        <DetailSection title="Why">
          <p className="text-sm leading-6 text-fg">{item.item.reason}</p>
        </DetailSection>
      ) : null}
      {loaded.kind === "skill" ? (
        <DetailSection>
          <InlineHelp icon>
            Approving adds it to Skills in{" "}
            <InAppHelpLink href={`/workspaces/${workspaceId}/plugins?section=skills`}>
              Capabilities
            </InAppHelpLink>
            , where you can change it later.
          </InlineHelp>
        </DetailSection>
      ) : null}
    </>
  );
}
