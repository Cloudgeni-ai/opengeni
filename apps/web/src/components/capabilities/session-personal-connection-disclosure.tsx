import { Notice } from "@/components/ui/notice";
import type { McpPersonalConnectionSummary } from "@/types";

export function SessionPersonalConnectionDisclosure({
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
    <Notice tone="info" title="Personal access delegated" className={className}>
      This session may use personal connections for {providers.join(", ")}. If one is unavailable,
      only that tool is skipped; other work continues.
    </Notice>
  );
}
