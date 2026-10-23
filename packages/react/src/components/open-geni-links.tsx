import type { OpenGeniClient, OpenGeniLinkTarget } from "@opengeni/sdk";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { type OpenGeniText } from "../messages/runtime";

export type { OpenGeniLinkTarget };

/**
 * How the host opens one Opengeni object an agent linked in chat Markdown.
 *
 * - `{ href }` renders a real link (new tab) — use it for a host page URL.
 * - `{ open }` renders a button that runs the action (download, open a panel,
 *   client-side navigation) with loading and retry states.
 * - `null` / `undefined` means "not handled here": the next resolver is asked,
 *   and when none handles it the text renders as an unavailable reference —
 *   never as a navigation that would 404 inside the host.
 */
export type OpenGeniLinkResolution =
  | { href: string; open?: undefined }
  | { open: () => void | Promise<void>; href?: undefined };

export type OpenGeniLinkResolver = (
  target: OpenGeniLinkTarget,
) => OpenGeniLinkResolution | null | undefined;

const OpenGeniLinkContext = createContext<OpenGeniLinkResolver | null>(null);

/**
 * One ordinary link in an agent's Markdown that the host may draw itself:
 * its own scheme (`myapp:order/42`), an in-app path, or a web URL.
 */
export type OpenGeniHostLink = {
  /** The destination exactly as the agent wrote it. It is not sanitized: check it before use. */
  href: string;
  /** The rendered link text. */
  children: ReactNode;
  /**
   * The link is the only content of its paragraph or list item, so the host
   * can draw it as a block (a card or preview) instead of inline text.
   */
  standalone: boolean;
};

/**
 * Draw a host-owned link in agent Markdown. Return `undefined` to keep the
 * default rendering (web links open in a new tab; other schemes are shown as
 * unavailable). Opengeni object links (`artifact:`, `sandbox:`) never reach
 * it; use {@link OpenGeniLinkResolver} for those.
 */
export type OpenGeniLinkRenderer = (link: OpenGeniHostLink) => ReactNode | undefined;

const OpenGeniLinkRendererContext = createContext<OpenGeniLinkRenderer | null>(null);

/** First renderer that draws a link wins. */
export function chainLinkRenderers(
  ...renderers: ReadonlyArray<OpenGeniLinkRenderer | null | undefined>
): OpenGeniLinkRenderer | null {
  const active = renderers.filter((renderer): renderer is OpenGeniLinkRenderer =>
    Boolean(renderer),
  );
  if (active.length === 0) return null;
  if (active.length === 1) return active[0]!;
  return (link) => {
    for (const renderer of active) {
      const rendered = renderer(link);
      if (rendered !== undefined) return rendered;
    }
    return undefined;
  };
}

/** First resolver that handles a target wins. */
export function chainLinkResolvers(
  ...resolvers: ReadonlyArray<OpenGeniLinkResolver | null | undefined>
): OpenGeniLinkResolver | null {
  const active = resolvers.filter((resolver): resolver is OpenGeniLinkResolver =>
    Boolean(resolver),
  );
  if (active.length === 0) return null;
  if (active.length === 1) return active[0]!;
  return (target) => {
    for (const resolver of active) {
      const resolution = resolver(target);
      if (resolution) return resolution;
    }
    return null;
  };
}

/**
 * Resolve Opengeni object links (`artifact:`, `sandbox:`, editable artifacts,
 * Sites) for every {@link Markdown} body below. An inner provider is asked
 * before an outer one, so a host can override a single kind and keep defaults.
 * `renderLink` draws the host's own links (its scheme, in-app paths, web
 * URLs) in the same bodies, inner provider first.
 */
export function OpenGeniLinkProvider({
  resolveLink,
  renderLink,
  children,
}: {
  resolveLink?: OpenGeniLinkResolver | null | undefined;
  renderLink?: OpenGeniLinkRenderer | null | undefined;
  children: ReactNode;
}) {
  const parent = useContext(OpenGeniLinkContext);
  const parentRenderer = useContext(OpenGeniLinkRendererContext);
  const value = useMemo(() => chainLinkResolvers(resolveLink, parent), [resolveLink, parent]);
  const renderer = useMemo(
    () => chainLinkRenderers(renderLink, parentRenderer),
    [renderLink, parentRenderer],
  );
  return (
    <OpenGeniLinkContext.Provider value={value}>
      <OpenGeniLinkRendererContext.Provider value={renderer}>
        {children}
      </OpenGeniLinkRendererContext.Provider>
    </OpenGeniLinkContext.Provider>
  );
}

/** The effective resolver from the nearest {@link OpenGeniLinkProvider}. */
export function useOpenGeniLinkResolver(): OpenGeniLinkResolver | null {
  return useContext(OpenGeniLinkContext);
}

/** The effective host link renderer from the nearest {@link OpenGeniLinkProvider}. */
export function useOpenGeniLinkRenderer(): OpenGeniLinkRenderer | null {
  return useContext(OpenGeniLinkRendererContext);
}

// Every sandbox read the proxy forwards is bounded by the API's own maximum.
const SANDBOX_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

type SessionLinkClient = Partial<Pick<OpenGeniClient, "createFileDownloadUrl" | "fsRead">>;

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function openUrl(t: OpenGeniText, url: string): void {
  // A signed download URL is attachment-disposition; an anchor click keeps the
  // page and survives popup blockers after the awaited URL request.
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  document.body.append(link);
  link.click();
  link.remove();
}

function base64Bytes(content: string): Uint8Array<ArrayBuffer> {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Default resolver for a session conversation that talks to Opengeni through
 * the normal SDK client (for example behind `createSessionProxyHandler`):
 *
 * - `artifact:<file>` downloads the retained file through a short-lived URL.
 * - `sandbox:<path>` downloads unless the client config reports `sandboxFiles: false`.
 *
 * Editable artifacts and Sites have no default: they need a host surface
 * (see `@opengeni/react/artifacts/*` and `@opengeni/react/sites`), so they stay
 * unavailable until the host resolves them.
 */
export function sessionLinkResolver(
  t: OpenGeniText,
  input: {
    client: SessionLinkClient;
    workspaceId: string;
    sessionId: string;
    sandboxFiles?: boolean;
  },
): OpenGeniLinkResolver {
  const { client, workspaceId, sessionId } = input;
  return (target) => {
    if (target.kind === "file") {
      if (target.workspaceId !== null && target.workspaceId !== workspaceId) return null;
      if (typeof client.createFileDownloadUrl !== "function") return null;
      return {
        open: async () => {
          const { url } = await client.createFileDownloadUrl!(workspaceId, target.fileId, {
            sessionId,
          });
          openUrl(t, url);
        },
      };
    }
    if (target.kind === "sandbox-file") {
      if (input.sandboxFiles === false) return null;
      if (typeof client.fsRead !== "function") return null;
      return {
        open: async () => {
          const file = await client.fsRead!(workspaceId, sessionId, {
            path: target.path,
            encoding: "base64",
            maxBytes: SANDBOX_DOWNLOAD_MAX_BYTES,
          });
          if (file.truncated) throw new Error(t("openGeniLinks.fileIsTooLargeTo"));
          const name = file.path.split(/[\\/]/u).at(-1) || "download";
          const bytes =
            file.encoding === "base64"
              ? base64Bytes(file.content)
              : new TextEncoder().encode(file.content);
          saveBlob(new Blob([bytes], { type: "application/octet-stream" }), name);
        },
      };
    }
    return null;
  };
}

/** An editable artifact or Site to open in a host-mounted viewer. */
export type OpenGeniViewerTarget = Readonly<{
  kind: "editable-artifact" | "site";
  artifactId: string;
  /** The link text the agent wrote, until the viewer loads the real title. */
  title?: string | undefined;
}>;

/**
 * "Open in host viewer": resolve agent links to editable artifacts and Sites
 * in this workspace to `open(target)`, for example to mount
 * `SessionArtifactViewer` beside the conversation. Other targets fall through.
 */
export function viewerLinkResolver(input: {
  workspaceId: string;
  open: (target: OpenGeniViewerTarget) => void;
}): OpenGeniLinkResolver {
  return (target) => {
    if (target.kind !== "editable-artifact" && target.kind !== "site") return null;
    if (target.workspaceId !== input.workspaceId) return null;
    return { open: () => input.open({ kind: target.kind, artifactId: target.artifactId }) };
  };
}
