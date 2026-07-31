import {
  ActivityIcon,
  Building2Icon,
  CalendarClockIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleUserRoundIcon,
  FileTextIcon,
  MailIcon,
  MessageSquareTextIcon,
  SendIcon,
  SparklesIcon,
  TagIcon,
  UsersIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import type { SupportDemoState, SupportDomainEvent, TicketPriority, TicketStatus } from "./types";

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const monthYearFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
});

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function relativeTime(value: string): string {
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60_000);
  if (Math.abs(minutes) < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function slaLabel(value: string): string {
  const minutes = Math.round((Date.parse(value) - Date.now()) / 60_000);
  if (minutes <= 0) return `Overdue by ${Math.max(1, Math.abs(minutes))}m`;
  if (minutes < 60) return `Due in ${minutes}m`;
  return `Due in ${Math.round(minutes / 60)}h`;
}

export function SupportTicketView({
  state,
  lastEvent,
  agentEnabled,
  onUpdateTicket,
  onAddNote,
  onSendReply,
}: {
  state: SupportDemoState;
  lastEvent: SupportDomainEvent | null;
  agentEnabled: boolean;
  onUpdateTicket: (changes: { priority?: TicketPriority; status?: TicketStatus }) => Promise<void>;
  onAddNote: (body: string) => Promise<void>;
  onSendReply: (body: string) => Promise<void>;
}) {
  const { ticket } = state;
  const [updatingField, setUpdatingField] = useState<"status" | "priority" | null>(null);

  async function updateField(field: "status" | "priority", value: TicketStatus | TicketPriority) {
    setUpdatingField(field);
    try {
      await onUpdateTicket(
        field === "status"
          ? { status: value as TicketStatus }
          : { priority: value as TicketPriority },
      );
    } finally {
      setUpdatingField(null);
    }
  }

  return (
    <article className="flex min-h-0 flex-1 flex-col text-[#252c32]">
      <header className="shrink-0 border-b border-[#deded9] bg-white px-8 py-5">
        <div className={agentEnabled ? "space-y-4" : "flex items-start justify-between gap-8"}>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-medium tracking-[0.06em] text-[#8b8b85]">
              <span>{ticket.id}</span>
              <span className="text-[#c3c7ca]">·</span>
              <span>Email</span>
              <span className="text-[#c3c7ca]">·</span>
              <span>Opened {relativeTime(ticket.createdAt)}</span>
            </div>
            <h2 className="mt-2 truncate text-[27px] font-semibold tracking-[-0.04em] text-[#1e2421]">
              {ticket.subject}
            </h2>
            <div
              className={
                agentEnabled
                  ? "mt-2 flex flex-wrap items-center gap-1.5"
                  : "mt-2.5 flex flex-wrap items-center gap-1.5"
              }
            >
              {ticket.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#f2f2ef] px-2 py-1 text-[10px] font-medium text-[#747670]"
                >
                  <TagIcon className="size-2.5" />
                  {tag}
                </span>
              ))}
            </div>
          </div>

          <div
            className={
              agentEnabled
                ? "flex shrink-0 items-center gap-2 border-t border-black/[0.07] pt-4"
                : "flex shrink-0 items-center gap-2"
            }
          >
            <ControlSelect
              label="Priority"
              value={ticket.priority}
              busy={updatingField === "priority"}
              tone={ticket.priority === "urgent" ? "urgent" : "neutral"}
              options={[
                ["low", "Low priority"],
                ["normal", "Normal priority"],
                ["high", "High priority"],
                ["urgent", "Urgent priority"],
              ]}
              onChange={(value) => void updateField("priority", value as TicketPriority)}
            />
            <ControlSelect
              label="Status"
              value={ticket.status}
              busy={updatingField === "status"}
              tone="green"
              options={[
                ["open", "Open"],
                ["investigating", "Investigating"],
                ["waiting_on_customer", "Waiting on customer"],
                ["resolved", "Resolved"],
              ]}
              onChange={(value) => void updateField("status", value as TicketStatus)}
            />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence>
          {lastEvent ? (
            <motion.div
              key={lastEvent.id}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mx-8 mt-5 flex items-center gap-2.5 rounded-lg border border-[#c9dfd5] bg-[#eef6f2] px-4 py-3 text-[12px] font-medium text-[#2e715a]"
              role="status"
            >
              <CheckCircle2Icon className="size-3.5" />
              {lastEvent.summary}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <ModeBanner agentEnabled={agentEnabled} />

        <div
          className={
            agentEnabled
              ? "mx-auto grid w-full max-w-[900px] gap-6 px-8 pb-12"
              : "mx-auto grid w-full max-w-[1280px] gap-7 px-8 pb-12 xl:grid-cols-[minmax(0,1fr)_340px]"
          }
        >
          <div className="min-w-0 space-y-6">
            <Conversation state={state} />
            <ResponseComposer
              contactName={state.customer.primaryContact.name}
              subject={state.ticket.subject}
              onAddNote={onAddNote}
              onSendReply={onSendReply}
            />
            {agentEnabled ? <InternalNotes state={state} /> : null}
          </div>

          {agentEnabled ? null : (
            <aside className="h-fit space-y-0 overflow-hidden rounded-xl border border-[#dfdfda] bg-white [&>section]:rounded-none [&>section]:border-0 [&>section+section]:border-t [&>section+section]:border-[#e4e4df]">
              <CustomerContext state={state} />
              <InternalNotes state={state} />
              <ActivityLog state={state} />
            </aside>
          )}
        </div>
      </div>
    </article>
  );
}

function ModeBanner({ agentEnabled }: { agentEnabled: boolean }) {
  return (
    <div
      className={
        agentEnabled
          ? "mx-8 my-5 border-y border-[#d9d5ed] py-3.5 text-[#312d43]"
          : "mx-8 my-5 border-y border-[#d8dcd9] py-3.5 text-[#29332f]"
      }
    >
      <div className={agentEnabled ? "relative" : "relative flex items-center gap-5"}>
        <div className={agentEnabled ? "flex items-center gap-3" : "contents"}>
          <div
            className={
              agentEnabled
                ? "grid size-7 shrink-0 place-items-center text-[#6658cb]"
                : "grid size-7 shrink-0 place-items-center text-[#4b7666]"
            }
          >
            {agentEnabled ? (
              <SparklesIcon className="size-5" />
            ) : (
              <CircleUserRoundIcon className="size-5" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold">
              {agentEnabled ? "Agent-assisted workflow" : "Human-led workflow"}
            </p>
            <p className="mt-0.5 text-[11px] text-[#85857f]">
              {agentEnabled
                ? "OpenGeni can read and update this case through your product tools."
                : "Maya reviews the customer context and takes each action manually."}
            </p>
          </div>
        </div>
        <div
          className={
            agentEnabled
              ? "mt-3 flex items-center gap-2 text-[10px] font-medium text-[#77728d]"
              : "flex items-center gap-2 text-[10px] font-medium text-[#7f827e]"
          }
        >
          {[
            agentEnabled ? "Agent reads" : "You read",
            agentEnabled ? "Agent reasons" : "You decide",
            agentEnabled ? "Tools act" : "You act",
          ].map((step, index) => (
            <div key={step} className="flex items-center gap-2">
              {index > 0 ? <span className="text-[#b6b6b0]">→</span> : null}
              <span>{step}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Conversation({ state }: { state: SupportDemoState }) {
  const { ticket, customer } = state;
  return (
    <section className="overflow-hidden rounded-xl border border-[#dfdfda] bg-white">
      <div className="flex items-center justify-between border-b border-black/[0.07] px-6 py-4.5">
        <div className="flex items-center gap-2">
          <MessageSquareTextIcon className="size-3.5 text-[#6f787f]" />
          <h3 className="text-[13px] font-semibold text-[#343b37]">Conversation</h3>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-[#94958f]">
          <MailIcon className="size-3" /> Email thread
        </span>
      </div>
      <div className="p-6">
        <div className="flex gap-4">
          <div className="grid size-11 shrink-0 place-items-center rounded-full bg-[#e4edf5] text-[11px] font-bold text-[#4e6a89]">
            {initials(customer.primaryContact.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[13px] font-semibold text-[#303733]">
                  {customer.primaryContact.name}
                </p>
                <p className="mt-0.5 text-[11px] text-[#94958f]">{customer.primaryContact.email}</p>
              </div>
              <time className="text-[11px] text-[#a09f99]">{relativeTime(ticket.createdAt)}</time>
            </div>
            <p className="mt-4 max-w-2xl text-[15px] leading-7 text-[#4e5651]">{ticket.body}</p>
          </div>
        </div>

        {ticket.replies.map((reply) => (
          <motion.div
            layout
            key={reply.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-6 flex gap-4 border-t border-black/[0.07] pt-6"
          >
            <div className="grid size-11 shrink-0 place-items-center rounded-full bg-[#e9e2d8] text-[11px] font-bold text-[#705f4c]">
              MC
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[13px] font-semibold text-[#303733]">{reply.author}</p>
                  <p className="mt-0.5 text-[11px] text-[#94958f]">Northstar support</p>
                </div>
                <time className="text-[11px] text-[#a09f99]">{relativeTime(reply.createdAt)}</time>
              </div>
              <p className="mt-4 max-w-2xl text-[15px] leading-7 text-[#4e5651]">{reply.body}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

function ResponseComposer({
  contactName,
  subject,
  onAddNote,
  onSendReply,
}: {
  contactName: string;
  subject: string;
  onAddNote: (body: string) => Promise<void>;
  onSendReply: (body: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const savedReply =
    mode === "reply"
      ? `Hi ${contactName.split(" ")[0]} — I’m looking into “${subject}” now. I’ll update you shortly with what we find and the next step.`
      : `Reviewing “${subject}” alongside the customer’s account signals before taking action.`;

  async function submit() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      if (mode === "reply") {
        await onSendReply(body);
      } else {
        await onAddNote(body);
      }
      setDraft("");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-[#dcdcd7] bg-white">
      <div className="flex items-center justify-between border-b border-black/[0.07] px-5">
        <div className="flex">
          <ComposerTab label="Reply" active={mode === "reply"} onClick={() => setMode("reply")} />
          <ComposerTab
            label="Internal note"
            active={mode === "note"}
            onClick={() => setMode("note")}
          />
        </div>
        <button
          type="button"
          onClick={() => setDraft(savedReply)}
          className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-[11px] font-semibold text-[#7d7d76] transition hover:bg-black/[0.04] hover:text-[#434a46]"
        >
          <FileTextIcon className="size-3" />
          Use saved template
        </button>
      </div>
      <div className={mode === "note" ? "bg-[#fffaf0] p-5" : "p-5"}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          aria-label={mode === "reply" ? "Reply to customer" : "Internal note"}
          placeholder={
            mode === "reply"
              ? `Write a reply to ${contactName.split(" ")[0]}…`
              : "Add context only your team can see…"
          }
          className="w-full resize-none bg-transparent text-[14px] leading-7 text-[#3f4743] outline-none placeholder:text-[#9f9f98]"
        />
        <div className="mt-4 flex items-center justify-between border-t border-black/[0.07] pt-4">
          <p className="text-[11px] text-[#92928b]">
            {mode === "reply" ? `Sends by email to ${contactName}` : "Visible only to your team"}
          </p>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!draft.trim() || sending}
            className={
              mode === "reply"
                ? "inline-flex items-center gap-2 rounded-[13px] bg-[#236f5c] px-4 py-2.5 text-[12px] font-semibold text-white shadow-sm transition hover:bg-[#1b604f] disabled:cursor-not-allowed disabled:opacity-40"
                : "inline-flex items-center gap-2 rounded-[13px] bg-[#806a36] px-4 py-2.5 text-[12px] font-semibold text-white shadow-sm transition hover:bg-[#6e5a2d] disabled:cursor-not-allowed disabled:opacity-40"
            }
          >
            <SendIcon className="size-3" />
            {sending ? "Saving…" : mode === "reply" ? "Send reply" : "Add note"}
          </button>
        </div>
      </div>
    </section>
  );
}

function ComposerTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "border-b-2 border-[#2d7562] px-3 py-4 text-[12px] font-semibold text-[#2d6657]"
          : "border-b-2 border-transparent px-3 py-4 text-[12px] font-medium text-[#8d8e87] transition hover:text-[#59605c]"
      }
    >
      {label}
    </button>
  );
}

function CustomerContext({ state }: { state: SupportDemoState }) {
  const { customer, ticket } = state;
  const failureRate = Math.round(
    (customer.recentUsage.failedExportsLast7Days / customer.recentUsage.exportsLast30Days) * 100,
  );
  const failedExports = customer.recentUsage.failedExportsLast7Days;
  return (
    <section className="rounded-xl border border-[#dfdfda] bg-white p-5">
      <div className="flex items-center gap-3">
        <div className="grid size-11 place-items-center rounded-lg bg-[#1d2925] text-[10px] font-bold text-white">
          {customer.initials}
        </div>
        <div className="min-w-0">
          <h3 className="truncate text-[14px] font-semibold text-[#303733]">{customer.name}</h3>
          <p className="mt-1 text-[11px] text-[#92928b]">
            {customer.plan} · {moneyFormatter.format(customer.arr)} ARR
          </p>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2.5">
        <Metric label="Health" value={`${customer.healthScore}/100`} />
        <Metric
          label="Seats"
          value={`${customer.recentUsage.activeSeats}/${customer.recentUsage.totalSeats}`}
        />
        <Metric label="Exports" value={String(customer.recentUsage.exportsLast30Days)} />
        <Metric label="Failures" value={`${failureRate}%`} tone="warning" />
      </div>
      <div
        className={
          failedExports > 5
            ? "mt-4 border-l-2 border-[#d8a34c] bg-[#fff9ee] px-3.5 py-3 text-[11px] leading-5 text-[#86612d]"
            : "mt-4 border-l-2 border-[#6a9b87] bg-[#f3f7f5] px-3.5 py-3 text-[11px] leading-5 text-[#467361]"
        }
      >
        <span className="font-semibold">Account signal:</span>{" "}
        {failedExports > 0
          ? `${failedExports} failed ${failedExports === 1 ? "export" : "exports"} in the last 7 days across ${customer.recentUsage.exportsLast30Days} monthly exports.`
          : `No failed exports in the last 7 days across ${customer.recentUsage.exportsLast30Days} monthly exports.`}
      </div>
      <dl className="mt-5 space-y-3.5 border-t border-black/[0.07] pt-5">
        <Detail icon={<UsersIcon />} label="Assignee" value={ticket.assignee} />
        <Detail icon={<CalendarClockIcon />} label="SLA" value={slaLabel(ticket.slaDueAt)} />
        <Detail
          icon={<Building2Icon />}
          label="Customer since"
          value={monthYearFormatter.format(new Date(customer.joinedAt))}
        />
      </dl>
    </section>
  );
}

function InternalNotes({ state }: { state: SupportDemoState }) {
  return (
    <section className="rounded-xl border border-[#dfdfda] bg-white p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#85877f]">
          Internal notes
        </h3>
        <span className="text-[9px] text-[#a1a7ac]">{state.ticket.notes.length}</span>
      </div>
      <div className="mt-3 space-y-3">
        {state.ticket.notes.map((note) => (
          <motion.div
            layout
            key={note.id}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            className={
              note.authorKind === "agent"
                ? "border-l-2 border-[#776bd5] bg-[#f7f6fc] p-3.5"
                : "border-l-2 border-[#d5d5d0] bg-[#f7f7f5] p-3.5"
            }
          >
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#525954]">
                {note.authorKind === "agent" ? (
                  <SparklesIcon className="size-3 text-[#6b5ed3]" />
                ) : (
                  <CircleUserRoundIcon className="size-3 text-[#818990]" />
                )}
                {note.author}
              </span>
              <time className="text-[10px] text-[#a19f99]">{relativeTime(note.createdAt)}</time>
            </div>
            <p className="mt-2 text-[12px] leading-5 text-[#626964]">{note.body}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

function ActivityLog({ state }: { state: SupportDemoState }) {
  return (
    <section className="rounded-xl border border-[#dfdfda] bg-white p-5">
      <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#85877f]">Activity</h3>
      <div className="mt-3 space-y-1">
        {state.ticket.activity.slice(0, 4).map((item) => (
          <div key={item.id} className="flex gap-2.5 py-2.5 text-[11px] text-[#737872]">
            <ActivityIcon className="mt-0.5 size-3 shrink-0 text-[#a0a6ab]" />
            <p className="min-w-0 flex-1 leading-4">
              <span className="font-semibold text-[#515960]">{item.actor}</span> · {item.summary}
            </p>
            <time className="shrink-0 text-[9px] text-[#a5aaaf]">
              {relativeTime(item.createdAt)}
            </time>
          </div>
        ))}
      </div>
    </section>
  );
}

function ControlSelect({
  label,
  value,
  busy,
  tone,
  options,
  onChange,
}: {
  label: string;
  value: string;
  busy: boolean;
  tone: "neutral" | "urgent" | "green";
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string) => void;
}) {
  const toneClass =
    tone === "urgent"
      ? "border-[#f0d5cc] bg-[#fff5f1] text-[#a8523b]"
      : tone === "green"
        ? "border-[#d5e5df] bg-[#f3f8f6] text-[#346d5d]"
        : "border-[#e0e4e7] bg-white text-[#5e666d]";
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        className={`h-11 appearance-none rounded-[13px] border py-0 pl-3.5 pr-9 text-[11px] font-semibold outline-none transition focus:ring-2 focus:ring-[#6d60d2]/20 ${toneClass}`}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 size-3 -translate-y-1/2 opacity-60" />
    </label>
  );
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warning";
}) {
  return (
    <div className="border-t border-[#e5e5e1] px-0 py-3">
      <div className="text-[10px] font-semibold text-[#92928b]">{label}</div>
      <div
        className={
          tone === "warning"
            ? "mt-1 text-[14px] font-semibold text-[#b0673e]"
            : "mt-1 text-[14px] font-semibold text-[#3d4540]"
        }
      >
        {value}
      </div>
    </div>
  );
}

function Detail({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5 text-[11px]">
      <span className="text-[#9ba2a8] [&>svg]:size-3">{icon}</span>
      <dt className="min-w-0 flex-1 text-[#8b9298]">{label}</dt>
      <dd className="max-w-[125px] truncate font-medium text-[#555e65]">{value}</dd>
    </div>
  );
}
