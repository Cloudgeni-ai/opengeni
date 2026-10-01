import { useState, type ReactNode } from "react";
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

import { Button } from "@/components/ui/button";
import { DiffView } from "@/components/ui/diff-view";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, TextArea } from "@/components/ui/field";
import { HelpLink, InlineHelp } from "@/components/ui/inline-help";
import { ListRow, ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";

import type { ReviewKind } from "../../fixtures";
import { useElementWidth } from "./frame";
import type { ReviewEntry } from "./knowledge-data";
import type { PagePicks } from "./picks";

/* ----------------------------------------------------------------------------
   Review tab: agent-proposed changes grouped by the chat or schedule that
   made them, one DiffView for knowledge, instructions and skills, and
   Approve and next. On narrow widths the list and the change take turns.
   -------------------------------------------------------------------------- */

const KIND_ICON: Record<ReviewKind, LucideIcon> = {
  knowledge: BookOpenIcon,
  instruction: ScrollTextIcon,
  skill: WandSparklesIcon,
};

interface Group {
  key: string;
  origin: ReviewEntry["origin"];
  items: ReviewEntry[];
}

function groupByOrigin(items: ReviewEntry[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const key = `${item.origin.kind}:${item.origin.name}`;
    const group = groups.find((each) => each.key === key);
    if (group) group.items.push(item);
    else groups.push({ key, origin: item.origin, items: [item] });
  }
  return groups;
}

function OriginLink({
  origin,
  inline = false,
}: {
  origin: ReviewEntry["origin"];
  inline?: boolean;
}) {
  if (inline) {
    return (
      <>
        {origin.kind}{" "}
        <a
          href={`#${origin.kind}`}
          onClick={(event) => event.preventDefault()}
          className="rounded-[4px] font-medium text-fg underline-offset-2 hover:underline"
        >
          {origin.name}
        </a>
      </>
    );
  }
  const Icon = origin.kind === "chat" ? MessageSquareIcon : CalendarClockIcon;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
      <span className="shrink-0">{origin.kind === "chat" ? "Chat" : "Schedule"}</span>
      <a
        href={`#${origin.kind}`}
        onClick={(event) => event.preventDefault()}
        className="min-w-0 truncate rounded-[4px] font-medium text-fg underline-offset-2 hover:underline"
      >
        {origin.name}
      </a>
    </span>
  );
}

export interface ReviewTabProps {
  picks: PagePicks;
  items: ReviewEntry[];
  state: "filled" | "empty" | "loading";
  onApprove: (item: ReviewEntry, editedText?: string) => void;
  onReject: (item: ReviewEntry) => void;
  /** Opens the Learning page, or points at settings (Q29). */
  learningLink: { label: string; onClick?: () => void; href?: string };
  learningLine: string;
}

export function ReviewTab({
  picks,
  items: allItems,
  state,
  onApprove,
  onReject,
  learningLink,
  learningLine,
}: ReviewTabProps) {
  const items = state === "empty" ? [] : allItems;
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);
  const [showDetail, setShowDetail] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const narrow = width > 0 && width < 760;
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  const groups = groupByOrigin(items);

  const select = (id: string) => {
    setSelectedId(id);
    setEditing(false);
    setShowDetail(true);
  };

  const next = (current: ReviewEntry) => {
    const index = items.findIndex((item) => item.id === current.id);
    const following = items[index + 1] ?? items[index - 1] ?? null;
    setSelectedId(following?.id ?? null);
    setEditing(false);
    if (!following) setShowDetail(false);
  };

  const help = (
    <InlineHelp icon>
      {learningLine}{" "}
      <HelpLink href={learningLink.href} onClick={learningLink.onClick}>
        {learningLink.label}
      </HelpLink>
    </InlineHelp>
  );

  const shell = (content: ReactNode) => (
    <div ref={ref} className="flex min-w-0 flex-col gap-4 pt-6">
      {help}
      {content}
    </div>
  );

  if (state === "loading") {
    return shell(
      <RowList label="Changes waiting for review" busy>
        <ListRowSkeleton count={3} />
      </RowList>,
    );
  }

  if (items.length === 0 || !selected) {
    return shell(
      <EmptyState
        variant={picks.empty.variant === "inline" ? "inline" : "page"}
        icon={<InboxIcon />}
        title="You're all caught up"
        description="When agents propose knowledge, instruction or skill changes, they wait here for your OK."
      />,
    );
  }

  const Icon = KIND_ICON[selected.kind];
  const list = (
    <div className="flex min-w-0 flex-col gap-5">
      {groups.map((group) => (
        <section
          key={group.key}
          aria-label={`From ${group.origin.kind} ${group.origin.name}`}
          className="min-w-0"
        >
          <p className="flex min-w-0 px-3 pb-1.5 text-xs leading-4.5 text-fg-muted">
            <OriginLink origin={group.origin} />
          </p>
          <RowList label={`Changes from ${group.origin.name}`}>
            {group.items.map((item) => {
              const ItemIcon = KIND_ICON[item.kind];
              return (
                <ListRow
                  key={item.id}
                  leading={<LogoTile icon={<ItemIcon />} name={item.kindLabel} />}
                  title={item.title}
                  meta={[item.kindLabel, item.createdLabel]}
                  selected={!narrow && item.id === selected.id}
                  onOpen={() => select(item.id)}
                  indicator={narrow ? "open" : undefined}
                />
              );
            })}
          </RowList>
        </section>
      ))}
    </div>
  );

  const approveLabel = items.length > 1 ? "Approve and next" : "Approve";
  const detail = editing ? (
    <div className="flex min-w-0 flex-col gap-4 rounded-[14px] border border-border bg-surface p-4">
      <div className="flex min-w-0 items-start gap-3">
        <LogoTile size="md" icon={<Icon />} />
        <div className="min-w-0">
          <p className="text-sm leading-5 font-semibold text-fg">Edit before approving</p>
          <p className="text-xs leading-4.5 text-fg-muted">{selected.title}</p>
        </div>
      </div>
      <Field
        label={
          selected.kind === "knowledge"
            ? "Entry text"
            : selected.kind === "skill"
              ? "Skill"
              : "Instructions"
        }
        hint="Your edit is what gets saved. The agent's version stays in the history."
        error={draftError ?? undefined}
      >
        <TextArea
          mono={selected.kind !== "knowledge"}
          rows={6}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setDraftError(null);
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setEditing(false)}
          className="pointer-coarse:h-11"
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => {
            if (!draft.trim()) {
              setDraftError("The change can't be empty. Reject it instead.");
              return;
            }
            onApprove(selected, draft.trim());
            next(selected);
          }}
          className="pointer-coarse:h-11"
        >
          <CheckIcon aria-hidden="true" />
          Save and approve
        </Button>
      </div>
    </div>
  ) : (
    <div className="flex min-w-0 flex-col gap-3">
      <DiffView
        key={selected.id}
        lines={selected.diff}
        format={selected.kind === "knowledge" ? "text" : "markdown"}
        title={selected.title}
        meta={
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <MetaChip variant="outline">{selected.kindLabel}</MetaChip>
            <span className="min-w-0">
              From <OriginLink origin={selected.origin} inline /> · {selected.createdLabel}
            </span>
          </span>
        }
      />
      {selected.kind === "skill" ? (
        <InlineHelp icon>
          Approving adds it to Skills in <HelpLink href="#capabilities">Capabilities</HelpLink>,
          where you can change it later.
        </InlineHelp>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            onReject(selected);
            next(selected);
          }}
          className="text-fg-muted pointer-coarse:h-11"
        >
          Reject
        </Button>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDraft(selected.proposed);
              setDraftError(null);
              setEditing(true);
            }}
            className="pointer-coarse:h-11"
          >
            Edit first
          </Button>
          <Button
            type="button"
            onClick={() => {
              onApprove(selected);
              next(selected);
            }}
            className="pointer-coarse:h-11"
          >
            <CheckIcon aria-hidden="true" />
            {approveLabel}
          </Button>
        </div>
      </div>
    </div>
  );

  return shell(
    narrow ? (
      showDetail ? (
        <div className="flex min-w-0 flex-col gap-3">
          <button
            type="button"
            onClick={() => setShowDetail(false)}
            className="inline-flex w-fit items-center gap-1.5 rounded-[6px] text-sm font-medium text-fg-muted transition-colors hover:text-fg pointer-coarse:min-h-11"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-4" />
            All changes ({items.length})
          </button>
          {detail}
        </div>
      ) : (
        list
      )
    ) : (
      <div className="grid min-w-0 grid-cols-[minmax(0,320px)_minmax(0,1fr)] items-start gap-6">
        {list}
        <div className="min-w-0">{detail}</div>
      </div>
    ),
  );
}
