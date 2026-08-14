// Create-channel dialog for the rail. Mirrors WorkspaceNameDialog so channel
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
  name: string;
  busy: boolean;
  onNameChange: (name: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New channel</DialogTitle>
            <DialogDescription>
              Channels group workstreams by work type for everyone in this workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-4">
            <Label htmlFor="channel-name">Name</Label>
            <Input
              id="channel-name"
              autoFocus
              value={props.name}
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
              Create channel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
