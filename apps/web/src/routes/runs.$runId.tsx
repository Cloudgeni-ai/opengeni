import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  FileJsonIcon,
  PanelRightIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Composer } from "@/components/app/Composer";
import { TopBar } from "@/components/app/TopBar";
import { ConversationStream } from "@/components/run/ConversationStream";
import { Inspector } from "@/components/run/Inspector";
import { RunActionsMenu } from "@/components/run/RunActionsMenu";
import { StatusBadge } from "@/components/run/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { submitFollowUp } from "@/lib/api";
import { projectConversation } from "@/lib/conversation";
import {
  runEventsQueryOptions,
  runQueryOptions,
} from "@/lib/queries";
import { TERMINAL_STATUSES } from "@/lib/types";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useRunStream } from "@/lib/useRunStream";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/runs/$runId")({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(runQueryOptions(params.runId)),
      context.queryClient.ensureQueryData(runEventsQueryOptions(params.runId)),
    ]);
  },
  component: RunDetailPage,
});

function RunDetailPage() {
  const { runId } = Route.useParams();
  const { data: run } = useSuspenseQuery(runQueryOptions(runId));
  const { data: events } = useSuspenseQuery(runEventsQueryOptions(runId));
  const queryClient = useQueryClient();

  const stream = useRunStream(run);
  const conversation = useMemo(
    () => projectConversation(run, events),
    [run, events],
  );

  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [rawDialogOpen, setRawDialogOpen] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  const terminal = TERMINAL_STATUSES.has(run.status);

  const followUpMutation = useMutation({
    mutationFn: (prompt: string) => submitFollowUp(run.id, prompt),
    onSuccess: (updated) => {
      queryClient.setQueryData(runQueryOptions(run.id).queryKey, updated);
    },
    onError: (error: unknown) => {
      toast.error("Follow-up failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const composerDisabledHint = terminal
    ? "Run is " + run.status + "."
    : !run.temporal_workflow_id
      ? "Run is still dispatching..."
      : undefined;

  return (
    <>
      <TopBar>
        <div className="flex min-w-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="ghost"
                size="icon-sm"
                aria-label="Back to runs"
                className="text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
              >
                <Link to="/">
                  <ArrowLeftIcon />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Back</TooltipContent>
          </Tooltip>
          <span className="hidden max-w-[320px] truncate text-sm text-[color:var(--color-fg-muted)] sm:block">
            {run.prompt}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatusBadge status={run.status} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
                onClick={() => setInspectorOpen((value) => !value)}
                className={cn(
                  "text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]",
                  inspectorOpen && "text-[color:var(--color-fg)]",
                )}
              >
                <PanelRightIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Inspector</TooltipContent>
          </Tooltip>
          <RunActionsMenu run={run} onShowRaw={() => setRawDialogOpen(true)} />
        </div>
      </TopBar>

      <div
        className={cn(
          "relative grid flex-1 transition-[grid-template-columns] duration-200 ease-out",
          "grid-cols-[1fr_0px]",
          inspectorOpen && "lg:grid-cols-[1fr_380px]",
        )}
      >
        <div className="flex min-h-0 flex-col">
          <ScrollArea className="flex-1">
            <div className="mx-auto w-full max-w-2xl px-4 pt-8 pb-32 sm:px-6">
              <ConversationStream conversation={conversation} />
            </div>
          </ScrollArea>

          <div className="sticky bottom-0 border-t border-[color:var(--color-border)] bg-[color:var(--color-bg)]/85 px-4 py-3 backdrop-blur sm:px-6">
            <div className="mx-auto w-full max-w-2xl">
              <Composer
                pending={followUpMutation.isPending}
                disabled={terminal || !run.temporal_workflow_id}
                disabledHint={composerDisabledHint}
                placeholder={terminal ? "Run has ended" : "Send a follow-up..."}
                submitLabel={followUpMutation.isPending ? "Sending" : "Send"}
                onSubmit={(prompt) => followUpMutation.mutate(prompt)}
              />
            </div>
          </div>
        </div>

        {/* Desktop inspector */}
        <aside
          aria-label="Run inspector"
          className={cn(
            "hidden h-[calc(100vh-3.5rem)] min-h-0 border-l border-[color:var(--color-border)]",
            "bg-[color:var(--color-surface)]/60",
            inspectorOpen && "lg:block",
          )}
        >
          <Inspector
            run={run}
            events={events}
            progress={stream.progress}
            connectionState={stream.connectionState}
          />
        </aside>
      </div>

      {/* Mobile inspector (mounted only below lg to avoid focus-trap conflicts) */}
      {!isDesktop ? (
        <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
          <SheetContent
            side="right"
            className="flex w-full max-w-sm flex-col p-0"
          >
            <SheetHeader className="px-4 pb-2 pt-4">
              <SheetTitle>Inspector</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1">
              <Inspector
                run={run}
                events={events}
                progress={stream.progress}
                connectionState={stream.connectionState}
              />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}

      <Dialog open={rawDialogOpen} onOpenChange={setRawDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileJsonIcon className="size-4" />
              Raw payload
            </DialogTitle>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/50 p-3 font-mono text-xs leading-relaxed text-[color:var(--color-fg-muted)]">
            {JSON.stringify({ run, events }, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}
