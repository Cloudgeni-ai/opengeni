import { CheckIcon, ChevronDownIcon } from "lucide-react";
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

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function sla(value: string): { label: string; overdue: boolean } {
  const minutes = Math.round((Date.parse(value) - Date.now()) / 60_000);
  if (minutes <= 0)
    return { label: `Overdue by ${duration(Math.max(1, -minutes))}`, overdue: true };
  return { label: `Due in ${duration(minutes)}`, overdue: false };
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
  const due = sla(ticket.slaDueAt);

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
    <article className="flex min-h-0 flex-1 flex-col text-ns-ink">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={
            agentEnabled
              ? "mx-auto grid w-full max-w-[820px] gap-10 px-8 pb-16 pt-8"
              : "mx-auto grid w-full max-w-[1180px] gap-12 px-10 pb-16 pt-9 xl:grid-cols-[minmax(0,1fr)_300px]"
          }
        >
          <div className="min-w-0">
            <header>
              <h2 className="text-[30px] font-semibold leading-[1.15] tracking-[-0.03em] text-ns-ink">
                {ticket.subject}
              </h2>
              <p className="mt-2 text-[14px] text-ns-muted">
                Opened by email {relativeTime(ticket.createdAt)}
                {ticket.tags.length > 0 ? (
                  <>
                    , tagged{" "}
                    {ticket.tags.map((tag, index) => (
                      <span key={tag}>
                        {index > 0 ? (index === ticket.tags.length - 1 ? " and " : ", ") : null}
                        <span className="text-ns-ink">{tag}</span>
                      </span>
                    ))}
                  </>
                ) : null}
              </p>

              <dl className="mt-6 flex flex-wrap items-end gap-x-8 gap-y-4 border-y border-ns-line py-4">
                <Property label="Priority">
                  <ControlSelect
                    label="Priority"
                    value={ticket.priority}
                    busy={updatingField === "priority"}
                    changed={lastEvent?.summary.toLowerCase().includes("priority") ?? false}
                    options={[
                      ["low", "Low"],
                      ["normal", "Normal"],
                      ["high", "High"],
                      ["urgent", "Urgent"],
                    ]}
                    onChange={(value) => void updateField("priority", value as TicketPriority)}
                  />
                </Property>
                <Property label="Status">
                  <ControlSelect
                    label="Status"
                    value={ticket.status}
                    busy={updatingField === "status"}
                    changed={lastEvent?.summary.toLowerCase().includes("status") ?? false}
                    options={[
                      ["open", "Open"],
                      ["investigating", "Investigating"],
                      ["waiting_on_customer", "Waiting on customer"],
                      ["resolved", "Resolved"],
                    ]}
                    onChange={(value) => void updateField("status", value as TicketStatus)}
                  />
                </Property>
                <Property label="Assignee">
                  <span className="text-[14px] font-medium">{ticket.assignee}</span>
                </Property>
                <Property label="Response SLA">
                  <span
                    className={
                      due.overdue
                        ? "text-[14px] font-medium text-ns-alert"
                        : "text-[14px] font-medium"
                    }
                  >
                    {due.label}
                  </span>
                </Property>
              </dl>

              <AnimatePresence>
                {lastEvent ? (
                  <motion.p
                    key={lastEvent.id}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="mt-3 flex items-center gap-2 text-[13px] font-medium text-ns-ok"
                    role="status"
                  >
                    <CheckIcon className="size-3.5" />
                    {lastEvent.summary}
                  </motion.p>
                ) : null}
              </AnimatePresence>
            </header>

            <div className="mt-8 space-y-8">
              <Conversation state={state} />
              <ResponseComposer
                contactName={state.customer.primaryContact.name}
                subject={state.ticket.subject}
                onAddNote={onAddNote}
                onSendReply={onSendReply}
              />
              {agentEnabled ? <InternalNotes state={state} /> : null}
            </div>
          </div>

          {agentEnabled ? null : (
            <aside className="h-fit space-y-9 xl:sticky xl:top-9">
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

function Property({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-ns-subtle">{label}</dt>
      <dd className="mt-1 flex h-8 items-center">{children}</dd>
    </div>
  );
}

function Conversation({ state }: { state: SupportDemoState }) {
  const { ticket, customer } = state;
  return (
    <section aria-label="Conversation" className="space-y-7">
      <Message
        initialsText={initials(customer.primaryContact.name)}
        tone="customer"
        name={customer.primaryContact.name}
        detail={customer.primaryContact.email}
        time={relativeTime(ticket.createdAt)}
        body={ticket.body}
      />
      {ticket.replies.map((reply) => (
        <motion.div
          layout
          key={reply.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="border-t border-ns-line pt-7"
        >
          <Message
            initialsText={initials(reply.author)}
            tone="team"
            name={reply.author}
            detail="Northstar support"
            time={relativeTime(reply.createdAt)}
            body={reply.body}
          />
        </motion.div>
      ))}
    </section>
  );
}

function Message({
  initialsText,
  tone,
  name,
  detail,
  time,
  body,
}: {
  initialsText: string;
  tone: "customer" | "team";
  name: string;
  detail: string;
  time: string;
  body: string;
}) {
  return (
    <div className="flex gap-4">
      <div
        className={
          tone === "customer"
            ? "grid size-9 shrink-0 place-items-center rounded-full bg-ns-navy-tint text-[12px] font-semibold text-ns-navy"
            : "grid size-9 shrink-0 place-items-center rounded-full bg-[#d9cdbd] text-[12px] font-semibold text-[#4d4134]"
        }
      >
        {initialsText}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="text-[14px] font-semibold">{name}</p>
          <p className="min-w-0 truncate text-[13px] text-ns-subtle">{detail}</p>
          <time className="ml-auto shrink-0 text-[13px] text-ns-subtle">{time}</time>
        </div>
        <p className="mt-2 max-w-[62ch] text-[16px] leading-[1.65] text-ns-ink">{body}</p>
      </div>
    </div>
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
  const firstName = contactName.split(" ")[0];

  const savedReply =
    mode === "reply"
      ? `Hi ${firstName}, I’m looking into “${subject}” now. I’ll update you shortly with what we find and the next step.`
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
    <section
      className={
        mode === "note"
          ? "rounded-lg border border-[#ecd9ad] bg-ns-note transition-colors focus-within:border-[#c9a24f]"
          : "rounded-lg border border-ns-line-strong bg-ns-sheet transition-colors focus-within:border-ns-navy"
      }
    >
      <div className="flex items-center gap-1 px-3 pt-2">
        <ComposerTab label="Reply" active={mode === "reply"} onClick={() => setMode("reply")} />
        <ComposerTab
          label="Internal note"
          active={mode === "note"}
          onClick={() => setMode("note")}
        />
        <button
          type="button"
          onClick={() => setDraft(savedReply)}
          className="ml-auto rounded-md px-2.5 py-1.5 text-[13px] font-medium text-ns-muted transition-colors hover:bg-black/[0.04] hover:text-ns-ink"
        >
          Insert template
        </button>
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={3}
        aria-label={mode === "reply" ? "Reply to customer" : "Internal note"}
        placeholder={
          mode === "reply" ? `Write to ${firstName}` : "Write a note only your team can see"
        }
        className="block w-full resize-none bg-transparent px-5 py-3 text-[15px] leading-[1.6] text-ns-ink outline-none placeholder:text-ns-subtle"
      />
      <div className="flex items-center justify-between gap-4 px-4 pb-3">
        <p className="text-[12px] text-ns-muted">
          {mode === "reply" ? `Emails ${contactName}` : "Only your team sees notes"}
        </p>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!draft.trim() || sending}
          className="h-9 rounded-md bg-ns-navy px-4 text-[13px] font-semibold text-white transition-colors hover:bg-ns-navy-hover disabled:cursor-not-allowed disabled:bg-ns-line-strong disabled:text-white"
        >
          {sending ? "Saving" : mode === "reply" ? "Send reply" : "Add note"}
        </button>
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
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? "rounded-md bg-black/[0.06] px-2.5 py-1.5 text-[13px] font-semibold text-ns-ink"
          : "rounded-md px-2.5 py-1.5 text-[13px] font-medium text-ns-muted transition-colors hover:text-ns-ink"
      }
    >
      {label}
    </button>
  );
}

function CustomerContext({ state }: { state: SupportDemoState }) {
  const { customer } = state;
  const failureRate = Math.round(
    (customer.recentUsage.failedExportsLast7Days / customer.recentUsage.exportsLast30Days) * 100,
  );
  const failedExports = customer.recentUsage.failedExportsLast7Days;
  return (
    <section aria-labelledby="customer-heading">
      <h3 id="customer-heading" className="text-[16px] font-semibold tracking-[-0.01em]">
        {customer.name}
      </h3>
      <p className="mt-1 text-[13px] text-ns-muted">
        {customer.plan} plan, {moneyFormatter.format(customer.arr)} a year, customer since{" "}
        {monthYearFormatter.format(new Date(customer.joinedAt))}
      </p>
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4">
        <Metric label="Health score" value={String(customer.healthScore)} unit="/100" />
        <Metric
          label="Active seats"
          value={String(customer.recentUsage.activeSeats)}
          unit={`/${customer.recentUsage.totalSeats}`}
        />
        <Metric label="Exports, 30 days" value={String(customer.recentUsage.exportsLast30Days)} />
        <Metric
          label="Export failures"
          value={`${failureRate}%`}
          tone={failedExports > 5 ? "warning" : "default"}
        />
      </dl>
      <p
        className={
          failedExports > 5
            ? "mt-5 border-l-2 border-ns-star pl-3 text-[13px] leading-5 text-ns-ink"
            : "mt-5 border-l-2 border-ns-ok pl-3 text-[13px] leading-5 text-ns-ink"
        }
      >
        {failedExports > 0
          ? `${failedExports} failed ${failedExports === 1 ? "export" : "exports"} in the last 7 days.`
          : "No failed exports in the last 7 days."}
      </p>
    </section>
  );
}

function InternalNotes({ state }: { state: SupportDemoState }) {
  const notes = state.ticket.notes;
  return (
    <section aria-labelledby="notes-heading">
      <h3 id="notes-heading" className="text-[14px] font-semibold">
        Internal notes <span className="font-normal text-ns-subtle">{notes.length}</span>
      </h3>
      {notes.length === 0 ? (
        <p className="mt-2 text-[13px] text-ns-muted">No notes yet.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {notes.map((note) => (
            <motion.li
              layout
              key={note.id}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              className={
                note.authorKind === "agent"
                  ? "rounded-md border border-og-aqua bg-[#f2fbf8] px-3.5 py-3"
                  : "rounded-md bg-ns-note px-3.5 py-3"
              }
            >
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={
                    note.authorKind === "agent"
                      ? "inline-flex items-center gap-1.5 text-[13px] font-semibold text-og-green"
                      : "text-[13px] font-semibold"
                  }
                >
                  {note.authorKind === "agent" ? <OpengeniGlyph className="size-3.5" /> : null}
                  {note.authorKind === "agent" ? "Opengeni" : note.author}
                </span>
                <time className="text-[12px] text-ns-subtle">{relativeTime(note.createdAt)}</time>
              </div>
              <p className="mt-1.5 text-[13px] leading-[1.55] text-ns-ink">{note.body}</p>
            </motion.li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityLog({ state }: { state: SupportDemoState }) {
  return (
    <section aria-labelledby="activity-heading">
      <h3 id="activity-heading" className="text-[14px] font-semibold">
        Activity
      </h3>
      <ol className="mt-3 border-l border-ns-line">
        {state.ticket.activity.slice(0, 4).map((item) => (
          <li key={item.id} className="relative pb-3 pl-4 last:pb-0">
            <span className="absolute -left-[3.5px] top-[7px] size-[6px] rounded-full bg-ns-line-strong" />
            <p className="text-[13px] leading-5 text-ns-ink">{item.summary}</p>
            <p className="text-[12px] text-ns-subtle">
              {item.actor}, <time>{relativeTime(item.createdAt)}</time>
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function OpengeniGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="71 17 184 184" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        d="M251 83.5966L207 109L163 83.5966L119 109L75 83.5966L141 45.4915A44 44 0 0 1 185 45.4915ZM185.25 172.3642A44.5 44.5 0 0 1 140.75 172.3642L75 134.4034L119 109L163 134.4034L207 109L251 134.4034Z"
      />
    </svg>
  );
}

function ControlSelect({
  label,
  value,
  busy,
  changed,
  options,
  onChange,
}: {
  label: string;
  value: string;
  busy: boolean;
  changed: boolean;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative -ml-2 inline-flex">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        className={
          changed
            ? "h-8 appearance-none rounded-md [field-sizing:content] bg-[#e6f6f1] py-0 pl-2 pr-7 text-[14px] font-medium text-ns-ink outline-none ring-1 ring-og-aqua transition-colors"
            : "h-8 appearance-none rounded-md [field-sizing:content] bg-transparent py-0 pl-2 pr-7 text-[14px] font-medium text-ns-ink outline-none transition-colors hover:bg-black/[0.04]"
        }
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-ns-subtle" />
    </label>
  );
}

function Metric({
  label,
  value,
  unit,
  tone = "default",
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "default" | "warning";
}) {
  return (
    <div>
      <dt className="text-[12px] text-ns-subtle">{label}</dt>
      <dd
        className={
          tone === "warning"
            ? "mt-0.5 text-[20px] font-semibold tabular-nums tracking-[-0.02em] text-[#9a6206]"
            : "mt-0.5 text-[20px] font-semibold tabular-nums tracking-[-0.02em]"
        }
      >
        {value}
        {unit ? <span className="text-[13px] font-normal text-ns-subtle">{unit}</span> : null}
      </dd>
    </div>
  );
}
