// The desktop app's dictation shortcut records here, above the workspace
// pages: every dictation goes to the workspace saved for dictation on this
// computer, so moving between workspaces in the window never stops one.
// Loaded only inside a desktop app with dictation.
import { resolveWorkspaceVoiceInputEnabled } from "@opengeni/contracts";
import { useAppContext } from "@opengeni/react/app/app-context";
import { DesktopDictationHost, useDesktopDictation } from "@opengeni/react/desktop-dictation";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { useDictationHome, useDictationWorkspaces } from "./dictation-workspace";

export function DesktopDictationRoot() {
  const { client, workspaces: all } = useAppContext();
  const { status, update } = useDesktopDictation();
  const workspaces = useDictationWorkspaces();
  const home = useDictationHome(status, workspaces);
  const workspace = all.find((candidate) => candidate.id === home?.workspaceId);
  const navigate = useNavigate();
  const { workspaceId: shown } = useParams({ strict: false }) as { workspaceId?: string };

  // The default workspace is saved the first time the app dictates with this
  // version, so a later change of default never moves where dictations go
  // (or who pays) without the person choosing it. A renamed workspace keeps
  // its new name, for naming it should the person leave it.
  const saved = status?.settings.workspace;
  useEffect(() => {
    if (!status?.settings.enabled || saved === undefined || !home?.workspaceId || !home.name) {
      return;
    }
    if (saved === null || (!home.gone && saved.name !== home.name)) {
      void update({ workspace: { id: home.workspaceId, name: home.name } });
    }
  }, [home, saved, status?.settings.enabled, update]);

  const openSettings = useCallback(() => {
    const target = home?.workspaceId ?? shown ?? workspaces.choices[0]?.id;
    if (!target) return;
    void navigate({
      to: "/workspaces/$workspaceId/computer-use",
      params: { workspaceId: target },
      hash: "dictation",
    });
  }, [home?.workspaceId, navigate, shown, workspaces.choices]);

  // An app that saves the workspace also shows Open settings on its popup;
  // an older one shows the whole message with where to fix it.
  const canOpenSettings = saved !== undefined;
  return (
    <DesktopDictationHost
      client={client}
      workspaceId={home?.workspaceId ?? null}
      workspaceName={home?.name ?? null}
      workspaceGone={home?.gone ?? false}
      onOpenSettings={canOpenSettings ? openSettings : undefined}
      enabled={
        workspace ? (resolveWorkspaceVoiceInputEnabled(workspace.settings) ?? true) : undefined
      }
    />
  );
}
