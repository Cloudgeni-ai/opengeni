// The workspace dictation from anywhere belongs to, for the desktop app's
// dictation shortcut and its settings: the one saved on this computer, or
// the person's default workspace until one is saved.
import { resolveWorkspaceVoiceInputEnabled } from "@opengeni/contracts";
import { useAppContext } from "@opengeni/react/app/app-context";
import { t } from "@opengeni/react/app/lib/console-text";
import {
  isPersonalWorkspace,
  navigableWorkspaces,
} from "@opengeni/react/app/lib/managed-self-context";
import { organizationsForSubject } from "@opengeni/react/app/lib/org";
import {
  dictationWorkspace,
  type DictationWorkspace,
  type DictationWorkspaces,
  type UseDesktopDictationResult,
} from "@opengeni/react/desktop-dictation";
import { useMemo } from "react";

/** The person's workspaces, by organization then name, and their default one. */
export function useDictationWorkspaces(): DictationWorkspaces {
  const { accessContext, workspaces, managedSelfContext } = useAppContext();
  return useMemo(() => {
    const organizations = organizationsForSubject(t, accessContext, workspaces);
    const order = new Map(
      organizations.map((organization, index) => [organization.accountId, index]),
    );
    const label = new Map(
      organizations.map((organization) => [organization.accountId, organization.label]),
    );
    const choices = navigableWorkspaces(workspaces, managedSelfContext)
      .map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        organization: label.get(workspace.accountId),
        personal: isPersonalWorkspace(workspace, managedSelfContext),
        voiceInputOff: resolveWorkspaceVoiceInputEnabled(workspace.settings) === false,
        order: order.get(workspace.accountId) ?? organizations.length,
      }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map(({ order: _order, ...choice }) => choice);
    return { choices, defaultWorkspaceId: accessContext.defaultWorkspaceId };
  }, [accessContext, managedSelfContext, workspaces]);
}

/**
 * Where this computer's dictations go now; null until the app's dictation
 * settings are read, so a press waits rather than going elsewhere.
 */
export function useDictationHome(
  status: UseDesktopDictationResult["status"],
  workspaces: DictationWorkspaces,
): DictationWorkspace | null {
  return useMemo(
    () =>
      status
        ? dictationWorkspace(status.settings, workspaces.choices, workspaces.defaultWorkspaceId)
        : null,
    [status, workspaces],
  );
}
