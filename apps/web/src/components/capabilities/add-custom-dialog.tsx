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
import { capabilityFormError, capabilityKindLabel, emptyCapabilityForm, type CapabilityFormState } from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import type { CapabilityKind } from "@/types";

type AddableKind = Exclude<CapabilityKind, "pack">;
const KINDS: AddableKind[] = ["mcp", "api", "skill", "plugin"];

/**
 * "Add custom" — kind-aware so only MCP servers ask for an endpoint URL. APIs,
 * skills, and plugins are tracked by name (the user's complaint was being asked
 * for an endpoint when adding a skill). Packs keep their manifest flow in the
 * Packs section, so they are not offered here.
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

  const isMcp = form.kind === "mcp";
  const error = capabilityFormError(form);
  const update = (patch: Partial<CapabilityFormState>) => setForm((current) => ({ ...current, ...patch }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a custom capability</DialogTitle>
          <DialogDescription>
            Connect a remote MCP server, or track an API, skill, or plugin your team uses.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!error && !busy) onSubmit(form);
          }}
        >
          {/* Kind picker */}
          <div className="grid gap-1.5">
            <Label className="text-xs text-fg-muted">Type</Label>
            <div className="grid grid-cols-4 gap-1.5 rounded-lg border border-border bg-surface/50 p-1">
              {KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => update({ kind })}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                    form.kind === kind ? "bg-surface-2 text-fg shadow-sm" : "text-fg-subtle hover:text-fg-muted",
                  )}
                >
                  {capabilityKindLabel(kind)}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="add-name" className="text-xs text-fg-muted">Name</Label>
            <Input
              id="add-name"
              value={form.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder={isMcp ? "e.g. Internal Tools MCP" : `e.g. ${capabilityKindLabel(form.kind)} name`}
              autoFocus
            />
          </div>

          {/* Endpoint URL — MCP servers only. */}
          {isMcp ? (
            <div className="grid gap-1.5">
              <Label htmlFor="add-endpoint" className="text-xs text-fg-muted">Server URL</Label>
              <Input
                id="add-endpoint"
                value={form.endpointUrl}
                onChange={(event) => update({ endpointUrl: event.target.value })}
                placeholder="https://mcp.example.com/sse"
                inputMode="url"
              />
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="add-homepage" className="text-xs text-fg-muted">Homepage <span className="text-fg-subtle">(optional)</span></Label>
              <Input
                id="add-homepage"
                value={form.homepageUrl}
                onChange={(event) => update({ homepageUrl: event.target.value })}
                placeholder="https://example.com"
                inputMode="url"
              />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="add-description" className="text-xs text-fg-muted">Description <span className="text-fg-subtle">(optional)</span></Label>
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
            {isMcp ? "Enable after adding" : "Track after adding"}
          </label>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || Boolean(error)}>
              {busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
              Add {capabilityKindLabel(form.kind)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
