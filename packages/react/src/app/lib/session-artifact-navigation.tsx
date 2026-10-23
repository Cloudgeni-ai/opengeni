import { openGeniConsolePath, type OpenGeniLinkTarget } from "@opengeni/sdk";
import { useCallback } from "react";
import type { OpenGeniLinkResolver } from "../../components/open-geni-links";
import { useNavigate } from "./navigation";
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
 * Agent `session:<id>` references to chats in this workspace. The link points
 * at the chat's console route, so ⌘/Ctrl-click and the context menu treat it
 * as an ordinary page (a new tab, or the browser from the desktop app), and a
 * plain click opens the chat here without reloading the app.
 */
export function useSessionReferenceResolver(workspaceId: string): OpenGeniLinkResolver {
  const navigate = useNavigate();
  return useCallback(
    (target: OpenGeniLinkTarget) => {
      if (target.kind !== "session") return null;
      const workspace = target.workspaceId ?? workspaceId;
      const href = openGeniConsolePath(target, workspace);
      if (!href) return null;
      return {
        href,
        open: () =>
          void navigate({
            to: "/workspaces/$workspaceId/sessions/$sessionId",
            params: { workspaceId: workspace, sessionId: target.sessionId },
          }),
      };
    },
    [navigate, workspaceId],
  );
}
