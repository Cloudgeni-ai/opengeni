import type { OpenGeniText } from "@opengeni/react/messages";
import { relativeTimeLabel } from "@opengeni/react/session-list-model";
import {
  openGeniConsolePath,
  type AccessContext,
  type ArtifactCatalogItem,
  type ArtifactCatalogKind,
  type OpenGeniLinkTarget,
} from "@opengeni/sdk";
import { permissionSetCovers } from "@opengeni/contracts/personal-integration-setup";
import type { SFSymbol } from "sf-symbols-typescript";

/*
 * The Artifacts screen and viewer in words and rules, shared with the web
 * library: the same type names, the same menu and the same Delete wording.
 * Kept free of React Native so it is tested directly.
 */

export type ArtifactKindFilter = "all" | Exclude<ArtifactCatalogKind, "file">;

/** The type chips, in the web library's order. Files show under All. */
export const ARTIFACT_KIND_FILTERS: readonly { kind: ArtifactKindFilter; label: string }[] = [
  { kind: "all", label: "All" },
  { kind: "site", label: "Apps" },
  { kind: "document", label: "Documents" },
  { kind: "presentation", label: "Presentations" },
  { kind: "spreadsheet", label: "Spreadsheets" },
  { kind: "image", label: "Images" },
];

export const ARTIFACT_KIND_LABEL: Record<ArtifactCatalogKind, string> = {
  site: "App",
  document: "Document",
  presentation: "Presentation",
  spreadsheet: "Spreadsheet",
  image: "Image",
  file: "File",
};

/** The web library's type glyphs, as native icon names. */
export const ARTIFACT_KIND_ICON = {
  site: "globe",
  document: "file-text",
  presentation: "presentation",
  spreadsheet: "table-2",
  image: "image",
  file: "file",
} as const satisfies Record<ArtifactCatalogKind, string>;

export type EditableKind = "document" | "spreadsheet" | "presentation";

export function isEditableKind(kind: ArtifactCatalogKind): kind is EditableKind {
  return kind === "document" || kind === "spreadsheet" || kind === "presentation";
}

/** The key a list row and the viewer cache share: IDs are unique within a kind. */
export function artifactKey(item: Pick<ArtifactCatalogItem, "kind" | "id">): string {
  return `${item.kind}:${item.id}`;
}

/** "Edited 2h ago", the one fact under every card's title. */
export function editedLabel(t: OpenGeniText, updatedAt: string, now = new Date()): string {
  const when = relativeTimeLabel(t, updatedAt, now);
  if (!when) return "";
  if (when === "now") return "Edited just now";
  return /^\d+[mhd]$/u.test(when) ? `Edited ${when} ago` : `Edited ${when}`;
}

/** What the empty list says, for the filter and search in use. */
export function emptyListWords(
  kind: ArtifactKindFilter,
  query: string,
): { title: string; body: string } {
  const noun =
    kind === "all"
      ? "artifacts"
      : (ARTIFACT_KIND_FILTERS.find((each) => each.kind === kind)?.label ?? "").toLowerCase();
  if (query.trim()) return { title: `No ${noun} match “${query.trim()}”`, body: "" };
  return {
    title: kind === "all" ? "No artifacts yet" : `No ${noun} yet`,
    body: "Apps, documents, presentations and files your agents make show up here.",
  };
}

/** The deployment's web address of an artifact, for Share and Copy link. */
export function artifactWebUrl(
  baseUrl: string,
  workspaceId: string,
  item: Pick<ArtifactCatalogItem, "kind" | "id">,
): string {
  const path = openGeniConsolePath(artifactLinkTarget(item, workspaceId), workspaceId) ?? "";
  return `${baseUrl.replace(/\/+$/u, "")}${path}`;
}

/** The link target an artifact of a catalog kind is opened through. */
export function artifactLinkTarget(
  item: Pick<ArtifactCatalogItem, "kind" | "id">,
  workspaceId: string,
): OpenGeniLinkTarget {
  if (item.kind === "site") return { kind: "site", artifactId: item.id, workspaceId };
  if (isEditableKind(item.kind))
    return { kind: "editable-artifact", artifactId: item.id, workspaceId };
  return { kind: "file", fileId: item.id, workspaceId };
}

/** How the viewer draws an artifact. */
export type ArtifactViewerMode = "site" | "image" | "file" | "editable";

export function viewerMode(kind: ArtifactCatalogKind): ArtifactViewerMode {
  if (kind === "site") return "site";
  if (kind === "image") return "image";
  if (isEditableKind(kind)) return "editable";
  return "file";
}

/**
 * The web app's chromeless page the viewer shows a Site or an editable
 * artifact in (the app draws the header). Images and files are drawn natively.
 * `page` opens a Site at one of its own pages (a sidebar link's path).
 */
export function nativeViewPath(
  workspaceId: string,
  item: Pick<ArtifactCatalogItem, "kind" | "id">,
  page?: string | undefined,
): string | null {
  const ws = encodeURIComponent(workspaceId);
  const id = encodeURIComponent(item.id);
  if (item.kind === "site") {
    const at = typeof page === "string" && page.startsWith("/") && page !== "/" ? page : null;
    return `/native-view/workspaces/${ws}/sites/${id}${at ? `?page=${encodeURIComponent(at)}` : ""}`;
  }
  if (isEditableKind(item.kind)) return `/native-view/workspaces/${ws}/artifacts/editable/${id}`;
  return null;
}

/** Inside the viewer's web page: same-origin pages stay; other addresses open outside. */
export function viewerKeepsNavigation(
  baseUrl: string,
  request: { url: string; isTopFrame?: boolean | undefined },
): boolean {
  // A Site draws in its own frame (another origin); only the page itself is held.
  if (request.isTopFrame === false) return true;
  if (request.url.startsWith("about:") || request.url.startsWith("blob:")) return true;
  try {
    return new URL(request.url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * The viewer's address for a chat link. Retained files may be images; the
 * viewer settles that from the file itself. Sessions and sandbox files are
 * not artifacts.
 */
export function viewerParamsForLink(
  target: OpenGeniLinkTarget,
  fallbackWorkspaceId: string,
): { id: string; kind: ArtifactCatalogKind; workspaceId: string } | null {
  switch (target.kind) {
    case "site":
      return { id: target.artifactId, kind: "site", workspaceId: target.workspaceId };
    case "editable-artifact":
      // The link does not say which editor; the viewer reads it from the artifact.
      return {
        id: target.artifactId,
        kind: "document",
        workspaceId: target.workspaceId ?? fallbackWorkspaceId,
      };
    case "file":
      return {
        id: target.fileId,
        kind: "file",
        workspaceId: target.workspaceId ?? fallbackWorkspaceId,
      };
    default:
      return null;
  }
}

/** The viewer route for an artifact. */
export function viewerPath(params: {
  id: string;
  kind: ArtifactCatalogKind;
  workspaceId: string;
  title?: string | undefined;
  /** The chat it was opened from: its menu has no Open chat back into it. */
  from?: string | undefined;
  /** A Site's own page to open at (a sidebar link's path). */
  page?: string | undefined;
}): string {
  const query = new URLSearchParams({ kind: params.kind, workspaceId: params.workspaceId });
  if (params.title) query.set("title", params.title.slice(0, 200));
  if (params.from) query.set("from", params.from);
  if (params.page) query.set("page", params.page);
  return `/artifact/${encodeURIComponent(params.id)}?${query.toString()}`;
}

/** Original-format download, by kind. Documents and presentations have no exporter yet. */
export function downloadFormat(item: Pick<ArtifactCatalogItem, "kind" | "versionId">) {
  switch (item.kind) {
    case "site":
      return item.versionId ? ("html" as const) : null;
    case "image":
    case "file":
      return "original" as const;
    case "spreadsheet":
      return "xlsx" as const;
    default:
      return null;
  }
}

/**
 * Whether the file viewer may draw a file in place: only passive types (PDF,
 * plain text, images, audio, video). Markup the server serves as an
 * attachment (HTML, SVG, XML) and anything unknown opens outside instead.
 */
export function fileOpensInline(contentType: string | null | undefined): boolean {
  const essence = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (essence === "application/pdf" || essence === "text/plain") return true;
  if (essence === "image/svg+xml") return false;
  return /^(image|audio|video)\/[a-z0-9.+-]+$/u.test(essence);
}

export type ArtifactMenuAction =
  | "open-chat"
  | "pin"
  | "unpin"
  | "duplicate"
  | "copy-link"
  | "download"
  | "delete";

export type ArtifactMenuItem = {
  id: ArtifactMenuAction;
  title: string;
  /** SF Symbol for the iOS menu. */
  symbol: SFSymbol;
  destructive?: boolean;
  /** Starts a new group (a divider before it). */
  section: "open" | "share" | "danger";
};

/**
 * The ⋯ menu, as the web library's: Open chat, Pin, Duplicate (Sites), then
 * Copy link and Download, then Delete… for documents, spreadsheets and
 * presentations. Each appears only when the person can do it.
 */
export function artifactMenu(
  item: Pick<ArtifactCatalogItem, "kind" | "status" | "pinned" | "sourceSessionId" | "versionId">,
  options: {
    accessContext: AccessContext | null;
    workspaceId: string;
    /** The chat the viewer was opened from: no Open chat back into it. */
    fromSessionId?: string | null | undefined;
    /** Pin state is known (it comes from the list, not every link). */
    pinKnown: boolean;
  },
): ArtifactMenuItem[] {
  const can = (permission: string) => {
    const grant = options.accessContext?.workspaceGrants.find(
      (candidate) => candidate.workspaceId === options.workspaceId,
    );
    return Boolean(
      grant &&
      (permissionSetCovers(grant.permissions, permission) ||
        grant.permissions.includes("workspace:admin")),
    );
  };
  const active = item.status !== "archived";
  const menu: ArtifactMenuItem[] = [];
  if (item.sourceSessionId && item.sourceSessionId !== options.fromSessionId)
    menu.push({ id: "open-chat", title: "Open chat", symbol: "bubble.left", section: "open" });
  // Pinning changes the workspace's library, so it needs publish, as on the web.
  if (options.pinKnown && active && can("artifacts:publish"))
    menu.push(
      item.pinned
        ? { id: "unpin", title: "Unpin", symbol: "pin.slash", section: "open" }
        : { id: "pin", title: "Pin", symbol: "pin", section: "open" },
    );
  if (item.kind === "site" && item.versionId && active && can("artifacts:publish"))
    menu.push({
      id: "duplicate",
      title: "Duplicate",
      symbol: "plus.square.on.square",
      section: "open",
    });
  menu.push({ id: "copy-link", title: "Copy link", symbol: "link", section: "share" });
  if (downloadFormat(item))
    menu.push({
      id: "download",
      title: "Download",
      symbol: "arrow.down.circle",
      section: "share",
    });
  if (isEditableKind(item.kind) && active && can("artifacts:publish"))
    menu.push({
      id: "delete",
      title: "Delete…",
      symbol: "trash",
      destructive: true,
      section: "danger",
    });
  return menu;
}

/** The web library's Delete confirmation. */
export function deleteConfirmation(item: Pick<ArtifactCatalogItem, "kind" | "title">) {
  return {
    title: `Delete ${item.title}?`,
    message: "It's removed from Artifacts and can't be opened again.",
    confirm: `Delete ${ARTIFACT_KIND_LABEL[item.kind].toLowerCase()}`,
  };
}

/**
 * The file a Site version's captured preview is kept in on the device: one per
 * workspace, version and theme (a version's page never changes). Ids are
 * reduced to safe characters, so a file name never leaves its folder.
 */
export function sitePreviewFileName(
  workspaceId: string,
  versionId: string,
  scheme: "light" | "dark",
): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 80);
  return `v1-${safe(workspaceId)}-${safe(versionId)}-${scheme}.jpg`;
}
