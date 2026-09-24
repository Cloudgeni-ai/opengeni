import { useState } from "react";
import type { AuthNeededItem } from "@opengeni/react";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SessionCapabilityFrame } from "./session-capability-frame";

type Props = {
  item: AuthNeededItem;
  workspaceId: string;
  onRegistered: (id: string) => void;
};

/** A proposed URL is untrusted display data until the human submits this form.
 * Creation uses the ordinary human-only Capabilities endpoint; the existing
 * capability card then handles authentication, enabling, and session selection. */
export function SessionCustomMcpCard({ item, workspaceId, onRegistered }: Props) {
  const context = useAppContext();
  const proposal = item.setupRequest!;
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(proposal.name);
  const [url, setUrl] = useState(proposal.endpointUrl);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canManage = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "capabilities:manage",
  );
  const validUrl = (() => {
    try {
      const parsed = new URL(url.trim());
      return (
        parsed.protocol === "https:" &&
        Boolean(parsed.hostname) &&
        !parsed.username &&
        !parsed.password &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  })();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canManage || !name.trim() || !validUrl) return;
    setBusy(true);
    setError(null);
    try {
      // A replayed card, or an uncertain creation response, must not write a
      // second catalog row when the endpoint is already present.
      const existing = (await context.client.listCapabilities(workspaceId)).items.find(
        (entry) => entry.kind === "mcp" && entry.endpointUrl === url.trim() && !entry.stale,
      );
      if (existing) {
        onRegistered(existing.id);
        return;
      }
      const created = await context.client.createCapability(workspaceId, {
        kind: "mcp",
        source: "manual",
        name: name.trim(),
        endpointUrl: url.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      onRegistered(created.id);
    } catch (failure) {
      // Read back before offering a retry: the write may have committed even
      // if the response was lost. Never silently repeat an uncertain POST.
      try {
        const matching = (await context.client.listCapabilities(workspaceId)).items.find(
          (entry) => entry.kind === "mcp" && entry.endpointUrl === url.trim() && !entry.stale,
        );
        if (matching) {
          onRegistered(matching.id);
          return;
        }
      } catch {
        // Preserve the uncertainty in the visible error below.
      }
      setError(
        failure instanceof Error
          ? `${failure.message} Check Connections before trying again; the request may have succeeded.`
          : "Could not verify setup. Check Connections before trying again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <SessionCapabilityFrame
      name={proposal.name}
      subtitle={item.providerDomain}
      logo={null}
      typeLabel="MCP server"
      description={proposal.rationale}
      skill={false}
      expanded={expanded}
      complete={false}
      actionLabel="Review server"
      note="Review the server address before adding it. Setup will ask for any required credentials separately."
      onOpen={() => setExpanded(true)}
      onClose={() => setExpanded(false)}
      busy={busy}
    >
      <form className="og-session-capability-setup" onSubmit={(event) => void submit(event)}>
        <p className="text-sm text-fg-muted">
          This server was suggested by the agent. Check that you trust its address before adding it
          to this workspace.
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor={`mcp-name-${item.id}`}>Name</Label>
          <Input
            id={`mcp-name-${item.id}`}
            value={name}
            maxLength={256}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`mcp-url-${item.id}`}>Server URL</Label>
          <Input
            id={`mcp-url-${item.id}`}
            type="url"
            inputMode="url"
            value={url}
            maxLength={2048}
            onChange={(event) => setUrl(event.target.value)}
            aria-describedby={`mcp-url-help-${item.id}`}
          />
          <p id={`mcp-url-help-${item.id}`} className="text-xs text-fg-muted">
            HTTPS only. Tools on this server may receive data you choose to share.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`mcp-description-${item.id}`}>Description (optional)</Label>
          <Input
            id={`mcp-description-${item.id}`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this connection is for"
          />
        </div>
        {!canManage ? (
          <p role="status" className="text-sm text-fg-muted">
            A workspace admin needs to add this server. You can share its URL with them.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setExpanded(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canManage || !name.trim() || !validUrl || busy}>
            {busy ? "Adding…" : "Add MCP server"}
          </Button>
        </div>
      </form>
    </SessionCapabilityFrame>
  );
}
