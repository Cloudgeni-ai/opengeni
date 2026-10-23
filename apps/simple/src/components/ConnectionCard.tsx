import { OPENGENI_BROWSER_EXTENSION_URL } from "@opengeni/contracts";
import type { AuthNeededItem } from "@opengeni/react";
import { McpConnectionCard } from "@opengeni/react/connect";
import { ThisComputerCard } from "@opengeni/react/this-computer";
import type { CapabilityCatalogItem } from "@opengeni/sdk";
import { AppWindow, Check, GitBranch, Monitor, Plug } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
    /** The person linked their Chrome from the card. */
    onChromeReady?: () => void;
  },
): ReactNode | undefined {
  const capability = item.capability;
  if (!capability) {
    if (item.authoritySource === "host") return undefined;
    return <SettingsFallback title={`Reconnect ${item.providerDomain}`} rationale={null} />;
  }
  if (capability.id === "api:connected-machine") {
    // The agent tried the person's own Chrome: that takes the computer and
    // then the Opengeni Browser extension.
    if (item.toolName === "browser_open" || item.toolName?.endsWith("__browser_open")) {
      return (
        <ChromeCard
          workspaceId={context.workspaceId}
          rationale={capability.rationale}
          onReady={context.onChromeReady}
        />
      );
    }
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

/** How often to look for the extension, and for how long, after "Add to Chrome". */
const CHROME_POLL_MS = 3_000;
const CHROME_WATCH_MS = 10 * 60_000;

/**
 * The agent asks for the person's own Chrome. With this computer on, one
 * "Add to Chrome" opens the extension's store page in Chrome; the card notices
 * when the extension links up and tells the agent to go ahead.
 */
function ChromeCard({
  workspaceId,
  rationale,
  onReady,
}: {
  workspaceId: string;
  rationale: string | null | undefined;
  onReady: (() => void) | undefined;
}) {
  const app = useAppComputer();
  const status = app?.computer.status ?? null;
  // Chrome needs this computer connected, not its screen permissions.
  const enrollmentId = status?.state === "connected" ? (status.enrollmentId ?? null) : null;
  const [linked, setLinked] = useState<string | null>(null);
  const [watchSince, setWatchSince] = useState<number | null>(null);
  const told = useRef(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!enrollmentId || linked) return;
    let cancelled = false;
    const read = async () => {
      const result = await client.listAttachedBrowsers(workspaceId).catch(() => null);
      if (cancelled || !result) return;
      const device = result.devices.find(
        (candidate) => candidate.state === "connected" && candidate.enrollmentId === enrollmentId,
      );
      if (device) setLinked(device.profileLabel ?? device.browserName);
    };
    void read();
    if (watchSince === null) return () => void (cancelled = true);
    const timer = window.setInterval(() => {
      // After a while, stop looking; "Add to Chrome" starts it again.
      if (Date.now() - watchSince > CHROME_WATCH_MS) setWatchSince(null);
      else if (document.visibilityState !== "hidden") void read();
    }, CHROME_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enrollmentId, linked, watchSince, workspaceId]);

  // Linked after "Add to Chrome": tell the agent. Linked already when the card
  // showed: the person says when to go on.
  const tell = () => {
    if (told.current) return;
    told.current = true;
    setSent(true);
    onReady?.();
  };
  useEffect(() => {
    if (linked && watchSince !== null) tell();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one message per card
  }, [linked, watchSince]);

  if (!app) {
    return (
      <Shell
        icon={<AppWindow size={18} />}
        title="Use your Chrome"
        rationale="Open the Opengeni Mac app to let agents use your Chrome."
        action={null}
      />
    );
  }
  // First this computer, with the usual card.
  if (!enrollmentId) return <ComputerCard rationale={rationale} onReady={undefined} />;
  if (linked) {
    return (
      <Shell
        icon={<AppWindow size={18} />}
        title="Chrome is connected"
        rationale={`Agents can use ${linked} on ${status?.machineName ?? "this Mac"}.`}
        action={
          watchSince === null && onReady && !sent ? (
            <button
              type="button"
              onClick={tell}
              className="shrink-0 rounded-full bg-[var(--app-accent)] px-3 py-1.5 text-xs font-medium text-white"
            >
              Go ahead
            </button>
          ) : (
            <Check size={16} className="shrink-0 text-[var(--app-accent)]" />
          )
        }
      />
    );
  }
  return (
    <Shell
      icon={<AppWindow size={18} />}
      title="Connect your Chrome"
      rationale={
        watchSince === null
          ? (rationale ?? "Add Opengeni Browser to Chrome so agents can use your signed-in sites.")
          : "Add Opengeni Browser in Chrome. This card updates once it's in."
      }
      action={
        <a
          href={OPENGENI_BROWSER_EXTENSION_URL}
          target="_blank"
          rel="noreferrer"
          onClick={() => setWatchSince(Date.now())}
          className="shrink-0 rounded-full bg-[var(--app-accent)] px-3 py-1.5 text-xs font-medium text-white"
        >
          Add to Chrome
        </a>
      }
    />
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
