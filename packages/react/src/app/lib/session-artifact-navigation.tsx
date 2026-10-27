import { openGeniConsolePath, type OpenGeniLinkTarget } from "@opengeni/sdk";
import { useMemo } from "react";

import {
  chainLinkResolvers,
  useOpenGeniLinkResolver,
  type OpenGeniLinkResolver,
} from "../../components/open-geni-links";
// The host's page, read from the app host rather than `./navigation`, which
// many tests replace with a partial module mock.
import { useAppHost } from "./app-host";
import { useSessionUiFeature } from "./session-ui-features";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EDITABLE_ID = /^[0-9a-f]{32}$/iu;

/** Only canonical, same-origin/workspace artifact links belong in the session dock. */
export function sessionArtifactFromHref(href: string, origin: string, workspaceId: string) {
  if (href.startsWith("artifact:")) {
    const id = href.slice("artifact:".length);
    return UUID.test(id) ? { id: id.toLowerCase(), editable: false, kind: "file" as const } : null;
  }
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin || url.hash || url.username || url.password) return null;
    // Return context does not change the selected artifact. Version/download parameters do.
    for (const [key, value] of url.searchParams) {
      if (key !== "fromSession" || !UUID.test(value)) return null;
    }
    if (url.searchParams.getAll("fromSession").length > 1) return null;
    const parts = url.pathname.split("/");
    if (parts[1] !== "workspaces" || parts[2] !== workspaceId || parts[3] !== "artifacts")
      return null;
    const editable = parts[4] === "editable";
    const kind = parts[4] === "files" ? ("file" as const) : undefined;
    const nested = editable || kind !== undefined;
    const id = parts[nested ? 5 : 4];
    if (parts.length !== (nested ? 6 : 5) || !id) return null;
    if (!(editable ? EDITABLE_ID.test(id) : UUID.test(id))) return null;
    return { id, editable, ...(kind ? { kind } : {}) };
  } catch {
    return null;
  }
}

/**
 * In the console, agent-authored object links keep their own console routes.
 * `ArtifactLinkBoundary` still intercepts them for the session dock.
 */
export function consoleLinkResolver(target: OpenGeniLinkTarget): { href: string } | null {
  if (target.kind === "sandbox-file" || target.workspaceId === null) return null;
  const href = openGeniConsolePath(target, target.workspaceId);
  return href ? { href } : null;
}

/**
 * The app's resolver for object links in agent Markdown: the host's own
 * resolver (an `OpenGeniLinkProvider` around an embed) first, then the web
 * app's page for the object. In an embed that page is on the web app's
 * origin, not the host page's: with the dock on, the link carries the
 * absolute URL so the dock still intercepts it; with the dock off, it opens
 * that page beside the host through the embed's `openUrl`.
 */
export function useAppLinkResolver(): OpenGeniLinkResolver {
  const host = useOpenGeniLinkResolver();
  const page = useAppHost().navigation?.page;
  const dock = useSessionUiFeature("dock");
  return useMemo(() => {
    const console: OpenGeniLinkResolver = !page?.opensBeside
      ? consoleLinkResolver
      : (target) => {
          const resolved = consoleLinkResolver(target);
          if (!resolved) return null;
          if (dock) return { href: new URL(resolved.href, page.origin()).toString() };
          return { open: () => page.open(resolved.href) };
        };
    return chainLinkResolvers(host, console) ?? console;
  }, [dock, host, page]);
}

/**
 * {@link useAppLinkResolver} inside one workspace's session: a workspace-less
 * `artifact:` file link or `session:` chat link belongs to that workspace, as
 * it does in the agent's chat replies, so links in its questions and other
 * session text resolve the same way. The host's resolver still sees the link
 * first. With `openSession`, a plain click on a chat link opens the chat here
 * without reloading the app, while the link keeps the chat's page as its href,
 * so ⌘/Ctrl-click and the context menu treat it as an ordinary page (a new
 * tab, or the browser from the desktop app). An embed opens it beside the host.
 */
export function useWorkspaceAppLinkResolver(
  workspaceId: string,
  openSession?: (workspaceId: string, sessionId: string) => void,
): OpenGeniLinkResolver {
  const host = useOpenGeniLinkResolver();
  const app = useAppLinkResolver();
  const opensBeside = useAppHost().navigation?.page?.opensBeside === true;
  return useMemo(
    () =>
      chainLinkResolvers(
        host,
        openSession && !opensBeside
          ? (target) => {
              if (target.kind !== "session") return null;
              const workspace = target.workspaceId ?? workspaceId;
              const href = openGeniConsolePath(target, workspace);
              return href ? { href, open: () => openSession(workspace, target.sessionId) } : null;
            }
          : null,
        app,
        (target) =>
          (target.kind === "file" || target.kind === "session") && target.workspaceId === null
            ? app({ ...target, workspaceId })
            : null,
      ) ?? app,
    [app, host, opensBeside, openSession, workspaceId],
  );
}
