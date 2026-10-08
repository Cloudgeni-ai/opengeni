// The Inbox: everything an agent waits on the person for (questions,
// approvals, goals paused on them) and what agents chose to tell them. It is a
// to-do surface, not an archive: an item leaves once it is answered, resolved,
// withdrawn or dismissed, and it always stays in its session's timeline.
import type {
  InboxItem,
  SessionHumanInputRequest,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { HumanInputForm } from "@opengeni/react/session-ui";
import { useNavigate } from "@tanstack/react-router";
import {
  BellIcon,
  CheckIcon,
  CirclePauseIcon,
  InboxIcon,
  MessageCircleQuestionIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { RowButton } from "@/components/ui/page-actions";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { Section } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Toolbar } from "@/components/ui/toolbar";
import { useAppContext } from "@/context";
import { apiErrorFacts, userErrorText } from "@/lib/api-error";
import { useInbox } from "@/lib/inbox";
import { cn } from "@/lib/utils";

const COLUMNS: RowListColumn[] = [{ id: "when", label: "When", width: 88, hideLabel: true }];

const KIND_WORD: Record<InboxItem["kind"], string> = {
  question: "Question",
  approval: "Approval",
  goal_paused: "Goal paused",
  notification: "",
};

function KindIcon({ kind }: { kind: InboxItem["kind"] }) {
  if (kind === "question") return <MessageCircleQuestionIcon />;
  if (kind === "approval") return <ShieldCheckIcon />;
  if (kind === "goal_paused") return <CirclePauseIcon />;
  return <BellIcon />;
}

function isSnoozed(item: InboxItem, now: number): boolean {
  return item.snoozedUntil !== null && Date.parse(item.snoozedUntil) > now;
}

/** Tomorrow at 08:00 local time. */
function tomorrowMorning(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return date;
}

function snoozeLabel(until: string): string {
  const date = new Date(until);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay
    ? `Snoozed until ${time}`
    : `Snoozed until ${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

export function InboxRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const inbox = useInbox({ pollMs: 10_000 });
  const [scope, setScope] = useState<"all" | "workspace">("all");
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [answering, setAnswering] = useState<InboxItem | null>(null);
  // Unread items keep their dot for this visit; the server learns they were seen.
  const unreadThisVisit = useRef(new Set<string>());
  const now = Date.now();

  const items = inbox.data?.items ?? [];
  const workspaceNames = useMemo(
    () => new Map(context.workspaces.map((workspace) => [workspace.id, workspace.name])),
    [context.workspaces],
  );
  const workspacesWithItems = new Set(items.map((item) => item.workspaceId));
  // Nothing to pick, nothing shown: the scope switch appears only when items span workspaces.
  const showScope = workspacesWithItems.size > 1 || !workspacesWithItems.has(workspaceId);
  const scoped = items.filter((item) => scope === "all" || item.workspaceId === workspaceId);
  const awake = scoped.filter((item) => !isSnoozed(item, now));
  const needsYou = awake.filter((item) => item.kind !== "notification");
  const fromAgents = awake.filter((item) => item.kind === "notification");
  const snoozed = scoped.filter((item) => isSnoozed(item, now));

  useEffect(() => {
    const unseen = items.filter((item) => item.unread);
    if (unseen.length === 0) return;
    for (const item of unseen) unreadThisVisit.current.add(item.id);
    const timer = window.setTimeout(() => {
      for (const item of unseen) {
        void context.client.updateInboxItem(item.id, { seen: true }).catch(() => undefined);
      }
      inbox.patchItems((current) =>
        current.map((item) => (unseen.some((seen) => seen.id === item.id) ? { ...item, unread: false } : item)),
      );
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [items, context.client, inbox]);

  const openSession = (item: InboxItem) =>
    void navigate({
      to: "/workspaces/$workspaceId/sessions/$sessionId",
      params: { workspaceId: item.workspaceId, sessionId: item.sessionId },
    });

  const leave = (item: InboxItem) =>
    inbox.patchItems((current) => current.filter((candidate) => candidate.id !== item.id));

  const run = async (item: InboxItem, label: string, action: () => Promise<unknown>) => {
    setBusy((current) => ({ ...current, [item.id]: label }));
    try {
      await action();
      void inbox.refresh();
    } catch (error) {
      toast.error(userErrorText(error, "That didn't go through. Try again."));
    } finally {
      setBusy(({ [item.id]: _done, ...rest }) => rest);
    }
  };

  const decide = (item: InboxItem, decision: "approve" | "reject") =>
    void run(item, decision, async () => {
      await context.client.sendApprovalDecision(item.workspaceId, item.sessionId, {
        approvalId: item.sourceKey,
        decision,
      });
      leave(item);
      toast.success(decision === "approve" ? "Approved" : "Denied", {
        description: item.sessionTitle ?? undefined,
      });
    });

  const snooze = (item: InboxItem, until: Date | null) =>
    void run(item, "snooze", async () => {
      const snoozedUntil = until ? until.toISOString() : null;
      inbox.patchItems((current) =>
        current.map((candidate) => (candidate.id === item.id ? { ...candidate, snoozedUntil } : candidate)),
      );
      await context.client.updateInboxItem(item.id, { snoozedUntil });
    });

  const dismiss = (item: InboxItem) =>
    void run(item, "dismiss", async () => {
      leave(item);
      await context.client.updateInboxItem(item.id, { dismissed: true });
    });

  const meta = (item: InboxItem): ReactNode[] => {
    const parts: ReactNode[] = [];
    if (item.kind === "notification") {
      if (item.body) parts.push(item.body);
    } else {
      parts.push(KIND_WORD[item.kind]);
    }
    parts.push(item.sessionTitle ?? "Untitled session");
    if (scope === "all" && workspacesWithItems.size > 1) {
      const name = workspaceNames.get(item.workspaceId);
      if (name) parts.push(name);
    }
    if (item.kind === "question" && item.body) parts.push(item.body);
    if (isSnoozed(item, now) && item.snoozedUntil) parts.push(snoozeLabel(item.snoozedUntil));
    return parts;
  };

  const control = (item: InboxItem): ReactNode => {
    const pending = busy[item.id];
    if (item.kind === "approval") {
      return (
        <div className="flex items-center gap-2">
          <RowButton disabled={Boolean(pending)} onClick={() => decide(item, "reject")}>
            <XIcon />
            Deny
          </RowButton>
          <RowButton disabled={Boolean(pending)} onClick={() => decide(item, "approve")}>
            <CheckIcon />
            {pending === "approve" ? "Approving…" : "Approve"}
          </RowButton>
        </div>
      );
    }
    if (item.kind === "question") {
      return (
        <RowButton disabled={Boolean(pending)} onClick={() => setAnswering(item)}>
          Answer
        </RowButton>
      );
    }
    return null;
  };

  const row = (item: InboxItem) => {
    const unread = item.unread || unreadThisVisit.current.has(item.id);
    return (
      <ListRow
        key={item.id}
        leading={
          <span className="relative inline-flex">
            <LogoTile icon={<KindIcon kind={item.kind} />} />
            {item.kind === "notification" && unread ? (
              <span
                aria-hidden="true"
                className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-session-update ring-2 ring-canvas"
              />
            ) : null}
          </span>
        }
        title={item.title}
        meta={meta(item)}
        cells={{ when: <RelativeTime date={item.updatedAt} /> }}
        control={control(item)}
        onOpen={() => openSession(item)}
        menuLabel={`More actions for ${item.title}`}
        menu={
          <>
            <DropdownMenuItem onSelect={() => openSession(item)}>Open session</DropdownMenuItem>
            <DropdownMenuSeparator />
            {isSnoozed(item, now) ? (
              <DropdownMenuItem onSelect={() => snooze(item, null)}>Unsnooze</DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onSelect={() => snooze(item, new Date(Date.now() + 3_600_000))}>
                  Snooze for 1 hour
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => snooze(item, tomorrowMorning())}>
                  Snooze until tomorrow
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onSelect={() => dismiss(item)}>
              {item.kind === "notification" ? "Dismiss" : "Remove from inbox"}
            </DropdownMenuItem>
          </>
        }
      />
    );
  };

  let body: ReactNode;
  if (inbox.loading && !inbox.data) {
    body = (
      <RowList label="Inbox" columns={COLUMNS} flush busy>
        <ListRowSkeleton count={3} />
      </RowList>
    );
  } else if (inbox.error && !inbox.data) {
    body = (
      <Notice
        tone="failed"
        title="Couldn't load your inbox"
        action={
          <Button type="button" size="sm" variant="outline" onClick={() => void inbox.refresh()}>
            Try again
          </Button>
        }
      >
        {apiErrorFacts(inbox.error).serverMessage ?? "Something went wrong."}
      </Notice>
    );
  } else if (awake.length === 0 && snoozed.length === 0) {
    body = (
      <EmptyState
        variant="page"
        icon={<InboxIcon />}
        title="Nothing is waiting on you"
        description="When an agent asks you something, needs an approval or wants you to know something, it shows up here."
      />
    );
  } else {
    body = (
      <div className="flex min-w-0 flex-col">
        {needsYou.length > 0 ? (
          <Section title="Needs you" divided={false}>
            <RowList label="Needs you" columns={COLUMNS} flush>
              {needsYou.map(row)}
            </RowList>
          </Section>
        ) : null}
        {fromAgents.length > 0 ? (
          <Section title="From your agents" divided={needsYou.length > 0}>
            <RowList label="From your agents" columns={COLUMNS} flush>
              {fromAgents.map(row)}
            </RowList>
          </Section>
        ) : null}
        {awake.length === 0 ? (
          <p className="py-6 text-sm text-fg-muted">
            Nothing needs you right now. Snoozed items come back on their own.
          </p>
        ) : null}
        {snoozed.length > 0 ? (
          <div className={cn(awake.length > 0 && "mt-6")}>
            <Disclosure title="Snoozed" summary={String(snoozed.length)}>
              <RowList label="Snoozed" columns={COLUMNS} flush>
                {snoozed.map(row)}
              </RowList>
            </Disclosure>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <ContentPage width="standard">
      <div className="min-w-0 pb-7">
        <PageHeader
          icon={<InboxIcon />}
          title="Inbox"
          description="What your agents are waiting on you for, and what they wanted you to know."
        />
        <div className="flex min-w-0 flex-col gap-4 pt-6">
          {showScope && items.length > 0 ? (
            <Toolbar>
              <SegmentedControl
                aria-label="Show items from"
                value={scope}
                onValueChange={setScope}
                options={[
                  { value: "all", label: "All workspaces" },
                  {
                    value: "workspace",
                    label: workspaceNames.get(workspaceId) ?? "This workspace",
                  },
                ]}
              />
            </Toolbar>
          ) : null}
          {body}
        </div>
      </div>
      <AnswerDialog
        item={answering}
        onClose={() => setAnswering(null)}
        onAnswered={(item) => {
          leave(item);
          void inbox.refresh();
        }}
      />
    </ContentPage>
  );
}

/** Answer a question without leaving the inbox: the same form as in the session. */
function AnswerDialog({
  item,
  onClose,
  onAnswered,
}: {
  item: InboxItem | null;
  onClose: () => void;
  onAnswered: (item: InboxItem) => void;
}) {
  const context = useAppContext();
  const [request, setRequest] = useState<SessionHumanInputRequest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    setRequest(null);
    setLoadError(null);
    setSubmitError(null);
    if (!item) return;
    let current = true;
    void context.client
      .getHumanInputRequest(item.workspaceId, item.sessionId, item.sourceKey)
      .then((loaded) => {
        if (!current) return;
        if (loaded.status !== "pending") {
          setLoadError("This question was already answered or is no longer open.");
          onAnswered(item);
          return;
        }
        setRequest(loaded);
      })
      .catch((error: unknown) => {
        if (current) setLoadError(userErrorText(error, "Couldn't load the question."));
      });
    return () => {
      current = false;
    };
  }, [item, context.client, onAnswered]);

  const submit = async (response: SubmitHumanInputResponseRequest) => {
    if (!item) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await context.client.submitHumanInputResponse(
        item.workspaceId,
        item.sessionId,
        item.sourceKey,
        response,
      );
      onAnswered(item);
      onClose();
      toast.success(response.outcome === "skipped" ? "Skipped" : "Answer sent", {
        description: item.sessionTitle ?? undefined,
      });
    } catch (error) {
      setSubmitError(userErrorText(error, "Couldn't send your answer. Try again."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={item !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Answer</DialogTitle>
          <DialogDescription>{item?.sessionTitle ?? "Untitled session"}</DialogDescription>
        </DialogHeader>
        {loadError ? (
          <Notice tone="failed">{loadError}</Notice>
        ) : request ? (
          <HumanInputForm
            request={request}
            onSubmit={submit}
            submitting={submitting}
            error={submitError}
            decisionButtons
          />
        ) : (
          <div className="grid gap-3 py-2" aria-busy="true">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
