import { Loader2Icon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

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
import {
  capabilityFormError,
  emptyCapabilityForm,
  type CapabilityFormState,
} from "@/lib/capabilities";
import type { CapabilityKind } from "@/types";

type AddableKind = Exclude<CapabilityKind, "pack">;
export const ADD_CUSTOM_CATALOG_KINDS: AddableKind[] = ["mcp"];

/**
 * Legacy catalog creation is now MCP-only. Skills, Plugins, OpenAPI, and
 * GraphQL sources have dedicated immutable preview-before-install flows.
 */
export function AddCustomDialog({
  open,
  onOpenChange,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onSubmit: (form: CapabilityFormState) => void;
}) {
  const [form, setForm] = useState<CapabilityFormState>(() => emptyCapabilityForm());
  // Reset to a clean form each time the dialog opens.
  useEffect(() => {
    if (open) setForm(emptyCapabilityForm());
  }, [open]);

  const error = capabilityFormError(form);
  const update = (patch: Partial<CapabilityFormState>) =>
    setForm((current) => ({ ...current, ...patch }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add MCP server</DialogTitle>
          <DialogDescription>
            Register a remote MCP server. Use the dedicated source review flows for Skills, Plugins,
            OpenAPI, and GraphQL.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!error && !busy) onSubmit(form);
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="add-name" className="text-xs text-fg-muted">
              Name
            </Label>
            <Input
              id="add-name"
              value={form.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder="e.g. Internal Tools MCP"
              autoFocus
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="add-endpoint" className="text-xs text-fg-muted">
              Server URL
            </Label>
            <Input
              id="add-endpoint"
              value={form.endpointUrl}
              onChange={(event) => update({ endpointUrl: event.target.value })}
              placeholder="https://mcp.example.com/sse"
              inputMode="url"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="add-description" className="text-xs text-fg-muted">
              Description <span className="text-fg-subtle">(optional)</span>
            </Label>
            <textarea
              id="add-description"
              value={form.description}
              onChange={(event) => update({ description: event.target.value })}
              placeholder="What is it for?"
              className="min-h-16 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-fg-muted">
            <input
              type="checkbox"
              checked={form.enableAfterAdd}
              onChange={(event) => update({ enableAfterAdd: event.target.checked })}
              className="size-4 accent-brand"
            />
            Enable after adding
          </label>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || Boolean(error)}>
              {busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
              Add MCP server
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
