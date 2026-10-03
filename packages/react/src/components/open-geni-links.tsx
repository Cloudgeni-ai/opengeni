import type { OpenGeniClient, OpenGeniLinkTarget } from "@opengeni/sdk";
import { createContext, useContext, useMemo, type ReactNode } from "react";

export type { OpenGeniLinkTarget };

/**
 * How the host opens one OpenGeni object an agent linked in chat Markdown.
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
 * Resolve OpenGeni object links (`artifact:`, `sandbox:`, editable artifacts,
 * Sites) for every {@link Markdown} body below. An inner provider is asked
 * before an outer one, so a host can override a single kind and keep defaults.
 */
export function OpenGeniLinkProvider({
  resolveLink,
  children,
}: {
  resolveLink: OpenGeniLinkResolver | null | undefined;
  children: ReactNode;
}) {
  const parent = useContext(OpenGeniLinkContext);
  const value = useMemo(() => chainLinkResolvers(resolveLink, parent), [resolveLink, parent]);
  return <OpenGeniLinkContext.Provider value={value}>{children}</OpenGeniLinkContext.Provider>;
}

/** The effective resolver from the nearest {@link OpenGeniLinkProvider}. */
export function useOpenGeniLinkResolver(): OpenGeniLinkResolver | null {
  return useContext(OpenGeniLinkContext);
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

function openUrl(url: string): void {
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
 * Default resolver for a session conversation that talks to OpenGeni through
 * the normal SDK client (for example behind `createSessionProxyHandler`):
 *
 * - `artifact:<file>` downloads the retained file through a short-lived URL.
 * - `sandbox:<path>` downloads when enabled by the host proxy capability.
 *
 * Editable artifacts and Sites have no default: they need a host surface
 * (see `@opengeni/react/artifacts/*` and `@opengeni/react/sites`), so they stay
 * unavailable until the host resolves them.
 */
export function sessionLinkResolver(input: {
  client: SessionLinkClient;
  workspaceId: string;
  sessionId: string;
  sandboxFiles?: boolean;
}): OpenGeniLinkResolver {
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
          openUrl(url);
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
          if (file.truncated) throw new Error("File is too large to download here.");
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
