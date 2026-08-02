import { UserRoundIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { McpPersonalConnectionSummary } from "@/types";

export function SchedulePersonalConnectionDisclosure({
  connections,
  className,
}: {
  connections: readonly McpPersonalConnectionSummary[] | undefined;
  className?: string;
}) {
  const providers = [
    ...new Set((connections ?? []).map((connection) => connection.providerDomain)),
  ].sort();
  if (providers.length === 0) return null;

  return (
    <div
      className={cn("mt-1.5 flex min-w-0 items-center gap-1.5 text-2xs text-fg-subtle", className)}
      title="This task carries exact delegated personal access. Revoked or unavailable access is not replaced with another person's connection."
    >
      <UserRoundIcon className="size-3 shrink-0" />
      <span className="shrink-0 font-medium text-fg-muted">Personal access</span>
      <span aria-hidden="true">·</span>
      <span className="truncate">{providers.join(", ")}</span>
    </div>
  );
}
