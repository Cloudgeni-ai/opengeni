import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CopyIcon,
  FileJsonIcon,
  MoreVerticalIcon,
  OctagonXIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cancelRun } from "@/lib/api";
import { runQueryOptions } from "@/lib/queries";
import { TERMINAL_STATUSES, type AgentRun } from "@/lib/types";

interface RunActionsMenuProps {
  run: AgentRun;
  onShowRaw: () => void;
}

export function RunActionsMenu({ run, onShowRaw }: RunActionsMenuProps) {
  const queryClient = useQueryClient();
  const terminal = TERMINAL_STATUSES.has(run.status);
  const [cancelOpen, setCancelOpen] = useState(false);

  const cancelMutation = useMutation({
    mutationFn: () => cancelRun(run.id, null),
    onSuccess: (updated) => {
      queryClient.setQueryData(runQueryOptions(run.id).queryKey, updated);
      toast.success("Cancel requested");
      setCancelOpen(false);
    },
    onError: (error: unknown) => {
      toast.error("Cancel failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Run actions"
            className="text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
          >
            <MoreVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            onSelect={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                toast.success("Link copied");
              } catch {
                toast.error("Unable to copy link");
              }
            }}
          >
            <CopyIcon />
            Copy link
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={async () => {
              try {
                await navigator.clipboard.writeText(run.id);
                toast.success("Run ID copied");
              } catch {
                toast.error("Unable to copy");
              }
            }}
          >
            <CopyIcon />
            Copy run ID
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onShowRaw()}>
            <FileJsonIcon />
            View raw JSON
          </DropdownMenuItem>
          {!terminal ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setCancelOpen(true)}
              >
                <OctagonXIcon />
                Cancel run
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Cancel this run?</DialogTitle>
            <DialogDescription>
              The workflow will stop at the next safe point. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCancelOpen(false)}
              disabled={cancelMutation.isPending}
            >
              Keep running
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? "Cancelling..." : "Cancel run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
