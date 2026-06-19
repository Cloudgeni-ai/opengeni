// Create / rename workspace dialog — lifted verbatim out of the old top-nav
// shell so both the switcher and Workspace settings can reuse it.
import { CheckIcon, Loader2Icon } from "lucide-react";

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

export function WorkspaceNameDialog(props: {
  mode: "create" | "rename" | null;
  name: string;
  busy: boolean;
  onNameChange: (name: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
}) {
  const creating = props.mode === "create";
  return (
    <Dialog open={props.mode !== null} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{creating ? "New workspace" : "Rename workspace"}</DialogTitle>
            <DialogDescription>
              {creating
                ? "A separate space with its own sessions, environments, packs, and API keys."
                : "The new name shows everywhere this workspace appears."}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 grid gap-1.5">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              value={props.name}
              onChange={(event) => props.onNameChange(event.target.value)}
              placeholder="production"
              autoFocus
            />
          </div>
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={props.busy || !props.name.trim()}>
              {props.busy ? <Loader2Icon className="size-4 animate-spin" /> : <CheckIcon className="size-4" />}
              {creating ? "Create workspace" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
