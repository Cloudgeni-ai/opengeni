import type { OpenGeniClient, Workspace } from "@opengeni/sdk";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { useAccount } from "@/account";
import { openInBrowser, setAppLinkHandler } from "@/app-link-registry";
import { accountForAppLink, appSessionPath, parseAppLink, type AppLink } from "@/app-links";
import { dismissToHome } from "@/navigation";

/*
 * Opengeni links open in the app when the app can show them: a conversation
 * or a workspace on a deployment the person is signed in to. A conversation
 * opens on top of the current screen, so Back returns to where they were.
 * Everything else (settings, other deployments, other sites) opens in the
 * browser. Links tapped in the app and links handed over from the web
 * (opengeni://open?url=…) take the same route.
 */

/** A link waiting for its account to finish switching in (the switch remounts the app). */
let pendingLink: { accountId: string; link: AppLink } | null = null;

/** Which of the person's workspaces holds a session the link names without one. */
async function findSessionWorkspace(
  client: OpenGeniClient,
  sessionId: string,
  workspaces: readonly Workspace[],
  currentId: string | null,
): Promise<string | null> {
  const ordered = [...workspaces].sort((a, b) =>
    a.id === currentId ? -1 : b.id === currentId ? 1 : 0,
  );
  for (const workspace of ordered) {
    try {
      await client.getSession(workspace.id, sessionId);
      return workspace.id;
    } catch {
      // Not in this workspace (or not readable here); try the next.
    }
  }
  return null;
}

interface OpenContext {
  client: OpenGeniClient;
  workspaces: readonly Workspace[];
  workspaceId: string | null;
  setWorkspaceId(id: string): void;
}

/** Open a link in the account already in use. */
async function openHere(link: AppLink, context: OpenContext): Promise<void> {
  const known = (id: string) => context.workspaces.some((workspace) => workspace.id === id);
  if (link.sessionId) {
    const workspaceId =
      link.workspaceId && known(link.workspaceId)
        ? link.workspaceId
        : link.workspaceId
          ? null
          : await findSessionWorkspace(
              context.client,
              link.sessionId,
              context.workspaces,
              context.workspaceId,
            );
    if (!workspaceId) return openInBrowser(link.webUrl);
    router.push(appSessionPath(link.sessionId, workspaceId, link.at));
    return;
  }
  if (link.workspaceId && known(link.workspaceId)) {
    context.setWorkspaceId(link.workspaceId);
    dismissToHome();
    return;
  }
  openInBrowser(link.webUrl);
}

/**
 * Owns link routing for the signed-in app: registers the handler, and finishes
 * opening a link once the account it needed has switched in.
 */
export function AppLinkRouting() {
  const {
    accounts,
    account,
    status,
    accessContext,
    client,
    workspaces,
    workspaceId,
    switchAccount,
    setWorkspaceId,
  } = useAccount();
  const context: OpenContext = { client, workspaces, workspaceId, setWorkspaceId };
  const contextRef = useRef(context);
  contextRef.current = context;
  const ready = status === "ready" && accessContext !== null;

  useEffect(() => {
    setAppLinkHandler((url) => {
      const link = parseAppLink(url);
      const owner = link ? accountForAppLink(link, accounts, account?.id ?? null) : null;
      if (!link || !owner) return openInBrowser(link?.webUrl ?? url);
      if (owner.id !== account?.id) {
        pendingLink = { accountId: owner.id, link };
        switchAccount(owner.id);
        return;
      }
      if (!ready) {
        pendingLink = { accountId: owner.id, link };
        return;
      }
      void openHere(link, contextRef.current).catch(() => openInBrowser(link.webUrl));
    });
    return () => setAppLinkHandler(null);
  }, [account?.id, accounts, ready, switchAccount]);

  useEffect(() => {
    const target = pendingLink;
    if (!target || !ready || account?.id !== target.accountId) return;
    pendingLink = null;
    void openHere(target.link, contextRef.current).catch(() => openInBrowser(target.link.webUrl));
  }, [account?.id, ready]);

  return null;
}
