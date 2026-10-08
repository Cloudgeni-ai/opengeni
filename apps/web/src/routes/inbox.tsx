// The Inbox: everything an agent waits on the person for (questions,
// approvals, goals paused on them) and what agents chose to tell them. It is a
// to-do surface, not an archive: an item leaves once it is answered, resolved,
// withdrawn or dismissed, and it always stays in its session's timeline.
import type {
  InboxItem,
  InboxSettings,
  InboxTidyPolicy,
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
  MoreHorizontalIcon,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { EmptyState } from "@/components/ui/empty-state";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { RowButton } from "@/components/ui/page-actions";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { Section, SectionStack } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Toolbar } from "@/components/ui/toolbar";
import { useAppContext } from "@/context";
import { apiErrorFacts, userErrorText } from "@/lib/api-error";
import { hasInbox, useInbox } from "@/lib/inbox";
import { cn } from "@/lib/utils";

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

/*
 * Inbox rows are messages, not resources: the question or the agent's note is
 * the content, so the title wraps to two lines and the note to two more instead
 * of truncating to one. Otherwise they match the flush resource list: the same
 * tile, hairlines inset to the text, 10px hover wash and one row target.
 */
function InboxList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul
      aria-label={label}
      className={cn(
        "-mx-3 my-0 flex min-w-0 list-none flex-col p-0",
        "[&>li+li]:before:pointer-events-none [&>li+li]:before:absolute [&>li+li]:before:inset-x-3 [&>li+li]:before:top-0 [&>li+li]:before:h-px [&>li+li]:before:bg-border [&>li+li]:before:content-['']",
      )}
    >
      {children}
    </ul>
  );
}

function InboxRow(props: {
  kind: InboxItem["kind"];
  unread: boolean;
  title: string;
  body?: ReactNode;
  meta: string[];
  when: string;
  actions?: ReactNode;
  menu: ReactNode;
  onOpen: () => void;
}) {
  return (
    <li className="relative min-w-0">
      <div
        className={cn(
          "group/row relative isolate flex min-w-0 gap-3 rounded-[10px] px-3 py-3.5 transition-colors duration-[120ms] hover:bg-hover",
          "has-[[data-row-open]:focus-visible]:outline-2 has-[[data-row-open]:focus-visible]:-outline-offset-2 has-[[data-row-open]:focus-visible]:outline-brand/55",
        )}
      >
        <button
          type="button"
          data-row-open
          aria-label={`${props.title}. Open session`}
          className="absolute inset-0 z-0 cursor-pointer rounded-[10px] outline-none"
          onClick={props.onOpen}
        />
        <span className="pointer-events-none relative mt-0.5 inline-flex shrink-0 self-start">
          <LogoTile icon={<KindIcon kind={props.kind} />} />
          {props.unread ? (
            <span
              aria-label="Unread"
              className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-session-update ring-2 ring-canvas"
            />
          ) : null}
        </span>
        <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col">
          <p className="line-clamp-2 min-w-0 text-sm font-medium leading-5 text-fg break-words">
            {props.title}
          </p>
          {props.body ? (
            <div className="line-clamp-2 min-w-0 text-sm leading-5 text-fg-muted break-words">
              {props.body}
            </div>
          ) : null}
          <p className="mt-0.5 flex min-w-0 items-baseline text-xs leading-[18px] text-fg-subtle">
            <span className="min-w-0 truncate">{props.meta.join(" · ")}</span>
            <span aria-hidden="true" className="shrink-0 px-1">
              ·
            </span>
            <span className="pointer-events-auto relative z-10 shrink-0 tabular-nums">
              <RelativeTime date={props.when} />
            </span>
          </p>
          {props.actions ? (
            <div className="pointer-events-auto relative z-10 mt-3 flex flex-wrap items-center gap-2">
              {props.actions}
            </div>
          ) : null}
        </div>
        <div className="relative z-10 -mr-1.5 -mt-1 shrink-0 self-start">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`More actions for ${props.title}`}
                className="grid size-8 place-items-center rounded-[10px] text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-3 hover:text-fg data-[state=open]:bg-surface-3 data-[state=open]:text-fg pointer-coarse:size-11"
              >
                <MoreHorizontalIcon aria-hidden="true" className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              {props.menu}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </li>
  );
}

function InboxSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading your inbox">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex gap-3">
          <Skeleton className="size-8 shrink-0 rounded-[10px]" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
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

  const listed = inbox.data?.items;
  const items = useMemo(() => listed ?? [], [listed]);
  const { patchItems } = inbox;
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
      patchItems((current) =>
        current.map((item) =>
          unseen.some((seen) => seen.id === item.id) ? { ...item, unread: false } : item,
        ),
      );
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [items, context.client, patchItems]);

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
        current.map((candidate) =>
          candidate.id === item.id ? { ...candidate, snoozedUntil } : candidate,
        ),
      );
      await context.client.updateInboxItem(item.id, { snoozedUntil });
    });

  const dismiss = (item: InboxItem) =>
    void run(item, "dismiss", async () => {
      leave(item);
      await context.client.updateInboxItem(item.id, { dismissed: true });
    });

  // One tap on an offered option answers the question, exactly as the form would.
  const choose = (item: InboxItem, choice: { id: string; label: string }) =>
    void run(item, `choice:${choice.id}`, async () => {
      const request = await context.client.getHumanInputRequest(
        item.workspaceId,
        item.sessionId,
        item.sourceKey,
      );
      const question = request.questions[0];
      if (request.status !== "pending" || !question) {
        leave(item);
        toast("That question was already answered", {
          description: item.sessionTitle ?? undefined,
        });
        return;
      }
      await context.client.submitHumanInputResponse(
        item.workspaceId,
        item.sessionId,
        item.sourceKey,
        { outcome: "answered", answers: [{ questionId: question.id, values: [choice.id] }] },
      );
      leave(item);
      toast.success(`Answered: ${choice.label}`, { description: item.sessionTitle ?? undefined });
    });

  // Under the title: what exactly is asked for, or the agent's note.
  const description = (item: InboxItem): ReactNode => {
    if (!item.body) return undefined;
    if (item.kind === "approval") {
      return (
        <code className="my-0.5 inline-block max-w-full truncate rounded-[6px] bg-surface-2 px-1.5 py-0.5 align-top font-mono text-xs text-fg">
          {item.body}
        </code>
      );
    }
    if (item.kind === "notification") return item.body;
    return undefined;
  };

  // Where it comes from. The kind word is left out where the row already says it.
  const meta = (item: InboxItem): string[] => {
    const parts: string[] = [];
    if (item.kind === "goal_paused" || item.kind === "question") parts.push(KIND_WORD[item.kind]);
    if (item.kind === "approval" && !item.body) parts.push(KIND_WORD.approval);
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
        <>
          <RowButton disabled={Boolean(pending)} onClick={() => decide(item, "reject")}>
            <XIcon />
            {pending === "reject" ? "Denying…" : "Deny"}
          </RowButton>
          <RowButton disabled={Boolean(pending)} onClick={() => decide(item, "approve")}>
            <CheckIcon />
            {pending === "approve" ? "Approving…" : "Approve"}
          </RowButton>
        </>
      );
    }
    if (item.kind === "question") {
      if (item.choices.length > 0) {
        return item.choices.map((choice) => (
          <RowButton
            key={choice.id}
            disabled={Boolean(pending)}
            onClick={() => choose(item, choice)}
          >
            {pending === `choice:${choice.id}` ? "Sending…" : choice.label}
          </RowButton>
        ));
      }
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
      <InboxRow
        key={item.id}
        kind={item.kind}
        unread={item.kind === "notification" && unread}
        title={item.title}
        body={description(item)}
        meta={meta(item)}
        when={item.updatedAt}
        actions={control(item)}
        onOpen={() => openSession(item)}
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

  const personal = hasInbox(context.accessContext);
  let body: ReactNode;
  if (!personal) {
    body = (
      <EmptyState
        variant="page"
        icon={<InboxIcon />}
        title="Only people have an inbox"
        description="Sign in as yourself to see what your agents are waiting on you for. API keys and services act through sessions instead."
      />
    );
  } else if (inbox.loading && !inbox.data) {
    body = <InboxSkeleton />;
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
      <SectionStack>
        {needsYou.length > 0 ? (
          <Section title="Needs you">
            <InboxList label="Needs you">{needsYou.map(row)}</InboxList>
          </Section>
        ) : null}
        {fromAgents.length > 0 ? (
          <Section title="From your agents">
            <InboxList label="From your agents">{fromAgents.map(row)}</InboxList>
          </Section>
        ) : null}
        {awake.length === 0 ? (
          <p className="text-sm text-fg-muted">
            Nothing needs you right now. Snoozed items come back on their own.
          </p>
        ) : null}
        {snoozed.length > 0 ? (
          <div>
            <Disclosure title="Snoozed" summary={String(snoozed.length)}>
              <InboxList label="Snoozed">{snoozed.map(row)}</InboxList>
            </Disclosure>
          </div>
        ) : null}
      </SectionStack>
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
          <SectionStack>
            {body}
            {personal ? <InboxSettingsSections /> : null}
          </SectionStack>
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

/**
 * The person's inbox settings. Paused goals are off by default: a goal the
 * agent paused usually reads like its reply, and the reply is already in the
 * session. The tidy policy decides which agents may remove items; answering
 * and approving stay with the person either way.
 */
function InboxSettingsSections() {
  const context = useAppContext();
  const [settings, setSettings] = useState<InboxSettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let current = true;
    void context.client
      .getInboxSettings()
      .then((loaded) => {
        if (current) setSettings(loaded);
      })
      .catch(() => {
        if (current) setSettings({ tidyPolicy: "own_sessions", pausedGoals: false });
      });
    return () => {
      current = false;
    };
  }, [context.client]);

  const change = async (next: Partial<InboxSettings>) => {
    const previous = settings;
    if (previous) setSettings({ ...previous, ...next });
    setSaving(true);
    try {
      setSettings(await context.client.updateInboxSettings(next));
    } catch (error) {
      setSettings(previous);
      toast.error(userErrorText(error, "Couldn't save that. Try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Section title="What reaches your inbox">
        {settings === null ? (
          <div className="grid gap-3 pt-1" aria-busy="true">
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : (
          <SettingRowGroup>
            <SettingRow
              label="Paused goals"
              description="When an agent pauses a goal it's working on for you. Off keeps them in their sessions only."
              control={
                <Switch
                  checked={settings.pausedGoals}
                  pending={saving}
                  onCheckedChange={(checked) => void change({ pausedGoals: checked })}
                />
              }
            />
          </SettingRowGroup>
        )}
      </Section>
      <Section
        title="Who can tidy your inbox"
        description="Agents never answer or approve for you. This only decides who may remove items."
      >
        {settings === null ? (
          <div className="grid gap-3 pt-1" aria-busy="true">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : (
          <ChoiceCards
            variant="list"
            aria-label="Who can tidy your inbox"
            value={settings.tidyPolicy}
            disabled={saving}
            onValueChange={(value) => void change({ tidyPolicy: value as InboxTidyPolicy })}
          >
            <ChoiceCard
              value="own_sessions"
              title="The agent that posted it"
              description="Or the sessions that started that agent."
            />
            <ChoiceCard
              value="any_agent"
              title="Any agent working for you"
              description="Lets one agent look after your inbox and clear what's done."
            />
          </ChoiceCards>
        )}
      </Section>
    </>
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
