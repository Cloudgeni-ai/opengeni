import {
  ArrowRightIcon,
  Building2Icon,
  CheckIcon,
  Loader2Icon,
  PanelsTopLeftIcon,
  ShieldCheckIcon,
} from "lucide-react";
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
  onOrganizationNameChange: (name: string) => void;
  onWorkspaceNameChange: (name: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  header?: ReactNode;
};

export function CreateOrganizationForm(props: CreateOrganizationFormProps) {
  const organizationName = props.organizationName.trim() || "Your organization";
  const workspaceName = props.workspaceName.trim() || "First shared workspace";

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
            value={props.organizationName}
            onChange={(event) => props.onOrganizationNameChange(event.target.value)}
            placeholder="Acme"
            maxLength={120}
            autoFocus
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-organization-workspace-name">First shared workspace</Label>
          <Input
            id="new-organization-workspace-name"
            value={props.workspaceName}
            onChange={(event) => props.onWorkspaceNameChange(event.target.value)}
            placeholder="General"
            maxLength={120}
          />
          <p className="text-xs text-fg-subtle">
            Your team can start working here. You can add more workspaces later.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-surface-2/45 p-3.5">
          <div className="flex items-center gap-2.5 text-sm">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-bg text-fg-muted">
              <Building2Icon aria-hidden="true" className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{organizationName}</span>
            <ArrowRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
              <PanelsTopLeftIcon aria-hidden="true" className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{workspaceName}</span>
          </div>
          <div className="mt-3 flex items-start gap-2 border-t border-border pt-3 text-xs leading-relaxed text-fg-subtle">
            <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-success" />
            <span>
              You become the owner. Your login stays the same, and nothing is copied from your
              current organization.
            </span>
          </div>
        </div>
      </div>

      <DialogFooter className="mt-5">
        <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={props.busy || !props.organizationName.trim() || !props.workspaceName.trim()}
        >
          {props.busy ? (
            <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <CheckIcon aria-hidden="true" className="size-4" />
          )}
          Create organization
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
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <CreateOrganizationForm
          {...props}
          header={
            <DialogHeader>
              <DialogTitle>New organization</DialogTitle>
              <DialogDescription>
                Create a separate home for another team, with its own members, workspaces, and data.
              </DialogDescription>
            </DialogHeader>
          }
          onCancel={() => props.onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
