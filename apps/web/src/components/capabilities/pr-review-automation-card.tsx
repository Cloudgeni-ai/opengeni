import { useNavigate } from "@tanstack/react-router";
import { GitPullRequestIcon } from "lucide-react";

import { Button } from "@opengeni/react/ui/button";

/**
 * Pull-request review is an automation: a GitHub pull-request trigger plus
 * review instructions. This points Plugins at that template.
 */
export function PrReviewAutomationCard(props: { workspaceId: string }) {
  const navigate = useNavigate();
  return (
    <section className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-fg-muted">
        <GitPullRequestIcon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1 basis-60">
        <h3 className="m-0 text-sm font-semibold">Review pull requests</h3>
        <p className="mt-1 mb-0 text-xs leading-5 text-fg-muted">
          Opengeni reviews each new pull request in the repositories you pick. It runs as an
          automation you can change any time.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          void navigate({
            to: "/workspaces/$workspaceId/automations/new",
            params: { workspaceId: props.workspaceId },
            search: { template: "pr-review" },
          })
        }
      >
        Set up review
      </Button>
    </section>
  );
}
