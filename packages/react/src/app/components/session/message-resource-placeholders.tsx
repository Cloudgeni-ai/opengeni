import { GitBranchIcon } from "lucide-react";
import { repositoryDisplayName } from "../../lib/session-tools";
import type { ResourceRef } from "../../types";

export function MessageRepositoryChips({ resources }: { resources: ResourceRef[] }) {
  return resources.map((resource) =>
    resource.kind === "repository" ? (
      <span
        key={`${resource.uri}:${resource.ref}:${resource.mountPath ?? ""}`}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg-muted"
      >
        <GitBranchIcon className="size-3.5 shrink-0" />
        <span className="truncate">{repositoryDisplayName(resource)}</span>
      </span>
    ) : null,
  );
}
