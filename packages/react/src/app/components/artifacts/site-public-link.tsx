import type { SitePublicationLink } from "@opengeni/contracts";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { DesktopBridge } from "@opengeni/sdk/desktop-bridge";
import { ArrowUpRightIcon, CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import { copyTextToClipboard } from "../../../lib/clipboard";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../ui/tooltip";
import { desktopCapability } from "../../lib/desktop";
import { Link } from "../../lib/navigation";
import { sitePublicationLoadFromError } from "../../lib/site-publishing";
import { cn } from "../../lib/utils";

/* ----------------------------------------------------------------------------
   The Site view's way to the published Site: "Live ↗" opens the address the
   publication API reports (the Site's primary public URL), and a small copy
   button copies it. Anyone who can open the Site gets both; an unpublished
   Site says so instead, with Publish beside it for people who can publish.
   Access never changes the link.
   -------------------------------------------------------------------------- */

/** Where the Site's published address stands, from the API's answer. */
export type SitePublicationLinkLoad =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "forbidden" }
  | { state: "none" }
  | { state: "error"; error: unknown }
  | { state: "ready"; link: SitePublicationLink };

/** The Site's published address, for anyone who can open the Site. */
export function useSitePublicationLink({
  client,
  workspaceId,
  siteId,
}: {
  client: Pick<OpenGeniBrowserClient, "getSitePublicationLink">;
  workspaceId: string;
  siteId: string;
}): SitePublicationLinkLoad {
  // Keyed by Site, so moving to another Site never shows the last one's link.
  const key = `${workspaceId}/${siteId}`;
  const [answer, setAnswer] = useState<{ key: string; load: SitePublicationLinkLoad } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    client
      .getSitePublicationLink(workspaceId, siteId, { signal: abort.signal })
      .then((link) => {
        if (!abort.signal.aborted) setAnswer({ key, load: { state: "ready", link } });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        const failed = sitePublicationLoadFromError(error);
        setAnswer({ key, load: failed.state === "ready" ? { state: "error", error } : failed });
      });
    return () => abort.abort();
  }, [client, key, siteId, workspaceId]);
  return answer?.key === key ? answer.load : { state: "loading" };
}

/** The published address when the Site is on the web now, else null. */
export function publishedSiteLink(
  load: SitePublicationLinkLoad,
): { url: string; hostname: string } | null {
  if (load.state !== "ready" || load.link.status !== "active") return null;
  return { url: load.link.url, hostname: publishedHostname(load.link) };
}

/** The hostname people see: the one in the URL the API reports, which wins. */
function publishedHostname(link: Pick<SitePublicationLink, "url" | "hostname">): string {
  try {
    return new URL(link.url).hostname || link.hostname;
  } catch {
    return link.hostname;
  }
}

/**
 * Open the published Site. In the desktop app it opens in the default
 * browser through the shell and returns true; elsewhere it returns false so
 * the link opens its new tab itself.
 */
export function openPublishedSite(
  url: string,
  bridge: Pick<DesktopBridge, "openExternal"> | null = desktopCapability("openExternal"),
): boolean {
  if (!bridge) return false;
  void bridge.openExternal(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
  return true;
}

const CONTROL =
  "inline-flex h-7 items-center rounded-md text-2xs font-medium text-fg-muted outline-hidden transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40";

export function SitePublicLink({
  load,
  workspaceId,
  siteId,
  canPublish,
  openExternal = openPublishedSite,
}: {
  load: SitePublicationLinkLoad;
  workspaceId: string;
  siteId: string;
  /** Offer Publish on an unpublished Site. */
  canPublish: boolean;
  /** The desktop path; returns true when it handled the open. */
  openExternal?: ((url: string) => boolean) | undefined;
}) {
  const link = publishedSiteLink(load);
  if (link) return <PublishedLink {...link} openExternal={openExternal} />;
  if (load.state === "none" || (load.state === "ready" && load.link.status === "unpublished"))
    return (
      <span className="mr-1 hidden items-center gap-2 sm:inline-flex">
        <span className="inline-flex items-center gap-1.5 text-2xs font-medium text-fg-subtle">
          <span aria-hidden="true" className="size-1.5 rounded-full border border-fg-subtle" />
          Not published
        </span>
        {canPublish ? (
          <Link
            to="/workspaces/$workspaceId/artifacts/$artifactId"
            params={{ workspaceId, artifactId: siteId }}
            search={{ tab: "settings" }}
            className={cn(CONTROL, "px-1.5 text-fg")}
          >
            Publish
          </Link>
        ) : null}
      </span>
    );
  if (load.state === "ready" && load.link.status === "suspended")
    return (
      <span className="mr-1 hidden items-center gap-1.5 text-2xs font-medium text-fg-subtle sm:inline-flex">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-status-failed" />
        Taken down
      </span>
    );
  return null;
}

function PublishedLink({
  url,
  hostname,
  openExternal,
}: {
  url: string;
  hostname: string;
  openExternal: (url: string) => boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    // Modified clicks keep the browser's own behaviour (new window, etc.).
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    if (openExternal(url)) event.preventDefault();
  };
  const copy = async () => {
    if (!(await copyTextToClipboard(url))) return;
    setCopied(true);
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <TooltipProvider delayDuration={300}>
      <span data-site-public-link="" className="mr-1 inline-flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${hostname}`}
              onClick={open}
              className={cn(CONTROL, "gap-1.5 px-1.5")}
            >
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-status-success ring-4 ring-status-success/10"
              />
              Live
              <ArrowUpRightIcon aria-hidden="true" className="size-3" />
            </a>
          </TooltipTrigger>
          <TooltipContent side="bottom">{hostname}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Copy link"
              onClick={() => void copy()}
              className={cn(CONTROL, "gap-1 px-1.5", copied && "text-fg")}
            >
              {copied ? (
                <CheckIcon aria-hidden="true" className="size-3" />
              ) : (
                <CopyIcon aria-hidden="true" className="size-3" />
              )}
              {copied ? <span>Copied</span> : null}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Copy link</TooltipContent>
        </Tooltip>
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? "Link copied" : ""}
        </span>
      </span>
    </TooltipProvider>
  );
}
