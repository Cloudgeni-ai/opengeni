import { Button } from "@/components/ui/button";

/** Keep token entry, ownership and vault selection in the protected Secrets flow. */
export function OnePasswordCatalogLink({
  workspaceId,
  connected,
  preserveChat = false,
}: {
  workspaceId: string;
  connected: boolean;
  preserveChat?: boolean;
}) {
  const href = `/workspaces/${encodeURIComponent(workspaceId)}/secrets${
    connected ? "" : "?view=connect-1password"
  }`;
  return (
    <Button asChild className="rounded-[10px] pointer-coarse:h-11">
      <a
        href={href}
        target={preserveChat ? "_blank" : undefined}
        rel={preserveChat ? "noopener noreferrer" : undefined}
      >
        {connected ? "Manage 1Password" : "Connect 1Password"}
      </a>
    </Button>
  );
}
