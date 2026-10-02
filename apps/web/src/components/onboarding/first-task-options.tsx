import { CalendarClockIcon, GitPullRequestIcon, SearchIcon } from "lucide-react";

import { analyticsAction } from "@/lib/analytics-actions";
import { FIRST_TASKS, type FirstTask } from "@/lib/first-tasks";
import { cn } from "@/lib/utils";

const ICONS: Record<FirstTask["id"], typeof SearchIcon> = {
  "fix-issue": GitPullRequestIcon,
  "morning-brief": CalendarClockIcon,
  research: SearchIcon,
};

/**
 * The three first tasks as template cards. A prompt task hands its message to
 * the composer; the morning brief opens New schedule from its template. Both
 * wait for the person to confirm.
 */
export function FirstTaskOptions({
  onPrompt,
  onSchedule,
  layout = "grid",
}: {
  onPrompt: (prompt: string, task: FirstTask) => void;
  onSchedule: (template: "morning-brief", task: FirstTask) => void;
  /** `grid`: three across on wide pages. `compact`: stacked rows under a checklist row. */
  layout?: "grid" | "compact";
}) {
  return (
    <ul
      className={cn(
        "grid min-w-0 gap-2",
        layout === "grid" ? "@container grid-cols-1 sm:grid-cols-3" : "grid-cols-1",
      )}
    >
      {FIRST_TASKS.map((task) => {
        const Icon = ICONS[task.id];
        return (
          <li key={task.id} className="min-w-0">
            <button
              type="button"
              className={cn(
                "group flex h-full w-full min-w-0 gap-3 rounded-[14px] border border-border bg-surface text-left transition-colors duration-[120ms] outline-none hover:hover-layer focus-visible:ring-2 focus-visible:ring-ring/40",
                layout === "grid"
                  ? "items-center px-3 py-2.5 sm:flex-col sm:items-start sm:p-4"
                  : "items-center px-3 py-2.5",
              )}
              onClick={() =>
                task.kind === "prompt"
                  ? onPrompt(task.prompt, task)
                  : onSchedule(task.template, task)
              }
              {...analyticsAction("start_first_task")}
            >
              <span
                aria-hidden="true"
                className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-surface-2 text-fg-muted"
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-fg">{task.title}</span>
                <span
                  className={cn(
                    "mt-0.5 block text-xs leading-4.5 text-fg-muted",
                    layout === "compact" && "truncate",
                  )}
                >
                  {task.description}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
