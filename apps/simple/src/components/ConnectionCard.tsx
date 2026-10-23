import type { AuthNeededItem } from "@opengeni/react";
import { McpConnectionCard } from "@opengeni/react/connect";
import { ThisComputerCard } from "@opengeni/react/this-computer";
import type { CapabilityCatalogItem } from "@opengeni/sdk";
import { GitBranch, Monitor, Plug } from "lucide-react";
import { useState, type ReactNode } from "react";
import { client, connectReturnUrl } from "../lib/app-api";
import { useAppEvents } from "../lib/app-events";
import { useAppComputer } from "../lib/this-computer";

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
    /** The person turned their computer on from the card. */
    onComputerReady?: () => void;
  },
): ReactNode | undefined {
  const capability = item.capability;
  if (!capability) {
    if (item.authoritySource === "host") return undefined;
    return <SettingsFallback title={`Reconnect ${item.providerDomain}`} rationale={null} />;
  }
  if (capability.id === "api:connected-machine") {
    return <ComputerCard rationale={capability.rationale} onReady={context.onComputerReady} />;
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
          returnUrl={connectReturnUrl()}
        />
      </div>
    );
  }
  return <SettingsFallback title={`Connect ${capability.name}`} rationale={capability.rationale} />;
}

/**
 * The agent asks to use this Mac. One Allow turns it on for every chat; the
 * setup dialog walks through the macOS permissions when screen control is on.
 */
function ComputerCard({
  rationale,
  onReady,
}: {
  rationale: string | null | undefined;
  onReady: (() => void) | undefined;
}) {
  const app = useAppComputer();
  if (!app) {
    return (
      <Shell
        icon={<Monitor size={18} />}
        title="Use your computer"
        rationale="Open the Opengeni Mac app to let agents use your computer."
        action={null}
      />
    );
  }
  return (
    <div className="simple-connections card-in my-2">
      <ThisComputerCard
        rationale={rationale ?? null}
        computer={app.computer}
        productName={app.productName}
        labels={app.labels}
        onSetup={app.openSetup}
        {...(onReady ? { onReady: () => onReady() } : {})}
      />
    </div>
  );
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
