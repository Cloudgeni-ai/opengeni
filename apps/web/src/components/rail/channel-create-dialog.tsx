// Create-project dialog for the rail. The API still calls these channels;
// the rail presents the user-facing organizational concept.
// creation feels like every other lightweight naming flow.
import { Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const CHANNEL_NAME_MAX_LENGTH = 80;

export function ChannelCreateDialog(props: {
  open: boolean;
  mode?: "create" | "rename";
  name: string;
  busy: boolean;
  onNameChange: (name: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!props.busy) props.onOpenChange(open);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <form
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.busy && props.name.trim()) props.onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.mode === "rename" ? "Rename project" : "New project"}</DialogTitle>
            <DialogDescription>
              Projects keep related sessions together for everyone in this workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-4">
            <Label htmlFor="channel-name">Name</Label>
            <Input
              id="channel-name"
              name="project-name"
              type="text"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-protonpass-ignore="true"
              value={props.name}
              disabled={props.busy}
              maxLength={CHANNEL_NAME_MAX_LENGTH}
              placeholder="security"
              onChange={(event) => props.onNameChange(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={props.busy}
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={props.busy || !props.name.trim()}>
              {props.busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
              {props.mode === "rename" ? "Rename" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
