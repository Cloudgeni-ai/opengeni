import { CheckIcon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";

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

type CreateOrganizationFormProps = {
  organizationName: string;
  workspaceName: string;
  busy: boolean;
  creationState?: "draft" | "uncertain" | "committed";
  onOrganizationNameChange: (name: string) => void;
  onWorkspaceNameChange: (name: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  header?: ReactNode;
};

export function CreateOrganizationForm(props: CreateOrganizationFormProps) {
  const creationState = props.creationState ?? "draft";
  const requestLocked = creationState !== "draft";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      {props.header ?? (
        <DialogHeader>
          <h2 className="text-lg leading-none font-semibold">New organization</h2>
          <p className="text-sm text-muted-foreground">
            Create a separate home for another team, with its own members, workspaces, and data.
          </p>
        </DialogHeader>
      )}

      <div className="mt-5 grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="new-organization-name">Organization name</Label>
          <Input
            id="new-organization-name"
            suppressAutofill
            value={props.organizationName}
            onChange={(event) => props.onOrganizationNameChange(event.target.value)}
            placeholder="Acme"
            maxLength={120}
            disabled={requestLocked}
            autoFocus
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-organization-workspace-name">First shared workspace</Label>
          <Input
            id="new-organization-workspace-name"
            suppressAutofill
            value={props.workspaceName}
            onChange={(event) => props.onWorkspaceNameChange(event.target.value)}
            placeholder="General"
            maxLength={120}
            disabled={requestLocked}
          />
          <p className="text-xs text-fg-subtle">
            Your team can start working here. You can add more workspaces later.
          </p>
        </div>

        <p className="text-xs text-fg-muted">
          You become the owner. Your login stays the same, and nothing is copied from your current
          organization.
        </p>
      </div>

      <DialogFooter className="mt-5">
        <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
          {requestLocked ? "Close" : "Cancel"}
        </Button>
        <Button
          type="submit"
          disabled={
            props.busy ||
            (!requestLocked && (!props.organizationName.trim() || !props.workspaceName.trim()))
          }
        >
          {props.busy ? (
            <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <CheckIcon aria-hidden="true" className="size-4" />
          )}
          {creationState === "committed"
            ? "Try opening again"
            : creationState === "uncertain"
              ? "Check creation again"
              : "Create organization"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function CreateOrganizationDialog(
  props: Omit<CreateOrganizationFormProps, "header" | "onCancel"> & {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  },
) {
  const creationState = props.creationState ?? "draft";
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <CreateOrganizationForm
          {...props}
          header={
            <DialogHeader>
              <DialogTitle>
                {creationState === "committed"
                  ? `${props.organizationName} was created`
                  : creationState === "uncertain"
                    ? "Confirm organization creation"
                    : "New organization"}
              </DialogTitle>
              <DialogDescription>
                {creationState === "committed"
                  ? "Try again to refresh your access and open the new organization. This will not create another one."
                  : creationState === "uncertain"
                    ? "Opengeni could not confirm the result. Try again to safely replay this exact request without creating a duplicate."
                    : "Create a separate home for another team, with its own members, workspaces, and data."}
              </DialogDescription>
            </DialogHeader>
          }
          onCancel={() => props.onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
