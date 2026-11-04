// Create-project dialog for the rail. The API still calls these channels;
// the rail presents the user-facing organizational concept.
// creation feels like every other lightweight naming flow.
import { Loader2Icon } from "lucide-react";

import { Button } from "../../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../ui/dialog";
import { Field } from "../../../ui/field";
import { Input } from "../../../ui/input";
import { Label } from "../../../ui/label";
import { SegmentedControl } from "../../../ui/segmented-control";

export const CHANNEL_NAME_MAX_LENGTH = 80;

export type ProjectAudience = "workspace" | "private";

const AUDIENCE_OPTIONS = [
  { value: "workspace", label: "Workspace" },
  { value: "private", label: "Only me" },
] as const satisfies readonly { value: ProjectAudience; label: string }[];

export function ChannelCreateDialog(props: {
  open: boolean;
  name: string;
  busy: boolean;
  /**
   * Who can see the new project, offered only where this person may make
   * Only me things (never in a Personal workspace, where everything is theirs).
   */
  audience?: { value: ProjectAudience; onChange: (value: ProjectAudience) => void } | undefined;
  onNameChange: (name: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
}) {
  const audience = props.audience;
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
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              {audience
                ? "Projects keep related sessions together."
                : "Projects keep related sessions together for everyone in this workspace."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
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
            {audience ? (
              <Field
                label="Who can see it"
                hint={
                  audience.value === "private"
                    ? "Only you see it. It holds your Only me chats and Sites."
                    : "Everyone in this workspace sees it."
                }
              >
                <SegmentedControl
                  size="sm"
                  aria-label="Who can see it"
                  options={AUDIENCE_OPTIONS}
                  value={audience.value}
                  disabled={props.busy}
                  onValueChange={audience.onChange}
                />
              </Field>
            ) : null}
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
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
