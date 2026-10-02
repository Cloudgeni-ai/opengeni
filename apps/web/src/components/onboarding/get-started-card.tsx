import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { FirstTaskOptions } from "@/components/onboarding/first-task-options";
import { GetStartedStatusIcon } from "@/components/onboarding/get-started-status";
import { useGetStarted, type GetStartedState } from "@/components/onboarding/use-get-started";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/context";
import { analyticsAction } from "@/lib/analytics-actions";
import { nextGetStartedItem, type GetStartedItem } from "@/lib/get-started";
import { orgName } from "@/lib/org";
import { cn } from "@/lib/utils";

/**
 * The Get started checklist on the new-chat page: a compact card, one row per
 * step, until the person hides it (Undo, and Help reopens it). It stands in
 * for the starter suggestions while it shows; "Run your first task" opens the
 * three first tasks in place, and they fill the composer above.
 */
export function GetStartedCard({
  workspaceId,
  onPrefill,
}: {
  workspaceId: string;
  /** Puts a task's message in the composer above. */
  onPrefill: (text: string) => void;
}) {
  const state = useGetStarted(workspaceId);
  if (!state.journey || state.journey.checklistDismissed) return null;
  return <GetStartedCardView state={state} workspaceId={workspaceId} onPrefill={onPrefill} />;
}

function GetStartedCardView({
  state,
  workspaceId,
  onPrefill,
}: {
  state: GetStartedState;
  workspaceId: string;
  onPrefill: (text: string) => void;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const headingId = useId();
  const [tasksOpen, setTasksOpen] = useState(false);
  const { items, progress, journey } = state;
  const next = nextGetStartedItem(items);
  const finished = progress.total > 0 && progress.done === progress.total;
  const invited = journey?.invited === true;
  const organizationName = state.organizationId
    ? orgName(state.organizationId, context.accessContext.accountGrants)
    : null;

  const hide = () => {
    state.dismiss();
    toast("Get started is hidden", {
      description: "Open it again from Help & feedback.",
      action: { label: "Undo", onClick: () => state.restore() },
    });
  };

  const rowTarget = (item: GetStartedItem): RowTarget => {
    switch (item.id) {
      case "path":
        return { kind: "link", to: "/workspaces/$workspaceId/first-agent" };
      case "model":
        return state.canManageModels
          ? { kind: "link", to: "/workspaces/$workspaceId/get-started", search: { step: "model" } }
          : { kind: "none" };
      case "first_task":
        return { kind: "expand", open: tasksOpen, onClick: () => setTasksOpen((open) => !open) };
      case "playground":
        return {
          kind: "link",
          to: "/workspaces/$workspaceId/playground",
          workspaceId: state.developmentWorkspaceId ?? workspaceId,
        };
      case "github":
        return {
          kind: "link",
          to: "/workspaces/$workspaceId/get-started",
          search: { step: "github" },
        };
      case "api_key":
        return {
          kind: "link",
          to: "/workspaces/$workspaceId/get-started",
          search: { step: "product" },
          workspaceId: state.developmentWorkspaceId ?? workspaceId,
        };
      case "coding_agent":
        return {
          kind: "link",
          to: "/workspaces/$workspaceId/get-started",
          search: { step: "coding-agent" },
        };
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="og-step-in mt-10 min-w-0 rounded-[14px] border border-border bg-surface"
      data-get-started-card=""
    >
      <header className="flex min-w-0 items-start gap-3 px-5 pt-4 pb-1">
        <div className="min-w-0 flex-1">
          <h2
            id={headingId}
            className="text-base leading-6 font-semibold tracking-[-0.2px] text-fg"
          >
            {invited && organizationName ? `Welcome to ${organizationName}` : "Get started"}
          </h2>
          <div className="mt-1 flex items-center gap-2">
            <span
              aria-hidden="true"
              className="relative h-1 w-16 overflow-hidden rounded-full bg-border"
            >
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-fg-muted transition-[width] duration-200"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </span>
            <p className="text-xs text-fg-muted">
              {finished ? "All done" : `${progress.done} of ${progress.total} done`}
            </p>
          </div>
        </div>
        <Button asChild variant="ghost" size="sm" className="-mr-1 text-fg-muted">
          <Link
            to="/workspaces/$workspaceId/get-started"
            params={{ workspaceId }}
            {...analyticsAction("open_get_started")}
          >
            See all
          </Link>
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Hide Get started"
              className="-mr-2 text-fg-muted pointer-coarse:size-11"
              onClick={hide}
              {...analyticsAction("dismiss_get_started")}
            >
              <XIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Hide Get started</TooltipContent>
        </Tooltip>
      </header>
      <ul className="divide-y divide-border px-5 pb-1">
        {items.map((item) => (
          <li key={item.id} data-item={item.id}>
            <ChecklistRow
              item={item}
              next={next?.id === item.id}
              target={rowTarget(item)}
              workspaceId={workspaceId}
            >
              {item.id === "first_task" && tasksOpen ? (
                <div className="pb-4 pl-8">
                  <FirstTaskOptions
                    layout="compact"
                    onPrompt={(prompt) => {
                      setTasksOpen(false);
                      onPrefill(prompt);
                    }}
                    onSchedule={(template) =>
                      void navigate({
                        to: "/workspaces/$workspaceId/schedules/new",
                        params: { workspaceId },
                        search: { template },
                      })
                    }
                  />
                </div>
              ) : null}
            </ChecklistRow>
          </li>
        ))}
      </ul>
    </section>
  );
}

type RowTarget =
  | { kind: "expand"; open: boolean; onClick: () => void }
  | {
      kind: "link";
      to:
        | "/workspaces/$workspaceId/organization"
        | "/workspaces/$workspaceId/playground"
        | "/workspaces/$workspaceId/get-started"
        | "/workspaces/$workspaceId/first-agent";
      search?: Record<string, string>;
      workspaceId?: string;
    }
  | { kind: "none" };

const ROW_CLASS =
  "-mx-3 flex min-h-14 w-[calc(100%+1.5rem)] min-w-0 items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors duration-[120ms] outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

function ChecklistRow({
  item,
  next,
  target,
  workspaceId,
  children,
}: {
  item: GetStartedItem;
  next: boolean;
  target: RowTarget;
  workspaceId: string;
  children?: ReactNode;
}) {
  const content = (
    <>
      <GetStartedStatusIcon done={item.done} optional={item.optional} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-fg">{item.title}</span>
          {item.optional && !item.done ? (
            <span className="shrink-0 text-2xs font-medium text-fg-subtle">Optional</span>
          ) : null}
          {next ? <span className="sr-only">(next step)</span> : null}
        </span>
        <span className="mt-0.5 block truncate text-xs text-fg-muted">{item.description}</span>
      </span>
      {target.kind === "link" ? (
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
      ) : target.kind === "expand" ? (
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-fg-subtle transition-transform duration-[120ms]",
            target.open && "rotate-180",
          )}
        />
      ) : null}
    </>
  );
  return (
    <>
      {target.kind === "link" ? (
        <Link
          to={target.to}
          params={{ workspaceId: target.workspaceId ?? workspaceId }}
          search={target.search as never}
          className={cn(ROW_CLASS, "hover:bg-hover")}
          {...(item.id === "playground" ? analyticsAction("open_playground") : {})}
        >
          {content}
        </Link>
      ) : target.kind === "expand" ? (
        <button
          type="button"
          className={cn(ROW_CLASS, "hover:bg-hover")}
          aria-expanded={target.open}
          onClick={target.onClick}
        >
          {content}
        </button>
      ) : (
        <div className={ROW_CLASS}>{content}</div>
      )}
      {children}
    </>
  );
}
