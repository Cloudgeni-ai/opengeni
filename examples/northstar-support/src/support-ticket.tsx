import {
  ActivityIcon,
  Building2Icon,
  CalendarClockIcon,
  CheckCircle2Icon,
  CircleUserRoundIcon,
  Clock3Icon,
  MailIcon,
  RotateCcwIcon,
  SparklesIcon,
  TagIcon,
  UsersIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { SupportDemoState, SupportDomainEvent, TicketPriority, TicketStatus } from "./types";

const priorityLabel: Record<TicketPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

const statusLabel: Record<TicketStatus, string> = {
  open: "Open",
  investigating: "Investigating",
  waiting_on_customer: "Waiting on customer",
  resolved: "Resolved",
};

function relativeTime(value: string): string {
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60_000);
  if (Math.abs(minutes) < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-black/[0.055] bg-white/80 px-4 py-3 shadow-[0_1px_2px_rgba(31,35,48,0.03)]">
      <div className="text-[11px] font-medium text-[#8b8f9b]">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-[#242631]">{value}</div>
    </div>
  );
}

export function SupportTicketView({
  state,
  lastEvent,
  onReset,
}: {
  state: SupportDemoState;
  lastEvent: SupportDomainEvent | null;
  onReset: () => Promise<void>;
}) {
  const { ticket, customer } = state;
  const failureRate = Math.round(
    (customer.recentUsage.failedExportsLast7Days / customer.recentUsage.exportsLast30Days) * 100,
  );

  return (
    <article className="flex h-full min-h-0 flex-col bg-[#f7f7f9] text-[#242631]">
      <header className="shrink-0 border-b border-black/[0.06] bg-white px-7 py-5 max-sm:px-4">
        <div className="flex items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium text-[#888c98]">
              <span>Support</span>
              <span className="text-[#c4c6cd]">/</span>
              <span>{ticket.id}</span>
            </div>
            <h1 className="mt-2 truncate text-[22px] font-semibold tracking-[-0.025em] text-[#20222b]">
              {ticket.subject}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <motion.span
                key={ticket.status}
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#eef0ff] px-2.5 py-1 text-[11px] font-semibold text-[#5653cf]"
              >
                <span className="size-1.5 rounded-full bg-[#6965e8]" />
                {statusLabel[ticket.status]}
              </motion.span>
              <motion.span
                key={ticket.priority}
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className={
                  ticket.priority === "urgent"
                    ? "rounded-full bg-[#fff0ed] px-2.5 py-1 text-[11px] font-semibold text-[#c34b36]"
                    : "rounded-full bg-[#f1f2f4] px-2.5 py-1 text-[11px] font-semibold text-[#686c77]"
                }
              >
                {priorityLabel[ticket.priority]} priority
              </motion.span>
              {ticket.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full border border-black/[0.07] bg-white px-2.5 py-1 text-[11px] text-[#737782]"
                >
                  <TagIcon className="size-3" />
                  {tag}
                </span>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void onReset()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs font-medium text-[#666a75] shadow-sm transition hover:border-black/[0.14] hover:text-[#30323b]"
          >
            <RotateCcwIcon className="size-3.5" /> Reset demo
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence>
          {lastEvent ? (
            <motion.div
              key={lastEvent.id}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mx-7 mt-5 flex items-center gap-2 rounded-xl border border-[#cfe9de] bg-[#effaf5] px-3.5 py-2.5 text-xs font-medium text-[#237455] max-sm:mx-4"
              role="status"
            >
              <CheckCircle2Icon className="size-4" />
              Live product update · {lastEvent.summary}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="grid gap-5 p-7 max-sm:p-4 xl:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-5">
            <section className="overflow-hidden rounded-[20px] border border-black/[0.06] bg-white shadow-[0_1px_3px_rgba(28,31,42,0.04)]">
              <div className="flex items-center justify-between border-b border-black/[0.055] px-5 py-4">
                <div className="flex items-center gap-3">
                  <div className="grid size-9 place-items-center rounded-full bg-[#e9f1ff] text-xs font-bold text-[#486d9e]">
                    NL
                  </div>
                  <div>
                    <div className="text-sm font-semibold">Nora Lind</div>
                    <div className="mt-0.5 text-[11px] text-[#9599a3]">
                      {customer.primaryContact.role} · {relativeTime(ticket.createdAt)}
                    </div>
                  </div>
                </div>
                <MailIcon className="size-4 text-[#a3a6ae]" />
              </div>
              <div className="px-5 py-5 text-[14px] leading-7 text-[#4e515c]">{ticket.body}</div>
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-[0.09em] text-[#858995]">
                  Internal notes
                </h2>
                <span className="text-[11px] text-[#a0a3ac]">{ticket.notes.length} notes</span>
              </div>
              <div className="space-y-3">
                {ticket.notes.map((note) => (
                  <motion.div
                    layout
                    key={note.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={
                      note.authorKind === "agent"
                        ? "rounded-[18px] border border-[#dcdcff] bg-[#f4f4ff] p-4"
                        : "rounded-[18px] border border-black/[0.06] bg-white p-4"
                    }
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2 text-xs font-semibold">
                        {note.authorKind === "agent" ? (
                          <SparklesIcon className="size-3.5 text-[#6561dc]" />
                        ) : (
                          <CircleUserRoundIcon className="size-3.5 text-[#8c909b]" />
                        )}
                        {note.author}
                      </div>
                      <time className="text-[10px] text-[#9a9da6]">
                        {relativeTime(note.createdAt)}
                      </time>
                    </div>
                    <p className="mt-2 text-[13px] leading-6 text-[#555965]">{note.body}</p>
                  </motion.div>
                ))}
              </div>
            </section>

            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.09em] text-[#858995]">
                Activity
              </h2>
              <div className="space-y-1">
                {ticket.activity.slice(0, 5).map((item) => (
                  <div
                    key={item.id}
                    className="flex gap-3 rounded-xl px-2 py-2.5 text-xs text-[#696d78]"
                  >
                    <ActivityIcon className="mt-0.5 size-3.5 shrink-0 text-[#9da0aa]" />
                    <p className="min-w-0 flex-1">
                      <span className="font-semibold text-[#484b55]">{item.actor}</span> ·{" "}
                      {item.summary}
                    </p>
                    <time className="shrink-0 text-[10px] text-[#a0a3ac]">
                      {relativeTime(item.createdAt)}
                    </time>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <aside className="space-y-4">
            <section className="rounded-[20px] border border-black/[0.06] bg-white p-5 shadow-[0_1px_3px_rgba(28,31,42,0.04)]">
              <div className="flex items-center gap-3">
                <div className="grid size-10 place-items-center rounded-xl bg-[#242631] text-xs font-bold text-white">
                  {customer.initials}
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold">{customer.name}</h2>
                  <p className="mt-0.5 text-[11px] text-[#92959f]">
                    {customer.plan} plan · {money(customer.arr)} ARR
                  </p>
                </div>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <Metric label="Health" value={`${customer.healthScore}/100`} />
                <Metric
                  label="Seats"
                  value={`${customer.recentUsage.activeSeats}/${customer.recentUsage.totalSeats}`}
                />
                <Metric label="Exports" value={String(customer.recentUsage.exportsLast30Days)} />
                <Metric label="Failures" value={`${failureRate}%`} />
              </div>
              <div className="mt-4 rounded-xl bg-[#fff7eb] px-3.5 py-3 text-[11px] leading-5 text-[#8a6228]">
                <span className="font-semibold">Signal:</span> 14 failed exports in 7 days,
                concentrated around month-end reporting.
              </div>
            </section>

            <section className="rounded-[20px] border border-black/[0.06] bg-white p-5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.09em] text-[#858995]">
                Details
              </h2>
              <dl className="mt-4 space-y-3.5 text-xs">
                <Detail icon={<UsersIcon />} label="Assignee" value={ticket.assignee} />
                <Detail icon={<CalendarClockIcon />} label="SLA due" value="Today, 16:42" />
                <Detail
                  icon={<Clock3Icon />}
                  label="Opened"
                  value={relativeTime(ticket.createdAt)}
                />
                <Detail icon={<Building2Icon />} label="Customer since" value="Sep 2024" />
              </dl>
            </section>
          </aside>
        </div>
      </div>
    </article>
  );
}

function Detail({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-[#a0a3ac] [&>svg]:size-3.5">{icon}</span>
      <dt className="min-w-0 flex-1 text-[#888b96]">{label}</dt>
      <dd className="max-w-[135px] truncate font-medium text-[#4a4d57]">{value}</dd>
    </div>
  );
}
