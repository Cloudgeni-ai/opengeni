import { useNavigate, useStringifySearch } from "../../lib/navigation";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import {
  CopyIcon,
  ImageIcon,
  LayoutGridIcon,
  LinkIcon,
  ListIcon,
  LockIcon,
  LockKeyholeIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PanelsTopLeftIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { toast } from "../../lib/toast";

import { Button } from "../../../ui/button";
import { ConfirmDialog } from "../../../ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { EmptyState, EmptyStateLink } from "../../../ui/empty-state";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "../../../ui/list-row";
import { MetaChip } from "../../../ui/meta-chip";
import { Notice } from "../../../ui/notice";
import { RelativeTime } from "../../../ui/relative-time";
import { SegmentedControl } from "../../../ui/segmented-control";
import { Skeleton } from "../../../ui/skeleton";
import { StatusBadge } from "../../../ui/status-badge";
import {
  Toolbar,
  ToolbarFilterChips,
  ToolbarFilterMenu,
  ToolbarGroup,
  ToolbarSearch,
  type ToolbarFilterGroup,
  type ToolbarFilterValue,
} from "../../../ui/toolbar";
import { useAppContext } from "../../app-context";
import { HTML_FRAME_STILL_POLICY } from "@opengeni/contracts/html-frame-host";
import {
  SITE_PREVIEW_TIMEOUT_MS,
  SITE_PREVIEW_WIDTH,
  sitePreviewDocument,
  sitePreviewPainted,
} from "@opengeni/sdk/site-preview";
import { createEditableArtifactReplicaId } from "@opengeni/sdk/editable-artifacts";
import { resolveSiteUiStylesheet } from "@opengeni/sdk/site-ui";
import { useContentHosting } from "../../../lib/content-hosting";
import { htmlFrameHostSrc, useHtmlFrameHost } from "../../../components/artifacts/html-frame-host";
import { hasWorkspacePermission } from "../../lib/permissions";
import { invalidateArtifactCatalog } from "../../lib/use-artifact-catalog";
import { useDuplicateSite } from "../../lib/use-duplicate-site";
import {
  editableArtifactAudienceCopy,
  FILE_AUDIENCE_COPY,
  useArtifactAudience,
} from "./site-audience";
import { apiErrorAdvice, isPermissionDenied, userErrorText } from "../../../ui/api-error";
import { ARTIFACT_ACCESS_REQUIRED } from "../../lib/artifact-access";
import {
  artifactKey,
  artifactKindLabel,
  artifactKinds,
  artifactPath,
  artifactRoute,
  isEditableArtifactKind,
  type ArtifactCatalogFilters,
  type ArtifactKind,
} from "../../lib/artifact-catalog";
import {
  artifactExtension,
  readArtifactView,
  rememberArtifactView,
  type ArtifactView,
} from "../../lib/artifact-library-view";
import { useSimplifiedInterface } from "../../lib/simplified-interface";
import { cn } from "../../lib/utils";
import type { ArtifactReturnSearch } from "../../lib/routes";
import { ArtifactKindTile, ArtifactTypeIcon } from "./artifact-page-chrome";
import { useCopyArtifactLink } from "./copy-artifact-link";

const InlineChatImage = lazy(() =>
  import("./inline-chat-image").then((module) => ({
    default: module.InlineChatImage,
  })),
);
const ArtifactViewer = lazy(() =>
  import("./artifact-viewer").then((module) => ({ default: module.ArtifactViewer })),
);

const IMAGE_GLYPH = <ImageIcon className="size-4 text-fg-subtle" aria-hidden />;

export type ArtifactPinAction = (item: ArtifactCatalogItem, pinned: boolean) => Promise<void>;
/**
 * Deletes a document, spreadsheet or presentation (archives it, so it leaves
 * the list and no longer opens), then refreshes the list.
 */
export type ArtifactArchiveAction = (item: ArtifactCatalogItem) => Promise<void>;

function PinnedMarker() {
  return (
    <span title="Pinned" className="inline-flex shrink-0 items-center text-fg-muted">
      <PinIcon aria-hidden className="size-3.5 fill-current" />
      <span className="sr-only">Pinned</span>
    </span>
  );
}

/** A Site, file or document only its owner (the viewer) can open, marked like an Only me schedule. */
function OnlyMeMarker({ bare = false }: { bare?: boolean | undefined }) {
  return (
    <MetaChip icon={<LockIcon />} {...(bare ? { variant: "text" as const } : {})}>
      Only me
    </MetaChip>
  );
}

function onlyMe(item: ArtifactCatalogItem): boolean {
  return item.visibility === "private";
}

function isEditableKind(
  kind: ArtifactCatalogItem["kind"],
): kind is "document" | "spreadsheet" | "presentation" {
  return kind === "document" || kind === "spreadsheet" || kind === "presentation";
}

/**
 * Share or limit a file or document from its row, with the same
 * confirmation as its page. Only its owner sees the choice.
 */
function useLibraryFileAudience(workspaceId: string, item: ArtifactCatalogItem) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const editable = isEditableKind(item.kind);
  const owned = Boolean(
    (item.kind === "file" || item.kind === "image" || editable) &&
    item.ownedByViewer &&
    item.visibility &&
    item.status === "active" &&
    hasWorkspacePermission(
      context.accessContext,
      workspaceId,
      editable ? "artifacts:publish" : "files:upload",
    ),
  );
  const audience = useArtifactAudience({
    client: context.client,
    workspaceId,
    workspaceName: workspace?.name ?? "this workspace",
    title: item.title,
    visibility: item.visibility === "private" ? "private" : "workspace",
    ownedByCurrentUser: owned,
    copy: isEditableKind(item.kind) ? editableArtifactAudienceCopy(item.kind) : FILE_AUDIENCE_COPY,
    canLimitToMe: true,
    update: async (visibility) => {
      if (isEditableKind(item.kind))
        await context.client.updateEditableArtifactVisibility(workspaceId, item.id, {
          visibility,
        });
      else await context.client.updateFileVisibility(workspaceId, item.id, { visibility });
      invalidateArtifactCatalog(context.client, workspaceId);
    },
  });
  const menuItem = !owned ? null : audience.share ? (
    <DropdownMenuItem onSelect={audience.share}>
      <UsersIcon />
      Share with workspace…
    </DropdownMenuItem>
  ) : audience.limit ? (
    <DropdownMenuItem onSelect={audience.limit}>
      <LockKeyholeIcon />
      Limit to me…
    </DropdownMenuItem>
  ) : null;
  return { menuItem, dialog: owned ? audience.dialog : null };
}

/** Mount retained-image loaders only near the viewport, not merely their img elements. */
export function ArtifactThumbnail({
  children,
  placeholder = IMAGE_GLYPH,
}: {
  children: ReactNode;
  placeholder?: ReactNode | undefined;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={host} className="flex h-full w-full items-center justify-center">
      {visible ? children : placeholder}
    </div>
  );
}

/** An image's own pixels in the 32px row tile, loaded only near the viewport. */
function ImageTile({ workspaceId, item }: { workspaceId: string; item: ArtifactCatalogItem }) {
  return (
    // The image's own pixels; while it loads or when it can't, the image glyph
    // (the words stay for screen readers, never squeezed into 32px).
    <span className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-surface-2 [&_[role=status]]:sr-only [&_img]:relative [&_img]:size-full [&_img]:bg-surface-2 [&_img]:object-cover">
      <ImageIcon aria-hidden className="absolute size-4 text-fg-subtle" />
      <ArtifactThumbnail placeholder={null}>
        <Suspense fallback={<ImageIcon className="size-4 text-fg-subtle" aria-hidden />}>
          <InlineChatImage
            workspaceId={workspaceId}
            artifactId={item.id}
            alt={item.title}
            thumbnail
          />
        </Suspense>
      </ArtifactThumbnail>
    </span>
  );
}

const TYPE_GROUP: ToolbarFilterGroup = {
  id: "type",
  label: "Type",
  options: artifactKinds
    .filter(([kind]) => kind !== "all")
    .map(([kind, label]) => ({ id: kind, label })),
};
const STATUS_GROUP: ToolbarFilterGroup = {
  id: "status",
  label: "Status",
  options: [{ id: "archived", label: "Archived" }],
};
const SORT_GROUP: ToolbarFilterGroup = {
  id: "sort",
  label: "Sort",
  options: [
    { id: "newest", label: "Newest first" },
    { id: "title", label: "Title" },
  ],
};

/** The toolbar's filter value for the catalog filters (defaults are no filter). */
function filterValueFor(filters: ArtifactCatalogFilters, withType: boolean): ToolbarFilterValue {
  return {
    ...(withType && filters.kind !== "all" ? { type: [filters.kind] } : {}),
    ...(filters.status === "archived" ? { status: ["archived"] } : {}),
    ...(filters.sort !== "updated" ? { sort: [filters.sort] } : {}),
  };
}

/** Every group is one value: keep the option picked last. */
function lastPicked(previous: ToolbarFilterValue, next: ToolbarFilterValue, group: string) {
  const ids = next[group] ?? [];
  if (ids.length <= 1) return ids[0];
  const before = previous[group] ?? [];
  return ids.filter((id) => !before.includes(id)).at(-1);
}

function isPlainClick(event: MouseEvent<HTMLElement>) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Images and files are looked at, so a click shows them in the list's viewer.
 * Sites and documents are worked on, so a click opens them in the session's
 * panel as before; the viewer still steps through them.
 */
function opensInViewer(item: ArtifactCatalogItem) {
  return item.kind === "image" || item.kind === "file";
}

/**
 * What a page adds to one artifact: badges beside it, entries in its ⋯ menu,
 * and the seed of its tile's hue (an app from a ready-made package keeps
 * that package's hue).
 */
export type ArtifactItemExtras = { badges?: ReactNode; menu?: ReactNode; seed?: string };

type ArtifactOpenOptions = {
  workspaceId: string;
  item: ArtifactCatalogItem;
  extras?: ArtifactItemExtras | undefined;
  sessionId?: string | undefined;
  onSelect?: ((item: ArtifactCatalogItem) => void) | undefined;
  /** A plain click on an image or file shows it in the list's viewer instead. */
  onView?: ((item: ArtifactCatalogItem) => void) | undefined;
  onPin?: ArtifactPinAction | undefined;
  onArchive?: ArtifactArchiveAction | undefined;
  loading?: boolean | undefined;
  browseSearch?: ArtifactReturnSearch | undefined;
};

/**
 * Opening an artifact: its own page in the router, or the caller's handler.
 * With a viewer, a plain click on an image or file shows it there; the menu's
 * Open still opens it.
 */
function useArtifactOpen({
  workspaceId,
  item,
  extras,
  sessionId,
  onSelect,
  onView,
  onPin,
  onArchive,
  loading = false,
  browseSearch,
}: ArtifactOpenOptions) {
  const navigate = useNavigate();
  const stringifySearch = useStringifySearch();
  const audience = useLibraryFileAudience(workspaceId, item);
  const { accessContext } = useAppContext();
  const copies = useDuplicateSite(workspaceId);
  const copyArtifactLink = useCopyArtifactLink(workspaceId);
  const canDuplicate =
    item.kind === "site" &&
    Boolean(item.versionId) &&
    hasWorkspacePermission(accessContext, workspaceId, "artifacts:publish");
  const [pinning, setPinning] = useState(false);
  const pinInFlight = useRef(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const deleted = useRef(false);
  // A deleted item leaves the list with its menu, so focus moves to the search.
  const focusAfterDelete = {
    get current() {
      return deleted.current
        ? document.querySelector<HTMLElement>('input[aria-label="Search artifacts by title"]')
        : null;
    },
  };
  const canArchive = Boolean(onArchive && isEditableKind(item.kind) && item.status === "active");
  const archive = async () => {
    if (!onArchive) return false;
    try {
      await onArchive(item);
      deleted.current = true;
      toast(`Deleted ${item.title}`);
      return true;
    } catch (error) {
      toast.error("Couldn't delete", { description: userErrorText(error) });
      return false;
    }
  };
  const togglePin = async () => {
    if (!onPin || pinInFlight.current || loading) return;
    pinInFlight.current = true;
    setPinning(true);
    const pinned = !item.pinned;
    try {
      await onPin(item, pinned);
      toast(pinned ? "Artifact pinned" : "Artifact unpinned");
    } catch (error) {
      toast.error(pinned ? "Couldn't pin artifact" : "Couldn't unpin artifact", {
        description: userErrorText(error),
      });
    } finally {
      pinInFlight.current = false;
      setPinning(false);
    }
  };
  const open = () =>
    onSelect
      ? onSelect(item)
      : item.kind === "site"
        ? // An app opens on its own page, the same however it's opened.
          void navigate({
            to: "/workspaces/$workspaceId/apps/$appId/$",
            params: { workspaceId, appId: item.id, _splat: "" },
          })
        : void navigate({
            to: artifactRoute(item.kind),
            params: { workspaceId, artifactId: item.id },
            search: browseSearch ?? (sessionId ? { fromSession: sessionId } : {}),
          });
  const menu = (
    <>
      <DropdownMenuItem onSelect={open}>
        <PanelsTopLeftIcon />
        Open
      </DropdownMenuItem>
      {extras?.menu}
      {onPin ? (
        <DropdownMenuItem disabled={pinning || loading} onSelect={() => void togglePin()}>
          {item.pinned ? <PinOffIcon /> : <PinIcon />}
          {pinning ? "Saving…" : item.pinned ? "Unpin" : "Pin"}
        </DropdownMenuItem>
      ) : null}
      {audience.menuItem}
      {canDuplicate ? (
        <DropdownMenuItem
          disabled={copies.busy}
          // In the session workbench the copy is offered, not opened.
          onSelect={() => void copies.duplicate(item, { open: !onSelect })}
        >
          <CopyIcon />
          {copies.busy ? "Duplicating…" : "Duplicate"}
        </DropdownMenuItem>
      ) : null}
      {item.sourceSessionId && item.sourceSessionId !== sessionId ? (
        <DropdownMenuItem
          onSelect={() =>
            void navigate({
              to: "/workspaces/$workspaceId/sessions/$sessionId",
              params: { workspaceId, sessionId: item.sourceSessionId! },
            })
          }
        >
          <MessageSquareIcon />
          Open source session
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => void copyArtifactLink(item)}>
        <LinkIcon />
        Copy link
      </DropdownMenuItem>
      {canArchive ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingArchive(true)}>
            <Trash2Icon />
            Delete…
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
  const archiveDialog = canArchive ? (
    <ConfirmDialog
      open={confirmingArchive}
      onOpenChange={setConfirmingArchive}
      title={`Delete ${item.title}?`}
      description="It's removed from Artifacts and can't be opened again."
      confirmLabel={`Delete ${artifactKindLabel[item.kind].toLowerCase()}`}
      pendingLabel="Deleting…"
      restoreFocusFallbackRef={focusAfterDelete}
      onConfirm={archive}
    />
  ) : null;
  const activate = onView && opensInViewer(item) ? () => onView(item) : open;
  return {
    open: activate,
    menu,
    dialog: (
      <>
        {audience.dialog}
        {archiveDialog}
      </>
    ),
    // Links keep a real href (new tab, copy); a plain click stays in the router.
    link: onSelect
      ? null
      : {
          href:
            item.kind === "site"
              ? artifactPath(workspaceId, item)
              : browseSearch
                ? `${artifactPath(workspaceId, item)}${stringifySearch(browseSearch)}`
                : artifactPath(workspaceId, item, sessionId),
          onClick: (event: MouseEvent<HTMLElement>) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            activate();
          },
        },
  };
}

/** "updated 3 days ago", the one fact after the type in every meta line. */
function updatedMeta(item: ArtifactCatalogItem) {
  return (
    <span key="updated">
      updated <RelativeTime date={item.updatedAt} inSentence focusable={false} />
    </span>
  );
}

/** The date column every artifact list ends with, before the ⋯ menu. */
const ARTIFACT_COLUMNS: RowListColumn[] = [
  {
    id: "updated",
    label: "Updated",
    width: 112,
    align: "end",
    hideLabel: true,
  },
];

export function ArtifactRow({
  workspaceId,
  item,
  extras,
  sessionId,
  onSelect,
  onView,
  onPin,
  onArchive,
  loading,
  browseSearch,
}: {
  workspaceId: string;
  item: ArtifactCatalogItem;
  sessionId?: string | undefined;
  onSelect?: ((item: ArtifactCatalogItem) => void) | undefined;
  onView?: ((item: ArtifactCatalogItem) => void) | undefined;
  onPin?: ArtifactPinAction | undefined;
  onArchive?: ArtifactArchiveAction | undefined;
  loading?: boolean | undefined;
  browseSearch?: ArtifactReturnSearch | undefined;
  extras?: ArtifactItemExtras | undefined;
}) {
  const { open, menu, link, dialog } = useArtifactOpen({
    workspaceId,
    item,
    extras,
    sessionId,
    onSelect,
    onView,
    onPin,
    onArchive,
    loading,
    browseSearch,
  });
  const archived = item.status === "archived";
  return (
    <>
      <ListRow
        // A tile for the kind of artifact; an image shows its own pixels.
        leading={
          item.kind === "image" ? (
            <ImageTile workspaceId={workspaceId} item={item} />
          ) : (
            <ArtifactKindTile kind={item.kind} seed={extras?.seed ?? item.id} />
          )
        }
        title={item.title}
        titleAddon={
          item.pinned || onlyMe(item) ? (
            <span className="inline-flex items-center gap-2">
              {item.pinned ? <PinnedMarker /> : null}
              {onlyMe(item) ? <OnlyMeMarker /> : null}
            </span>
          ) : undefined
        }
        meta={[
          artifactKindLabel[item.kind],
          item.kind === "file" && item.filename && item.filename !== item.title
            ? item.filename
            : null,
        ].filter((part): part is string => Boolean(part))}
        status={
          archived ? (
            <StatusBadge variant="dot" tone="neutral">
              Archived
            </StatusBadge>
          ) : extras?.badges ? (
            <span className="relative z-10 inline-flex flex-wrap items-center gap-1.5">
              {extras.badges}
            </span>
          ) : undefined
        }
        cells={{ updated: <RelativeTime date={item.updatedAt} /> }}
        {...(link ? { href: link.href, onOpen: link.onClick } : { onOpen: open })}
        menu={menu}
        menuLabel={`More actions for ${item.title}`}
      />
      {dialog}
    </>
  );
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

/*
 * A Site's card shows its published HTML as it looks when opened, laid out at
 * a desktop width and scaled into the card like a screenshot.
 *
 * With an HTML frame host configured (a page with a strict policy, see
 * `configureContentHosting`), the card renders the preview document of
 * `@opengeni/sdk/site-preview` there: the page's own scripts run in an
 * opaque-origin frame that may run scripts and nothing else (no same-origin,
 * forms, popups or navigation of the console), with no Site bridge, and its
 * policy blocks every call the page could make. The page reports whether it
 * painted anything; until it does the card keeps its type glyph, and a page
 * that stays blank (or never reports) leaves the glyph in place.
 *
 * Without a frame host, a srcdoc frame shows a still instead: an empty
 * sandbox (no scripts, forms, popups or same-origin) and a policy that blocks
 * every network request. The first element of the document is the policy, so
 * it always lands in <head> whatever the Site's own markup. The frame also
 * requires the same policy from outside (the `csp` attribute, CSP Embedded
 * Enforcement), so browsers that support it enforce the policy on the srcdoc
 * document before any of its markup is parsed or speculatively preloaded.
 */
const SITE_STILL_POLICY = HTML_FRAME_STILL_POLICY;
// `csp` is a standard iframe attribute React passes through but doesn't type.
const SITE_STILL_FRAME_POLICY = { csp: SITE_STILL_POLICY };
export function siteStillDocument(html: string) {
  // The opt-in Opengeni look is inlined (the policy allows inline styles), so
  // a still is styled like the page instead of falling back to bare serif text.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${SITE_STILL_POLICY}"><meta name="color-scheme" content="light">${resolveSiteUiStylesheet(html)}`;
}

// Display HTML per published version, shared across remounts (tabs, search).
const siteHtmlCache = new Map<string, Promise<string>>();
const SITE_HTML_CACHE_LIMIT = 48;

function useSiteHtml(workspaceId: string, item: ArtifactCatalogItem) {
  const { client, accessKeyVersion } = useAppContext();
  const versionId = item.versionId;
  const [state, setState] = useState<{
    key: string;
    html: string | null;
  } | null>(null);
  const key = `${accessKeyVersion}:${workspaceId}:${item.id}:${versionId}`;
  useEffect(() => {
    if (!versionId) return;
    let active = true;
    let request = siteHtmlCache.get(key);
    if (!request) {
      request = client.getWorkspaceArtifactHtml(workspaceId, item.id, {
        versionId,
      });
      siteHtmlCache.set(key, request);
      if (siteHtmlCache.size > SITE_HTML_CACHE_LIMIT)
        siteHtmlCache.delete(siteHtmlCache.keys().next().value!);
      request.catch(() => siteHtmlCache.delete(key));
    }
    request.then(
      (html) => active && setState({ key, html }),
      () => active && setState({ key, html: null }),
    );
    return () => {
      active = false;
    };
  }, [client, item.id, key, versionId, workspaceId]);
  return state?.key === key ? state.html : undefined;
}

/*
 * Previews load a few at a time, so a page of cards never runs every Site's
 * scripts at once. A slot is held from mount until the preview reports.
 */
const SITE_PREVIEW_SLOTS = 3;
let sitePreviewsLoading = 0;
const sitePreviewQueue: Array<() => void> = [];

function releaseSitePreviewSlot() {
  const next = sitePreviewQueue.shift();
  if (next) next();
  else sitePreviewsLoading = Math.max(0, sitePreviewsLoading - 1);
}

function useSitePreviewSlot(enabled: boolean): { granted: boolean; release: () => void } {
  const [granted, setGranted] = useState(false);
  const heldRef = useRef(false);
  const release = useCallback(() => {
    if (!heldRef.current) return;
    heldRef.current = false;
    releaseSitePreviewSlot();
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const grant = () => {
      if (!active) return releaseSitePreviewSlot();
      heldRef.current = true;
      setGranted(true);
    };
    if (sitePreviewsLoading < SITE_PREVIEW_SLOTS) {
      sitePreviewsLoading += 1;
      grant();
    } else sitePreviewQueue.push(grant);
    return () => {
      active = false;
      const queued = sitePreviewQueue.indexOf(grant);
      if (queued >= 0) sitePreviewQueue.splice(queued, 1);
      release();
    };
  }, [enabled, release]);
  return { granted, release };
}

type SitePreviewState = "loading" | "painted" | "blank";

function SiteStill({
  workspaceId,
  item,
  placeholder,
}: {
  workspaceId: string;
  item: ArtifactCatalogItem;
  placeholder: ReactNode;
}) {
  const html = useSiteHtml(workspaceId, item);
  const [preview, setPreview] = useState<{ html: string; state: SitePreviewState } | null>(null);
  if (!html) return placeholder;
  const state = preview?.html === html ? preview.state : "loading";
  return (
    <>
      {state === "painted" ? null : placeholder}
      {state === "blank" ? null : (
        // A touch dimmer in dark, so a white page doesn't glare.
        <div
          className={cn(
            "pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-200 dark:brightness-[0.88]",
            state === "painted" ? "opacity-100" : "opacity-0",
          )}
          inert
        >
          <SiteStillFrame
            key={html}
            title={`Preview of ${item.title}`}
            html={html}
            onSettled={(painted) => setPreview({ html, state: painted ? "painted" : "blank" })}
          />
        </div>
      )}
    </>
  );
}

/** The frame's box, and the scale that fits a desktop-width page into it. */
function useSitePreviewScale(hostRef: { current: HTMLDivElement | null }) {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width > 0 && height > 0)
        setBox((current) =>
          current && current.width === width && current.height === height
            ? current
            : { width, height },
        );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [hostRef]);
  if (!box) return null;
  const scale = box.width / SITE_PREVIEW_WIDTH;
  return { scale, height: Math.ceil(box.height / scale) };
}

function SiteStillFrame({
  title,
  html,
  onSettled,
}: {
  title: string;
  html: string;
  onSettled: (painted: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameHostSrc = htmlFrameHostSrc(useContentHosting().htmlFrameHost);
  const live = frameHostSrc !== null;
  // The page's theme, read once the card is placed; a later switch doesn't
  // re-run the page.
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => setTheme(surroundingTheme(hostRef.current)), []);
  const documentHtml = useMemo(
    () => (live && theme ? sitePreviewDocument(html, { theme }) : html),
    [html, live, theme],
  );
  const { granted: slotGranted, release: releaseSlot } = useSitePreviewSlot(true);
  const fit = useSitePreviewScale(hostRef);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const settledRef = useRef(false);
  const settle = useCallback(
    (painted: boolean) => {
      if (settledRef.current) return;
      settledRef.current = true;
      releaseSlot();
      onSettledRef.current(painted);
    },
    [releaseSlot],
  );
  const frameHost = useHtmlFrameHost({
    frameRef,
    enabled: live && slotGranted && theme !== null,
    html: documentHtml,
    mode: "interactive",
  });
  useEffect(() => {
    if (!live || !slotGranted) return;
    const receive = (event: MessageEvent) => {
      // Only this card's own opaque-origin frame can report.
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow || event.origin !== "null") return;
      const painted = sitePreviewPainted(event.data);
      if (painted !== null) settle(painted);
    };
    window.addEventListener("message", receive);
    const timer = setTimeout(() => settle(false), SITE_PREVIEW_TIMEOUT_MS);
    return () => {
      window.removeEventListener("message", receive);
      clearTimeout(timer);
    };
  }, [live, slotGranted, settle]);
  const frameStyle = fit
    ? {
        width: `${SITE_PREVIEW_WIDTH}px`,
        height: `${fit.height}px`,
        transform: `scale(${fit.scale})`,
      }
    : undefined;
  return (
    <div ref={hostRef} className="absolute inset-0">
      {!fit || !slotGranted || !theme ? null : live ? (
        <iframe
          ref={frameRef}
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={frameHostSrc}
          onLoad={frameHost.onFrameLoad}
          tabIndex={-1}
          aria-hidden
          className={SITE_STILL_FRAME_CLASS}
          // A page that follows the system's scheme follows the card's theme.
          style={{ ...frameStyle, colorScheme: theme }}
        />
      ) : (
        <iframe
          title={title}
          sandbox=""
          {...SITE_STILL_FRAME_POLICY}
          srcDoc={siteStillDocument(html)}
          onLoad={() => settle(true)}
          tabIndex={-1}
          aria-hidden
          className={SITE_STILL_FRAME_CLASS}
          style={frameStyle}
        />
      )}
    </div>
  );
}

/** The theme the card is shown in: its nearest `data-og-theme`, else the system's. */
function surroundingTheme(element: Element | null): "light" | "dark" {
  const marked = element?.closest("[data-og-theme]")?.getAttribute("data-og-theme");
  if (marked === "light" || marked === "dark") return marked;
  if (element?.closest(".dark")) return "dark";
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

const SITE_STILL_FRAME_CLASS = "absolute top-0 left-0 origin-top-left border-0 bg-white";

/*
 * Documents, spreadsheets and presentations show a picture of their first
 * page, sheet or slide: a static SVG of shapes and text the API draws from the
 * current head. It is shown as an image, so nothing in it can run.
 */
const editablePictureCache = new Map<string, Promise<string>>();
const EDITABLE_PICTURE_CACHE_LIMIT = 48;

function useEditablePicture(workspaceId: string, item: ArtifactCatalogItem) {
  const { client, accessKeyVersion } = useAppContext();
  const key = `${accessKeyVersion}:${workspaceId}:${item.id}:${item.updatedAt}`;
  const [state, setState] = useState<{ key: string; src: string | null } | null>(null);
  useEffect(() => {
    let active = true;
    let request = editablePictureCache.get(key);
    if (!request) {
      request = Promise.resolve()
        .then(() =>
          client.getEditableArtifactPreview(workspaceId, item.id, {
            replicaId: createEditableArtifactReplicaId(),
          }),
        )
        .then((svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      editablePictureCache.set(key, request);
      if (editablePictureCache.size > EDITABLE_PICTURE_CACHE_LIMIT)
        editablePictureCache.delete(editablePictureCache.keys().next().value!);
      request.catch(() => editablePictureCache.delete(key));
    }
    request.then(
      (src) => active && setState({ key, src }),
      () => active && setState({ key, src: null }),
    );
    return () => {
      active = false;
    };
  }, [client, item.id, key, workspaceId]);
  return state?.key === key ? state.src : undefined;
}

function EditablePicture({
  workspaceId,
  item,
  placeholder,
}: {
  workspaceId: string;
  item: ArtifactCatalogItem;
  placeholder: ReactNode;
}) {
  const src = useEditablePicture(workspaceId, item);
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return placeholder;
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(src)}
      className={cn(
        "absolute inset-0 size-full bg-white object-cover dark:brightness-[0.88]",
        // A sheet reads from its top-left cell; a page or slide from its top centre.
        item.kind === "spreadsheet" ? "object-left-top" : "object-top",
      )}
    />
  );
}

/** Types without a still: the type glyph on a quiet tile, and a file's extension. */
function PreviewPlaceholder({ item }: { item: ArtifactCatalogItem }) {
  const extension = item.kind === "file" ? artifactExtension(item) : null;
  return (
    <span className="flex flex-col items-center gap-2 text-fg-subtle">
      <span className="grid size-10 place-items-center rounded-[10px] border border-border bg-surface text-fg-muted">
        <ArtifactTypeIcon kind={item.kind} className="size-5" />
      </span>
      {extension ? (
        <span className="text-2xs leading-4 font-medium text-fg-subtle">.{extension}</span>
      ) : null}
    </span>
  );
}

function ArtifactPreview({
  workspaceId,
  item,
}: {
  workspaceId: string;
  item: ArtifactCatalogItem;
}) {
  const placeholder = <PreviewPlaceholder item={item} />;
  if (item.kind === "image")
    return (
      <div className="absolute inset-0 [&_img]:size-full [&_img]:object-cover">
        <ArtifactThumbnail placeholder={placeholder}>
          <Suspense fallback={placeholder}>
            <InlineChatImage
              workspaceId={workspaceId}
              artifactId={item.id}
              alt={item.title}
              thumbnail
            />
          </Suspense>
        </ArtifactThumbnail>
      </div>
    );
  if (item.kind === "site" && item.versionId)
    return (
      <div className="absolute inset-0">
        <ArtifactThumbnail placeholder={placeholder}>
          <SiteStill workspaceId={workspaceId} item={item} placeholder={placeholder} />
        </ArtifactThumbnail>
      </div>
    );
  if (item.kind === "document" || item.kind === "spreadsheet" || item.kind === "presentation")
    return (
      <div className="absolute inset-0">
        <ArtifactThumbnail placeholder={placeholder}>
          <EditablePicture workspaceId={workspaceId} item={item} placeholder={placeholder} />
        </ArtifactThumbnail>
      </div>
    );
  return <div className="absolute inset-0 grid place-items-center">{placeholder}</div>;
}

export function ArtifactCard({
  workspaceId,
  item,
  sessionId,
  onSelect,
  onView,
  onPin,
  onArchive,
  loading,
  browseSearch,
  quiet = false,
  extras,
}: {
  workspaceId: string;
  item: ArtifactCatalogItem;
  sessionId?: string | undefined;
  onSelect?: ((item: ArtifactCatalogItem) => void) | undefined;
  onView?: ((item: ArtifactCatalogItem) => void) | undefined;
  onPin?: ArtifactPinAction | undefined;
  onArchive?: ArtifactArchiveAction | undefined;
  loading?: boolean | undefined;
  browseSearch?: ArtifactReturnSearch | undefined;
  /** Borderless, on a soft tile (the session panel). */
  quiet?: boolean | undefined;
  extras?: ArtifactItemExtras | undefined;
}) {
  const { open, menu, link, dialog } = useArtifactOpen({
    workspaceId,
    item,
    extras,
    sessionId,
    onSelect,
    onView,
    onPin,
    onArchive,
    loading,
    browseSearch,
  });
  const titleId = useId();
  const archived = item.status === "archived";
  // The title is the card's action, stretched over the whole card; the menu sits above it.
  const actionProps = {
    "aria-labelledby": titleId,
    style: { outline: "none" },
    className:
      "block min-w-0 truncate text-sm leading-5 font-medium text-fg after:absolute after:inset-0 after:z-0 after:rounded-[14px] after:content-['']",
  };
  return (
    <li
      className={cn(
        "group relative flex min-w-0 flex-col overflow-hidden rounded-[14px]",
        quiet
          ? "transition-colors duration-[120ms] hover:bg-surface-2/60"
          : "border border-border bg-surface transition-colors duration-[120ms] hover:border-border-strong",
        "has-[[data-card-action]:focus-visible]:outline-2 has-[[data-card-action]:focus-visible]:outline-offset-2 has-[[data-card-action]:focus-visible]:outline-brand/55",
      )}
    >
      <div
        className={cn(
          "relative aspect-[16/10] w-full overflow-hidden bg-surface-2",
          quiet ? "rounded-[12px]" : "border-b border-border",
          archived && "opacity-70 grayscale",
        )}
      >
        <ArtifactPreview workspaceId={workspaceId} item={item} />
      </div>
      {archived || item.pinned || onlyMe(item) ? (
        // On the preview, so the meta line keeps its one fact whole.
        <span className="absolute top-2.5 left-2.5 flex items-center gap-2 rounded-full bg-surface px-2 py-1">
          {item.pinned ? <PinnedMarker /> : null}
          {onlyMe(item) ? <OnlyMeMarker bare /> : null}
          {archived ? (
            <StatusBadge tone="neutral" icon="auto">
              Archived
            </StatusBadge>
          ) : null}
        </span>
      ) : null}
      <div
        className={cn(
          "flex min-w-0 items-start gap-2",
          quiet ? "px-1 pt-2 pb-1.5" : "px-3.5 pt-3 pb-3.5",
        )}
      >
        <div className="min-w-0 flex-1">
          {link ? (
            <a {...actionProps} data-card-action="" href={link.href} onClick={link.onClick}>
              <span id={titleId}>{item.title}</span>
            </a>
          ) : (
            <button
              {...actionProps}
              data-card-action=""
              type="button"
              onClick={open}
              className={cn(actionProps.className, "w-full cursor-pointer text-left")}
            >
              <span id={titleId}>{item.title}</span>
            </button>
          )}
          <p className="mt-0.5 truncate text-xs leading-4.5 text-fg-subtle">
            {artifactKindLabel[item.kind]} · {updatedMeta(item)}
          </p>
          {extras?.badges ? (
            // Above the card's stretched link, so a badge can be a button.
            <div className="relative z-10 mt-2 flex flex-wrap items-center gap-1.5">
              {extras.badges}
            </div>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`More actions for ${item.title}`}
              className={cn(
                "relative z-10 -mt-1 -mr-1.5 grid size-8 shrink-0 place-items-center rounded-[10px] text-fg-subtle transition-[color,background-color,opacity] duration-[120ms] hover:bg-surface-3 hover:text-fg data-[state=open]:bg-surface-3 data-[state=open]:text-fg pointer-coarse:size-11",
                // Quiet until the card is hovered or focused; always there for touch.
                "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100",
              )}
            >
              <MoreHorizontalIcon aria-hidden="true" className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {menu}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {dialog}
    </li>
  );
}

const GALLERY_GRID =
  "grid min-w-0 grid-cols-1 gap-4 @[560px]:grid-cols-2 @[820px]:grid-cols-3 @[1060px]:grid-cols-4";

function GallerySkeleton() {
  return (
    <ul aria-hidden className={GALLERY_GRID}>
      {[0, 1, 2, 3].map((index) => (
        <li key={index} className="overflow-hidden rounded-[14px] border border-border bg-surface">
          <Skeleton className="aspect-[16/10] w-full rounded-none" />
          <div className="space-y-2 px-3.5 pt-3 pb-3.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </li>
      ))}
    </ul>
  );
}

const VIEW_OPTIONS = [
  {
    value: "gallery",
    label: "Gallery",
    icon: <LayoutGridIcon />,
    iconOnly: true,
  },
  { value: "list", label: "List", icon: <ListIcon />, iconOnly: true },
] as const;

export function ArtifactLibrary({
  workspaceId,
  sessionId,
  items,
  filters,
  onFiltersChange,
  loading,
  error,
  onRetry,
  nextCursor,
  onLoadMore,
  onSelect,
  onPin,
  onArchive,
  compact = false,
  emptyAction,
  onEmptyChange,
  artifactKindsHidden = false,
  browseSearch,
  viewer = false,
  itemExtras,
  empty,
}: {
  workspaceId: string;
  sessionId?: string | undefined;
  items: readonly ArtifactCatalogItem[];
  filters: ArtifactCatalogFilters;
  onFiltersChange: (filters: ArtifactCatalogFilters) => void;
  loading: boolean;
  error?: Error | null | undefined;
  onRetry: () => void;
  nextCursor?: string | null | undefined;
  onLoadMore?: (() => void) | undefined;
  onSelect?: ((item: ArtifactCatalogItem) => void) | undefined;
  /** Omitted for viewers without permission to change workspace pins. */
  onPin?: ArtifactPinAction | undefined;
  onArchive?: ArtifactArchiveAction | undefined;
  /**
   * The session's artifact panel: no page tabs, so the type filter joins the
   * Filter menu.
   */
  compact?: boolean | undefined;
  /** The one action of the first-run empty state ("New artifact"). */
  emptyAction?: ReactNode | undefined;
  /** Nothing at all yet: the page hides its header action, the empty state has it. */
  onEmptyChange?: ((empty: boolean) => void) | undefined;
  /**
   * The viewer can't read Sites and editable artifacts here (no
   * `artifacts:read`), so the catalog omits them: say so instead of "none yet".
   */
  artifactKindsHidden?: boolean | undefined;
  /** Workspace library query carried into the full-page viewer, not embedded panels. */
  browseSearch?: ArtifactReturnSearch | undefined;
  /**
   * Images and files open in one large viewer that steps through this list
   * (the session panel). The workspace library browses on artifact pages.
   */
  viewer?: boolean | undefined;
  /** Badges and menu entries a page adds to each artifact (the Apps page's versions). */
  itemExtras?: ((item: ArtifactCatalogItem) => ArtifactItemExtras | undefined) | undefined;
  /** The first-run empty state's words, when the page lists some kinds only. */
  empty?: { title: string; description: string } | undefined;
}) {
  const { productName } = useSimplifiedInterface();
  const [view, setView] = useState<ArtifactView>(readArtifactView);
  const changeView = (next: ArtifactView) => {
    setView(next);
    rememberArtifactView(next);
  };
  // The artifact open in the viewer, which steps through `items` as listed.
  const [viewing, setViewing] = useState<string | null>(null);
  const showInViewer = (item: ArtifactCatalogItem) => setViewing(artifactKey(item));
  const closeViewer = useCallback(() => setViewing(null), []);
  const viewingItem = viewing ? items.find((item) => artifactKey(item) === viewing) : undefined;
  const groups = compact ? [TYPE_GROUP, STATUS_GROUP, SORT_GROUP] : [STATUS_GROUP, SORT_GROUP];
  const filterValue = filterValueFor(filters, compact);
  const setFilterValue = (next: ToolbarFilterValue) => {
    const kind = compact ? lastPicked(filterValue, next, "type") : undefined;
    const status = lastPicked(filterValue, next, "status");
    const sort = lastPicked(filterValue, next, "sort");
    onFiltersChange({
      ...filters,
      ...(compact ? { kind: (kind as ArtifactKind | undefined) ?? "all" } : {}),
      status: status === "archived" ? "archived" : "active",
      sort: (sort as ArtifactCatalogFilters["sort"] | undefined) ?? "updated",
    });
  };
  const searching = filters.q.trim().length > 0;
  const narrowed =
    searching ||
    filters.kind !== "all" ||
    filters.status !== "active" ||
    filters.sort !== "updated";
  const nothingAtAll = !loading && !error && items.length === 0 && !narrowed;
  useEffect(() => onEmptyChange?.(nothingAtAll), [nothingAtAll, onEmptyChange]);
  const kindLabel =
    filters.kind === "all"
      ? "artifacts"
      : (artifactKinds.find(([kind]) => kind === filters.kind)?.[1] ?? "").toLocaleLowerCase();

  // The flag comes from the viewer's loaded grant, which can be stale: once
  // the catalog returns a Site or editable artifact, the server has decided.
  const readsArtifactKinds = (kind: ArtifactKind) =>
    kind === "site" || isEditableArtifactKind(kind);
  const hiddenKindSelected =
    artifactKindsHidden &&
    filters.kind !== "all" &&
    readsArtifactKinds(filters.kind) &&
    !loading &&
    items.length === 0;
  const hiddenKindsNotice =
    artifactKindsHidden &&
    filters.kind === "all" &&
    !(error && isPermissionDenied(error)) &&
    !items.some((item) => readsArtifactKinds(item.kind));

  let body: ReactNode;
  if (hiddenKindSelected) {
    body = <Notice title={`You can't see ${kindLabel} here.`}>{ARTIFACT_ACCESS_REQUIRED}</Notice>;
  } else if (error && items.length === 0 && isPermissionDenied(error)) {
    body = <Notice title="You can't see artifacts here.">Ask a workspace admin for access.</Notice>;
  } else if (error && items.length === 0) {
    body = (
      <Notice
        tone="failed"
        title="Couldn't load artifacts"
        action={
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        }
        actionLayout="responsive"
      >
        {apiErrorAdvice(error)}
      </Notice>
    );
  } else if (loading && items.length === 0) {
    body = (
      <div role="status" aria-label="Loading artifacts">
        {view === "gallery" ? (
          <GallerySkeleton />
        ) : (
          <RowList label="Artifacts" columns={ARTIFACT_COLUMNS} flush={!compact} busy>
            <ListRowSkeleton count={4} />
          </RowList>
        )}
      </div>
    );
  } else if (nothingAtAll) {
    body = (
      <EmptyState
        variant={compact ? "inline" : "page"}
        icon={<PanelsTopLeftIcon />}
        title={empty?.title ?? "No artifacts yet"}
        description={
          empty?.description ??
          `Apps, images, documents, spreadsheets and presentations ${productName} makes show up here.`
        }
        action={emptyAction}
      />
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        variant="inline"
        title={
          searching
            ? `No ${kindLabel} match "${filters.q.trim()}".`
            : filters.status === "archived"
              ? `No archived ${kindLabel}. Archived apps keep their versions and can be restored.`
              : `No ${kindLabel} yet.`
        }
        action={
          searching || filters.status !== "active" || (compact && filters.kind !== "all") ? (
            <EmptyStateLink
              onClick={() =>
                onFiltersChange(
                  searching
                    ? { ...filters, q: "" }
                    : {
                        ...filters,
                        q: "",
                        status: "active",
                        ...(compact ? { kind: "all" as const } : {}),
                      },
                )
              }
            >
              {searching ? "Clear search" : "Clear filters"}
            </EmptyStateLink>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <div className="flex min-w-0 flex-col gap-4">
        {view === "gallery" ? (
          <ul
            aria-label={searching ? "Search results" : "Artifacts"}
            aria-busy={loading || undefined}
            className={cn(GALLERY_GRID, compact && "gap-x-3 gap-y-2")}
          >
            {items.map((item) => (
              <ArtifactCard
                key={artifactKey(item)}
                workspaceId={workspaceId}
                item={item}
                sessionId={sessionId}
                onSelect={onSelect}
                onView={viewer ? showInViewer : undefined}
                onPin={onPin}
                onArchive={onArchive}
                loading={loading}
                browseSearch={browseSearch}
                quiet={compact}
                extras={itemExtras?.(item)}
              />
            ))}
          </ul>
        ) : (
          <RowList
            label={searching ? "Search results" : "Artifacts"}
            columns={ARTIFACT_COLUMNS}
            flush={!compact}
            busy={loading}
          >
            {items.map((item) => (
              <ArtifactRow
                key={artifactKey(item)}
                workspaceId={workspaceId}
                item={item}
                sessionId={sessionId}
                onSelect={onSelect}
                onView={viewer ? showInViewer : undefined}
                onPin={onPin}
                onArchive={onArchive}
                loading={loading}
                browseSearch={browseSearch}
                extras={itemExtras?.(item)}
              />
            ))}
          </RowList>
        )}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            Couldn't load the latest artifacts. {userErrorText(error)}
          </p>
        ) : null}
        {nextCursor && onLoadMore ? (
          <Button
            type="button"
            variant="outline"
            className="self-start pointer-coarse:h-11"
            disabled={loading}
            onClick={onLoadMore}
          >
            {loading ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <section
      className="@container flex min-w-0 flex-col gap-4"
      aria-label={sessionId ? "Session artifact library" : "Artifact library"}
    >
      <div className={nothingAtAll ? "hidden" : "flex min-w-0 flex-col gap-3"}>
        <Toolbar>
          <ToolbarSearch
            value={filters.q}
            onValueChange={(q) => onFiltersChange({ ...filters, q })}
            placeholder={filters.kind === "site" ? "Search apps" : "Search artifacts"}
            aria-label="Search artifacts by title"
            maxLength={200}
          />
          <ToolbarGroup align="end">
            <ToolbarFilterMenu groups={groups} value={filterValue} onValueChange={setFilterValue} />
            <SegmentedControl<ArtifactView>
              aria-label="Show"
              options={VIEW_OPTIONS}
              value={view}
              onValueChange={changeView}
            />
          </ToolbarGroup>
        </Toolbar>
        {Object.keys(filterValue).length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <ToolbarFilterChips
              groups={groups}
              value={filterValue}
              onValueChange={setFilterValue}
            />
          </div>
        ) : null}
      </div>
      {hiddenKindsNotice ? (
        <Notice title="Apps and documents are hidden">{ARTIFACT_ACCESS_REQUIRED}</Notice>
      ) : null}
      <div className="min-w-0">{body}</div>
      {viewing ? (
        <Suspense fallback={null}>
          <ArtifactViewer
            workspaceId={workspaceId}
            items={items}
            currentKey={viewing}
            onCurrentKeyChange={setViewing}
            onClose={closeViewer}
            actions={
              viewingItem ? (
                <ArtifactViewerMenu
                  key={viewing}
                  workspaceId={workspaceId}
                  item={viewingItem}
                  sessionId={sessionId}
                  onSelect={onSelect}
                  onPin={onPin}
                  onArchive={onArchive}
                  loading={loading}
                  browseSearch={browseSearch}
                />
              ) : null
            }
          />
        </Suspense>
      ) : null}
    </section>
  );
}

/** The row's ⋯ menu in the viewer's header; its Open still opens the artifact itself. */
function ArtifactViewerMenu(props: Omit<ArtifactOpenOptions, "onView">) {
  const { menu, dialog } = useArtifactOpen(props);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="pointer-coarse:size-11"
            aria-label={`More actions for ${props.item.title}`}
          >
            <MoreHorizontalIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {menu}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}
