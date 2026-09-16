import { lazy, Suspense, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { AuthNeededItem } from "@opengeni/react";
import type { CapabilityCatalogItem } from "@/types";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";

const SessionCapabilityCard = lazy(async () => ({
  default: (await import("./session-capability-card")).SessionCapabilityCard,
}));

/** Local consent UI, not a durable agent recommendation or an authorization. */
export function personalConnectionReviewItem(item: CapabilityCatalogItem): AuthNeededItem {
  return {
    kind: "auth-needed",
    id: `personal-consent:${item.id}`,
    turnId: null,
    serverId: item.runtime.mcpServerId ?? null,
    providerDomain: item.providerDomain ?? "",
    connectionId: null,
    reason: "personal_authority_unavailable",
    scopes: [],
    resource: null,
    toolName: null,
    authorizationUrl: null,
    occurredAt: item.updatedAt ?? "",
    capability: {
      id: item.id,
      name: item.name,
      kind: item.kind,
      source: item.source,
      action: "connect",
      rationale:
        "Allow this chat to use your personal account. Connecting the account alone does not authorize this chat.",
      requiredVariables: [],
    },
  };
}

export function SessionPersonalConnectionNotice({
  items,
  workspaceId,
  sessionId,
  visibility,
  authorityEpoch,
  onConfigured,
}: {
  items: CapabilityCatalogItem[];
  workspaceId: string;
  sessionId: string;
  visibility: "private" | "workspace";
  authorityEpoch: number;
  onConfigured: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-3">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto w-full justify-between gap-3 whitespace-normal px-0 py-2 text-left"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium">Review personal account access</span>
            <span className="block text-xs font-normal text-fg-subtle">
              {items.map((item) => item.name).join(", ")} needs permission for this chat.
            </span>
          </span>
          <ChevronDownIcon className={open ? "shrink-0 rotate-180" : "shrink-0"} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid max-h-[40vh] gap-3 overflow-y-auto py-2">
          <Suspense
            fallback={
              <p role="status" className="text-sm text-fg-subtle">
                Loading account access…
              </p>
            }
          >
            {items.map((item) => (
              <SessionCapabilityCard
                key={`${workspaceId}:${sessionId}:${visibility}:${authorityEpoch}:${item.id}`}
                item={personalConnectionReviewItem(item)}
                workspaceId={workspaceId}
                sessionId={sessionId}
                visibility={visibility}
                onConfigured={onConfigured}
              />
            ))}
          </Suspense>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
