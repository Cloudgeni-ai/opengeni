import type { SitePublication, SitePublicationLink } from "@opengeni/contracts";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { DesktopBridge } from "@opengeni/sdk/desktop-bridge";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  GlobeIcon,
  LinkIcon,
  Settings2Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import { copyTextToClipboard } from "../../../lib/clipboard";
import { apiErrorFacts } from "../../../ui/api-error";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { desktopCapability } from "../../lib/desktop";
import { cn } from "../../lib/utils";

/* ----------------------------------------------------------------------------
   The Site view's one publication control. A Site on the web shows
   "Published": its menu names the address and opens or copies it. One that
   isn't shows Publish to people who can publish, and nothing to anyone else.
   Publishing and its settings open the same publish form as the Site's
   Settings, through `onOpenPublishing`. Access never changes the link.
   -------------------------------------------------------------------------- */

/** Where the Site's published address stands, from the API's answer. */
export type SitePublicationLinkLoad =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "forbidden" }
  | { state: "none" }
  | { state: "error"; error: unknown }
  | { state: "ready"; link: SitePublicationLink };

/**
 * The Site's published address, for anyone who can open the Site. `update`
 * shows a publication this page just changed without waiting for a read.
 */
export function useSitePublicationLink({
  client,
  workspaceId,
  siteId,
}: {
  client: Pick<OpenGeniBrowserClient, "getSitePublicationLink">;
  workspaceId: string;
  siteId: string;
}): {
  load: SitePublicationLinkLoad;
  update: (publication: Pick<SitePublication, "siteId" | "hostname" | "url" | "status">) => void;
} {
  // Keyed by Site, so moving to another Site never shows the last one's link.
  const key = `${workspaceId}/${siteId}`;
  const [answer, setAnswer] = useState<{ key: string; load: SitePublicationLinkLoad } | null>(null);
  // Read again when the person comes back to the window, so publishing from
  // the chat beside the Site or another tab shows here without a reload.
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") setRevision((value) => value + 1);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  // A change made here wins over a read already on its way.
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    request.current = abort;
    client
      .getSitePublicationLink(workspaceId, siteId, { signal: abort.signal })
      .then((link) => {
        if (!abort.signal.aborted) setAnswer({ key, load: { state: "ready", link } });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setAnswer({ key, load: sitePublicationLinkLoadFromError(error) });
      });
    return () => abort.abort();
  }, [client, key, revision, siteId, workspaceId]);
  const update = useCallback(
    ({
      siteId: publishedSiteId,
      hostname,
      url,
      status,
    }: Pick<SitePublication, "siteId" | "hostname" | "url" | "status">) => {
      request.current?.abort();
      setAnswer({
        key,
        load: { state: "ready", link: { siteId: publishedSiteId, hostname, url, status } },
      });
    },
    [key],
  );
  return { load: answer?.key === key ? answer.load : { state: "loading" }, update };
}

/**
 * Only the API's own "not published" answer means not published. Any other
 * 404 (an older API without this route, publishing off) shows nothing rather
 * than offering Publish for a Site that may be on the web.
 */
export function sitePublicationLinkLoadFromError(error: unknown): SitePublicationLinkLoad {
  const { status, code } = apiErrorFacts(error);
  if (code === "site_not_published") return { state: "none" };
  if (status === 404 || status === 503 || code === "sites_publishing_disabled")
    return { state: "unavailable" };
  if (status === 403) return { state: "forbidden" };
  return { state: "error", error };
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

/** The header's quiet control: the version chip's height, its type and hover. */
const CONTROL =
  "mr-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-2xs font-medium text-fg-muted outline-hidden transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:h-8";

export function SitePublicationControl({
  load,
  canPublish,
  onOpenPublishing,
  openExternal = openPublishedSite,
}: {
  load: SitePublicationLinkLoad;
  /** May publish the Site and change how it is published. */
  canPublish: boolean;
  /** Open the publish form: to publish, or for a published Site's settings. */
  onOpenPublishing: () => void;
  /** The desktop path; returns true when it handled the open. */
  openExternal?: ((url: string) => boolean) | undefined;
}) {
  const link = publishedSiteLink(load);
  if (link)
    return (
      <PublishedMenu
        {...link}
        openExternal={openExternal}
        onOpenPublishing={canPublish ? onOpenPublishing : undefined}
      />
    );
  const unpublished =
    load.state === "none" || (load.state === "ready" && load.link.status === "unpublished");
  if (unpublished)
    return canPublish ? (
      <button
        type="button"
        onClick={onOpenPublishing}
        data-site-publication="unpublished"
        className={cn(CONTROL, "text-fg")}
      >
        <GlobeIcon aria-hidden="true" className="size-3.5" />
        Publish
      </button>
    ) : null;
  if (load.state === "ready" && load.link.status === "suspended") {
    const content = (
      <>
        <span aria-hidden="true" className="size-1.5 rounded-full bg-status-failed" />
        Taken down
      </>
    );
    // Restoring is in the publish form, for the people who may.
    return canPublish ? (
      <button
        type="button"
        onClick={onOpenPublishing}
        data-site-publication="suspended"
        className={CONTROL}
      >
        {content}
      </button>
    ) : (
      <span data-site-publication="suspended" className={cn(CONTROL, "hover:bg-transparent")}>
        {content}
      </span>
    );
  }
  return null;
}

function PublishedMenu({
  url,
  hostname,
  openExternal,
  onOpenPublishing,
}: {
  url: string;
  hostname: string;
  openExternal: (url: string) => boolean;
  onOpenPublishing?: (() => void) | undefined;
}) {
  const [copy, setCopy] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    // Modified clicks keep the browser's own behaviour (new window, etc.).
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    if (openExternal(url)) event.preventDefault();
  };
  const copyLink = async () => {
    setCopy((await copyTextToClipboard(url)) ? "copied" : "failed");
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(() => setCopy(null), 2000);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Published at ${hostname}`}
          data-site-publication="published"
          className={cn(CONTROL, "gap-1 data-[state=open]:bg-hover data-[state=open]:text-fg")}
        >
          <span
            aria-hidden="true"
            className="mr-0.5 size-1.5 rounded-full bg-status-success ring-4 ring-status-success/10"
          />
          Published
          <ChevronDownIcon aria-hidden="true" className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="truncate" title={url}>
          {hostname}
        </DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <a href={url} target="_blank" rel="noopener noreferrer" onClick={open}>
            <ArrowUpRightIcon aria-hidden="true" />
            Open
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem
          // The menu stays open so "Copied" shows, in full screen too.
          onSelect={(event) => {
            event.preventDefault();
            void copyLink();
          }}
        >
          {copy === "copied" ? <CheckIcon aria-hidden="true" /> : <LinkIcon aria-hidden="true" />}
          {copy === "copied" ? "Copied" : copy === "failed" ? "Couldn't copy" : "Copy link"}
        </DropdownMenuItem>
        {onOpenPublishing ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenPublishing}>
              <Settings2Icon aria-hidden="true" />
              Publishing settings
            </DropdownMenuItem>
          </>
        ) : null}
        <span role="status" aria-live="polite" className="sr-only">
          {copy === "copied" ? "Link copied" : copy === "failed" ? "Couldn't copy the link" : ""}
        </span>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
