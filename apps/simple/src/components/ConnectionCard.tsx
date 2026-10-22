import type { AuthNeededItem } from "@opengeni/react";
import { McpConnectionCard } from "@opengeni/react/connect";
import type { CapabilityCatalogItem } from "@opengeni/sdk";
import { GitBranch, Plug } from "lucide-react";
import { useState, type ReactNode } from "react";
import { client } from "../lib/app-api";
import { useAppEvents } from "../lib/app-events";

/**
 * Inline connection setup when an agent asks for a tool. OAuth services get
 * the native connect card right in the chat; GitHub opens its App install;
 * anything else points at Settings.
 */
export function renderConnectionCard(
  item: AuthNeededItem,
  context: {
    workspaceId: string;
    sessionId: string;
    catalog: CapabilityCatalogItem[];
  },
): ReactNode | undefined {
  const capability = item.capability;
  if (!capability) {
    if (item.authoritySource === "host") return undefined;
    return <SettingsFallback title={`Reconnect ${item.providerDomain}`} rationale={null} />;
  }
  if (capability.id === "api:github-app") {
    return <GitHubCard workspaceId={context.workspaceId} rationale={capability.rationale} />;
  }
  const entry = context.catalog.find((candidate) => candidate.id === capability.id);
  if (entry?.kind === "mcp" && entry.authKind === "oauth2") {
    return (
      <div className="card-in my-2">
        <McpConnectionCard
          client={client}
          workspaceId={context.workspaceId}
          sessionId={context.sessionId}
          capabilityId={capability.id}
          name={capability.name}
          rationale={capability.rationale}
          returnUrl={window.location.href}
        />
      </div>
    );
  }
  return <SettingsFallback title={`Connect ${capability.name}`} rationale={capability.rationale} />;
}

function Shell({
  icon,
  title,
  rationale,
  action,
}: {
  icon: ReactNode;
  title: string;
  rationale: string | null;
  action: ReactNode;
}) {
  return (
    <div className="card-in my-2 flex items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] p-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--app-hover)]">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{title}</div>
        {rationale ? <div className="text-xs text-[var(--app-muted)]">{rationale}</div> : null}
      </div>
      {action}
    </div>
  );
}

function SettingsFallback({ title, rationale }: { title: string; rationale: string | null }) {
  const events = useAppEvents();
  return (
    <Shell
      icon={<Plug size={18} />}
      title={title}
      rationale={rationale}
      action={
        <button
          type="button"
          onClick={() => events.openSettings("connections")}
          className="shrink-0 rounded-full bg-[var(--app-accent)] px-3 py-1.5 text-xs font-medium text-white"
        >
          Set up
        </button>
      }
    />
  );
}

function GitHubCard({ workspaceId, rationale }: { workspaceId: string; rationale: string }) {
  const [state, setState] = useState<"idle" | "busy" | "connected" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const start = async () => {
    setState("busy");
    try {
      const info = await client.getGitHubApp(workspaceId, {
        returnPath: window.location.pathname,
      });
      if (info.status === "bound") {
        setState("connected");
        return;
      }
      const url = info.installUrl ?? info.linkUrl;
      if (!url) {
        setState("error");
        setMessage(
          info.configured
            ? "GitHub can't be connected from here."
            : "GitHub isn't set up on this Opengeni yet.",
        );
        return;
      }
      window.open(url, "_blank", "noopener");
      setState("idle");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Shell
      icon={<GitBranch size={18} />}
      title={state === "connected" ? "GitHub is connected" : "Connect GitHub"}
      rationale={message ?? rationale}
      action={
        state === "connected" ? null : (
          <button
            type="button"
            disabled={state === "busy"}
            onClick={() => void start()}
            className="shrink-0 rounded-full bg-[var(--app-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
          >
            Connect
          </button>
        )
      }
    />
  );
}
