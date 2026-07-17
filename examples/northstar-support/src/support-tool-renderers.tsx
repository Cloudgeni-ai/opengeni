import {
  Building2Icon,
  FilePenLineIcon,
  MessageSquarePlusIcon,
  TicketCheckIcon,
} from "lucide-react";
import {
  ActivityDisclosure,
  createDefaultToolRegistry,
  unwrapMcpOutput,
  type ToolRendererProps,
} from "@opengeni/react";

function argumentsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function outputOf(value: unknown): Record<string, unknown> | null {
  const { text } = unwrapMcpOutput(value);
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function SupportToolRenderer({ item }: ToolRendererProps) {
  const args = argumentsOf(item.arguments);
  const output = outputOf(item.output);
  const running = item.status === "running";
  const failed = item.status === "failed";
  const tool = item.name.split("__").at(-1) ?? item.name;

  if (tool === "get_ticket") {
    const ticket = output;
    return (
      <ActivityDisclosure
        icon={<TicketCheckIcon className="size-3.5" />}
        iconTone={failed ? "failed" : running ? "running" : "accent"}
        title="Read support ticket"
        running={running}
        failed={failed}
        preview={
          running
            ? "Loading ticket context…"
            : `${String(ticket?.id ?? args.ticketId ?? "ticket")} · ${String(ticket?.subject ?? "context loaded")}`
        }
      >
        <div className="grid grid-cols-3 gap-2 text-xs">
          <ToolMetric label="Status" value={String(ticket?.status ?? "—")} />
          <ToolMetric label="Priority" value={String(ticket?.priority ?? "—")} />
          <ToolMetric label="Assignee" value={String(ticket?.assignee ?? "—")} />
        </div>
      </ActivityDisclosure>
    );
  }

  if (tool === "get_customer") {
    const customer = output;
    const usage =
      customer?.recentUsage && typeof customer.recentUsage === "object"
        ? (customer.recentUsage as Record<string, unknown>)
        : {};
    return (
      <ActivityDisclosure
        icon={<Building2Icon className="size-3.5" />}
        iconTone={failed ? "failed" : running ? "running" : "accent"}
        title="Read customer signals"
        running={running}
        failed={failed}
        preview={
          running
            ? "Loading customer health…"
            : `${String(customer?.name ?? "Customer")} · ${String(customer?.healthScore ?? "—")}/100 health`
        }
      >
        <div className="grid grid-cols-3 gap-2 text-xs">
          <ToolMetric label="Plan" value={String(customer?.plan ?? "—")} />
          <ToolMetric label="Active seats" value={String(usage.activeSeats ?? "—")} />
          <ToolMetric label="Failed exports" value={String(usage.failedExportsLast7Days ?? "—")} />
        </div>
      </ActivityDisclosure>
    );
  }

  if (tool === "update_ticket") {
    const summary = typeof output?.summary === "string" ? output.summary : "Ticket updated";
    const awaitingResult = output === null && !failed;
    return (
      <ActivityDisclosure
        icon={<FilePenLineIcon className="size-3.5" />}
        iconTone={failed ? "failed" : running ? "running" : "accent"}
        title="Update support ticket"
        running={running}
        failed={failed}
        chip={awaitingResult ? { tone: "muted", text: "running" } : { tone: "ok", text: "synced" }}
        preview={awaitingResult ? String(args.reason ?? "Applying changes…") : summary}
      >
        <p className="text-xs leading-5 text-og-fg-muted">{String(args.reason ?? summary)}</p>
      </ActivityDisclosure>
    );
  }

  const awaitingResult = output === null && !failed;
  return (
    <ActivityDisclosure
      icon={<MessageSquarePlusIcon className="size-3.5" />}
      iconTone={failed ? "failed" : running ? "running" : "accent"}
      title="Add internal note"
      running={running}
      failed={failed}
      chip={awaitingResult ? { tone: "muted", text: "running" } : { tone: "ok", text: "added" }}
      preview={String(args.body ?? "Recording investigation context…")}
    >
      <p className="text-xs leading-5 text-og-fg-muted">{String(args.body ?? "")}</p>
    </ActivityDisclosure>
  );
}

function ToolMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-og-md bg-og-surface-2 px-2.5 py-2">
      <div className="text-[10px] text-og-fg-subtle">{label}</div>
      <div className="mt-0.5 truncate font-medium capitalize text-og-fg">
        {value.replaceAll("_", " ")}
      </div>
    </div>
  );
}

export const supportToolRegistry = createDefaultToolRegistry({
  entries: [
    {
      match: "name",
      name: "northstar_support__get_ticket",
      render: SupportToolRenderer,
    },
    {
      match: "name",
      name: "northstar_support__get_customer",
      render: SupportToolRenderer,
    },
    {
      match: "name",
      name: "northstar_support__update_ticket",
      render: SupportToolRenderer,
    },
    {
      match: "name",
      name: "northstar_support__add_internal_note",
      render: SupportToolRenderer,
    },
  ],
});
