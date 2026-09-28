import type {
  AgentInstructionReviewItem,
  KnowledgeEntryRecord,
  KnowledgeEntrySummary,
  KnowledgeReviewBatch,
  SkillRecord,
  SkillSummary,
} from "@opengeni/sdk";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  CalendarClockIcon,
  CheckIcon,
  InboxIcon,
  MessageSquareIcon,
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
import { DiffView } from "@/components/ui/diff-view";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, TextArea, TextInput } from "@/components/ui/field";
import { InAppHelpLink } from "@/components/in-app-help-link";
import { HelpLink, InlineHelp } from "@/components/ui/inline-help";
import { ListRow, ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { inAppClick } from "@/lib/in-app-click";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { useAppContext } from "@/context";
import { canManageWorkspaceSettings, hasAccountPermission } from "@/lib/permissions";

import { errorText } from "./knowledge-data";
import { KNOWLEDGE_KIND_LABEL } from "./knowledge-labels";
import { firstReviewableEntry } from "./knowledge-review-order";

/* ----------------------------------------------------------------------------
   Review: changes agents proposed while Learning is set to Review first,
   grouped by the chat or schedule that made them. One DiffView for
   knowledge, instructions and skills, and Approve and next. On narrow widths
   the list and the change take turns.
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
  /** Some inventories couldn't be fully checked. */
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
    setState(null);
    void (async () => {
      const failures: string[] = [];
      let partial = false;
      const items: ReviewItem[] = [];

      // Instructions and Skills list an inventory, not only proposals. An empty
      // page with a cursor can't establish that nothing is waiting for review.
      // Keep earlier pages on a failure and stop reads when this load is stale.
      const scan = async <Page extends { nextCursor: string | null }>(
        load: (cursor?: string) => Promise<Page>,
      ): Promise<Page[]> => {
        const pages: Page[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        try {
          do {
            const page = await load(cursor);
            if (!current) return pages;
            pages.push(page);
            cursor = page.nextCursor ?? undefined;
            if (cursor) {
              if (seen.has(cursor)) throw new Error("Couldn't finish checking changes. Try again.");
              seen.add(cursor);
            }
          } while (cursor);
        } catch (reason) {
          partial = true;
          failures.push(errorText(reason));
        }
        return pages;
      };

      const [batchPages, instructionPages, skillPages] = await Promise.all([
        scan((cursor) =>
          client.listKnowledgeReviewBatches(workspaceId, {
            limit: 20,
            ...(cursor ? { cursor } : {}),
          }),
        ),
        canManage
          ? scan((cursor) => client.listAgentInstructionReviews(workspaceId, cursor))
          : Promise.resolve([]),
        scan((cursor) =>
          client.listWorkspaceSkills(workspaceId, {
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        ),
      ]);
      if (!current) return;
      const batches = batchPages.flatMap((page) => page.batches);
      const entryPages = await Promise.all(
        batches.map((batch) =>
          scan((cursor) =>
            client.listKnowledgeEntries(workspaceId, {
              view: "needs_review",
              reviewBatchId: batch.id,
              limit: 50,
              ...(cursor ? { cursor } : {}),
            }),
          ),
        ),
      );
      entryPages.forEach((pages, index) => {
        const batch = batches[index]!;
        for (const entry of pages.flatMap((page) => page.entries)) {
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
      for (const page of instructionPages) {
        for (const item of page.entries) {
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
      }
      for (const page of skillPages) {
        for (const skill of page.skills) {
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
      }
      if (current)
        setState({
          items: [...new Map(items.map((item) => [item.key, item])).values()],
          partial,
          error: failures.length ? failures[0]! : null,
        });
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

/* ------------------------------------------------------------------ view */

function OriginLink({
  workspaceId,
  origin,
  inline = false,
}: {
  workspaceId: string;
  origin: Origin;
  inline?: boolean;
}) {
  const navigate = useNavigate();
  const href =
    origin.kind === "chat"
      ? `/workspaces/${workspaceId}/sessions/${origin.sessionId}`
      : origin.kind === "schedule"
        ? `/workspaces/${workspaceId}/schedules?taskId=${origin.taskId}`
        : null;
  const unnamed = origin.kind === "chat" && origin.unnamed;
  const word = unnamed
    ? null
    : origin.kind === "chat"
      ? "chat"
      : origin.kind === "schedule"
        ? "schedule"
        : null;
  const name = href ? (
    <a
      href={href}
      onClick={inAppClick(() => void navigate({ href }))}
      className="min-w-0 truncate rounded-[4px] font-medium text-fg underline-offset-2 hover:underline"
    >
      {origin.name}
    </a>
  ) : (
    <span className="min-w-0 truncate font-medium text-fg">{origin.name}</span>
  );
  if (inline) {
    return word ? (
      <>
        {word} {name}
      </>
    ) : (
      name
    );
  }
  const Icon =
    origin.kind === "chat"
      ? MessageSquareIcon
      : origin.kind === "schedule"
        ? CalendarClockIcon
        : InboxIcon;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
      {word ? <span className="shrink-0">{word === "chat" ? "Chat" : "Schedule"}</span> : null}
      {unnamed ? <span className="shrink-0">From</span> : null}
      {name}
    </span>
  );
}

export interface ReviewTabProps {
  workspaceId: string;
  queue: ReviewQueue;
  learningLine: string;
  onOpenLearning: () => void;
  onOpenEntry: (id: string) => void;
  onChanged: () => void;
}

export function ReviewTab({
  workspaceId,
  queue,
  learningLine,
  onOpenLearning,
  onOpenEntry,
  onChanged,
}: ReviewTabProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const items = queue.items.filter((item) => !hidden.has(item.key));
  const selected = items.find((item) => item.key === selectedKey) ?? items[0] ?? null;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected?.key ?? null;
  const groups = queue.groups
    .map((group) => ({ ...group, items: group.items.filter((item) => !hidden.has(item.key)) }))
    .filter((group) => group.items.length > 0);
  // Reviewed items leave the list at once; the queue refetches behind them.
  useEffect(() => setHidden(new Set()), [queue.items]);

  const next = (current: ReviewItem) => {
    const index = items.findIndex((item) => item.key === current.key);
    const following = items[index + 1] ?? items[index - 1] ?? null;
    setHidden((prior) => new Set(prior).add(current.key));
    // A decision that completes after the reviewer opened another change
    // must not move them off it; only a decision on what is open advances.
    const open = selectedRef.current;
    if (open === current.key) {
      setSelectedKey(following?.key ?? null);
      if (!following) setShowDetail(false);
    } else if (open) {
      setSelectedKey(open);
    }
    notifyKnowledgeReviewUpdated();
    onChanged();
  };

  const help = (
    <InlineHelp icon>
      {learningLine} <HelpLink onClick={onOpenLearning}>Change it</HelpLink>
    </InlineHelp>
  );

  const shell = (content: ReactNode) => (
    <div className="@container/review flex min-w-0 flex-col gap-4 pt-6">
      {help}
      {queue.error && items.length ? (
        <Notice
          tone="failed"
          title="Some changes couldn't be loaded"
          action={
            <Button type="button" size="sm" variant="outline" onClick={queue.reload}>
              Try again
            </Button>
          }
          actionLayout="responsive"
        >
          {queue.error}
        </Notice>
      ) : null}
      {content}
    </div>
  );

  if (queue.loading) {
    return shell(
      <RowList label="Changes waiting for review" busy>
        <ListRowSkeleton count={3} />
      </RowList>,
    );
  }
  if (queue.error && !items.length) {
    return shell(
      <Notice
        tone="failed"
        title="Couldn't load the changes waiting for review"
        action={
          <Button type="button" size="sm" variant="outline" onClick={queue.reload}>
            Try again
          </Button>
        }
        actionLayout="responsive"
      >
        {queue.error}
      </Notice>,
    );
  }
  if (!selected) {
    if (queue.partial) {
      return shell(
        <Notice
          title="Some changes haven't been checked"
          action={
            <Button type="button" size="sm" variant="outline" onClick={queue.reload}>
              Try again
            </Button>
          }
          actionLayout="responsive"
        />,
      );
    }
    return shell(
      <EmptyState
        variant="page"
        icon={<InboxIcon />}
        title="You're all caught up"
        description="When agents propose knowledge, instruction or skill changes, they wait here for your OK."
      />,
    );
  }

  const list = (narrow: boolean) => (
    <div className="flex min-w-0 flex-col gap-5">
      {groups.map((group) => (
        <section key={group.key} aria-label={`From ${group.origin.name}`} className="min-w-0">
          <div className="flex min-w-0 items-center justify-between gap-2 px-3 pb-1.5 text-xs leading-4.5 text-fg-muted">
            <OriginLink workspaceId={workspaceId} origin={group.origin} />
            {group.batch && group.items.length > 1 ? (
              <ApproveAll
                workspaceId={workspaceId}
                items={group.items}
                onDone={(reviewed) => {
                  setHidden((prior) => {
                    const done = new Set(prior);
                    for (const entry of reviewed) done.add(`knowledge:${entry.id}`);
                    return done;
                  });
                  notifyKnowledgeReviewUpdated();
                  onChanged();
                }}
              />
            ) : null}
          </div>
          <RowList label={`Changes from ${group.origin.name}`}>
            {group.items.map((item) => {
              const Icon = KIND_ICON[item.kind];
              return (
                <ListRow
                  key={item.key}
                  leading={<LogoTile icon={<Icon />} name={KIND_LABEL[item.kind]} />}
                  title={item.title}
                  meta={[
                    // Knowledge says which kind ("Decision"), in words like the Library.
                    item.kind === "knowledge"
                      ? KNOWLEDGE_KIND_LABEL[item.entry.revision.kind]
                      : KIND_LABEL[item.kind],
                    item.createdAt ? <RelativeTime key="at" date={item.createdAt} /> : null,
                  ].filter(Boolean)}
                  selected={!narrow && item.key === selected.key}
                  onOpen={() => {
                    setSelectedKey(item.key);
                    setShowDetail(true);
                  }}
                  indicator={narrow ? "open" : undefined}
                />
              );
            })}
          </RowList>
        </section>
      ))}
      {queue.partial ? (
        <p className="px-3 text-xs text-fg-muted">
          Some changes couldn't be checked. Try again to check the rest.
        </p>
      ) : null}
    </div>
  );

  const detail = (
    <ReviewDetail
      key={selected.key}
      workspaceId={workspaceId}
      item={selected}
      remaining={items.length}
      onDone={() => next(selected)}
      onOpenEntry={onOpenEntry}
    />
  );

  return shell(
    <>
      <div className="hidden min-w-0 grid-cols-[minmax(0,320px)_minmax(0,1fr)] items-start gap-6 @[760px]/review:grid">
        {list(false)}
        <div className="min-w-0">{detail}</div>
      </div>
      <div className="min-w-0 @[760px]/review:hidden">
        {showDetail ? (
          <div className="flex min-w-0 flex-col gap-3">
            <button
              type="button"
              onClick={() => setShowDetail(false)}
              className="inline-flex w-fit items-center gap-1.5 rounded-[6px] text-sm font-medium text-fg-muted transition-colors duration-[120ms] hover:text-fg pointer-coarse:min-h-11"
            >
              <ArrowLeftIcon aria-hidden="true" className="size-4" />
              All changes ({items.length})
            </button>
            {detail}
          </div>
        ) : (
          list(true)
        )}
      </div>
    </>,
  );
}

function ApproveAll({
  workspaceId,
  items,
  onDone,
}: {
  workspaceId: string;
  items: ReviewItem[];
  onDone: (reviewed: KnowledgeEntrySummary[]) => void;
}) {
  const { client } = useAppContext();
  const [busy, setBusy] = useState(false);
  const allKnowledge = items.flatMap((item) => (item.kind === "knowledge" ? [item.entry] : []));
  const knowledge = allKnowledge.slice(0, 100);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void client
          .reviewKnowledgeEntries(workspaceId, {
            entries: knowledge.map((entry) => ({
              operationId: crypto.randomUUID(),
              entryId: entry.id,
              revisionId: entry.revision.id,
              expectedVersion: entry.version,
              decision: "approve" as const,
            })),
          })
          .then(() => {
            toast(`Approved ${knowledge.length} changes`);
            onDone(knowledge);
          })
          .catch((reason: unknown) =>
            toast.error("Couldn't approve them all", { description: errorText(reason) }),
          )
          .finally(() => setBusy(false));
      }}
      className="shrink-0 rounded-[6px] font-medium text-brand underline-offset-2 hover:underline disabled:opacity-60 pointer-coarse:min-h-11"
    >
      {busy
        ? "Approving…"
        : allKnowledge.length > 100
          ? "Approve 100"
          : `Approve all ${knowledge.length}`}
    </button>
  );
}

/* --------------------------------------------------------------- detail */

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

function ReviewDetail({
  workspaceId,
  item,
  remaining,
  onDone,
  onOpenEntry,
}: {
  workspaceId: string;
  item: ReviewItem;
  remaining: number;
  onDone: () => void;
  onOpenEntry: (id: string) => void;
}) {
  const { client } = useAppContext();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
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

  useEffect(() => {
    let current = true;
    setLoaded(null);
    setLoadError(null);
    void (async (): Promise<Loaded> => {
      if (item.kind === "knowledge") {
        const record = await firstReviewableEntry(item.entry.id, (id, options) =>
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
          requiredFor: record.id === item.entry.id ? null : item.title,
        };
      }
      if (item.kind === "instruction") {
        const target = item.item.target;
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
        item.skill.id,
        item.skill.pendingRevisionIds[0],
      );
      const active = item.skill.activeRevisionId
        ? await client
            .readWorkspaceSkill(workspaceId, item.skill.id, item.skill.activeRevisionId)
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
  }, [client, workspaceId, item, retry]);

  const act = async (run: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await run();
      toast(message);
      if (loaded?.kind === "knowledge" && loaded.requiredFor) {
        // A prerequisite is done; the change the reviewer picked is next.
        setEditing(false);
        setRetry((value) => value + 1);
        notifyKnowledgeReviewUpdated();
      } else {
        onDone();
      }
    } catch (reason) {
      if (alive.current) setActionError(errorText(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const decide = (decision: "approve" | "reject", edited?: { title: string; content: string }) => {
    if (!loaded) return;
    if (loaded.kind === "knowledge") {
      const record = loaded.record;
      void act(
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

  const Icon = KIND_ICON[item.kind];
  const origin = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <MetaChip variant="outline">{KIND_LABEL[item.kind]}</MetaChip>
      <span className="min-w-0">
        {item.origin.kind === "none" ? null : (
          <>
            From <OriginLink workspaceId={workspaceId} origin={item.origin} inline />
          </>
        )}
        {item.createdAt ? (
          <>
            {item.origin.kind === "none" ? "Proposed " : " · "}
            <RelativeTime date={item.createdAt} inSentence={item.origin.kind === "none"} />
          </>
        ) : null}
      </span>
    </span>
  );

  if (loadError) {
    return (
      <Notice
        tone="failed"
        title="Couldn't load this change"
        action={
          <Button type="button" size="sm" variant="outline" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </Button>
        }
        actionLayout="responsive"
      >
        {item.kind === "instruction"
          ? `Approving is off until the current instructions load, so nothing is replaced unseen. ${loadError}`
          : loadError}
      </Notice>
    );
  }
  if (!loaded) {
    return <DiffView loading title={item.title} meta={origin} />;
  }

  const record = loaded.kind === "knowledge" ? loaded.record : null;
  const archiveRequest = record?.revision.change === "archive";
  const removal = loaded.kind === "skill" && Boolean(loaded.record.removalOperationId);
  const title = loaded.kind === "knowledge" ? loaded.record.revision.entry.title : item.title;
  const before = loaded.kind === "instruction" ? (loaded.before ?? "") : loaded.before;
  const after =
    loaded.kind === "knowledge"
      ? archiveRequest
        ? ""
        : loaded.record.revision.entry.content
      : loaded.kind === "instruction" && item.kind === "instruction"
        ? item.item.content
        : loaded.kind === "skill"
          ? removal
            ? ""
            : skillText(loaded.record)
          : "";
  const canEditFirst = loaded.kind === "knowledge" && !archiveRequest;
  const approveLabel = removal
    ? "Delete skill…"
    : archiveRequest
      ? remaining > 1
        ? "Archive and next"
        : "Archive"
      : remaining > 1
        ? "Approve and next"
        : "Approve";

  if (editing && record) {
    return (
      <div className="flex min-w-0 flex-col gap-4 rounded-[14px] border border-border bg-surface p-4">
        <div className="flex min-w-0 items-start gap-3">
          <LogoTile size="md" icon={<Icon />} />
          <div className="min-w-0">
            <p className="text-sm leading-5 font-semibold text-fg">Edit before approving</p>
            <p className="text-xs leading-4.5 text-fg-muted">
              Your edit is what gets saved. The agent's version stays in History.
            </p>
          </div>
        </div>
        <Field label="Title">
          <TextInput
            value={draftTitle}
            maxLength={1024}
            onChange={(event) => setDraftTitle(event.target.value)}
          />
        </Field>
        <Field label="What agents should know" error={draftError ?? undefined}>
          <TextArea
            rows={7}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setDraftError(null);
            }}
          />
        </Field>
        {actionError ? (
          <p role="alert" className="text-sm text-danger">
            {actionError}
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
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!draftTitle.trim() || (!draft.trim() && record.revision.entry.kind !== "group")) {
                setDraftError("The change can't be empty. Reject it instead.");
                return;
              }
              decide("approve", { title: draftTitle.trim(), content: draft.trim() });
            }}
            className="pointer-coarse:h-11"
          >
            <CheckIcon aria-hidden="true" />
            {busy ? "Saving…" : "Save and approve"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {loaded.kind === "knowledge" && loaded.requiredFor ? (
        <Notice tone="waiting" title="Review this first">
          “{loaded.requiredFor}” depends on this change, so it comes first.
        </Notice>
      ) : null}
      {archiveRequest ? (
        <Notice tone="muted" title="An agent asked to archive this">
          Agents stop using it once you approve. You can restore it later.
        </Notice>
      ) : null}
      {removal ? (
        <Notice tone="failed" title="An agent asked to delete this skill">
          Approving deletes the skill and all its versions. This can't be undone.
        </Notice>
      ) : null}
      <DiffView
        before={before}
        after={after}
        format={loaded.kind === "knowledge" ? "text" : "markdown"}
        title={
          record ? (
            <button
              type="button"
              onClick={() => onOpenEntry(record.id)}
              className="rounded-[4px] text-left underline-offset-2 hover:underline"
            >
              {title}
            </button>
          ) : (
            title
          )
        }
        meta={
          <span className="flex min-w-0 flex-col gap-1">
            {origin}
            {loaded.kind === "knowledge" &&
            loaded.beforeTitle &&
            loaded.beforeTitle !== loaded.record.revision.entry.title ? (
              <span>Renamed from “{loaded.beforeTitle}”</span>
            ) : null}
          </span>
        }
        emptyMessage="The text doesn't change. Only its details, like collections or sources, do."
      />
      {loaded.kind === "instruction" && item.kind === "instruction" && item.item.reason ? (
        <InlineHelp icon>Why: {item.item.reason}</InlineHelp>
      ) : null}
      {loaded.kind === "skill" && !removal ? (
        <InlineHelp icon>
          Approving adds it to Skills in{" "}
          <InAppHelpLink href={`/workspaces/${workspaceId}/plugins?section=skills`}>
            Capabilities
          </InAppHelpLink>
          , where you can change it later.
        </InlineHelp>
      ) : null}
      {actionError ? (
        <p role="alert" className="text-sm text-danger">
          {actionError}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => decide("reject")}
          className="text-fg-muted pointer-coarse:h-11"
        >
          Reject
        </Button>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {canEditFirst && record ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDraftTitle(record.revision.entry.title);
                setDraft(record.revision.entry.content);
                setDraftError(null);
                setEditing(true);
              }}
              className="pointer-coarse:h-11"
            >
              Edit first
            </Button>
          ) : null}
          <Button
            type="button"
            variant={removal ? "destructive" : "default"}
            disabled={busy}
            onClick={() => (removal ? setConfirmDelete(true) : decide("approve"))}
            className="pointer-coarse:h-11"
          >
            {removal ? null : <CheckIcon aria-hidden="true" />}
            {busy ? "Saving…" : approveLabel}
          </Button>
        </div>
      </div>
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
    </div>
  );
}
