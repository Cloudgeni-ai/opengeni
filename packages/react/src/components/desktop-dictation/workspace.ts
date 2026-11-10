// The workspace dictation from anywhere belongs to. The shortcut works in
// every app, so it never follows the workspace the window shows: it keeps the
// one saved in its settings. Until one is saved (the first time the app
// dictates), that is the person's default workspace.
import type { DesktopDictationSettings } from "@opengeni/sdk/desktop-bridge";

/** A workspace dictation can belong to, as its settings list it. */
export type DictationWorkspaceChoice = {
  id: string;
  name: string;
  /** Its organization's name, to tell workspaces apart across organizations. */
  organization?: string | undefined;
  /** The person's Personal workspace, private to them. */
  personal?: boolean | undefined;
  /** Voice input is turned off there, so it can't take dictations. */
  voiceInputOff?: boolean | undefined;
};

export type DictationWorkspace = {
  /** Where dictations go; null while there is no workspace to use. */
  workspaceId: string | null;
  /**
   * Its name, with its organization's in brackets when another of the
   * person's workspaces has the same name; for a workspace that is gone, the
   * name it was saved with.
   */
  name: string | null;
  /** It is the person's Personal workspace. */
  personal: boolean;
  /** It is the saved one, rather than the default used until one is saved. */
  saved: boolean;
  /** The saved workspace is no longer one of the person's. */
  gone: boolean;
};

/**
 * Where dictations go: the saved workspace while it is one of the person's,
 * never another in its place; with none saved, their default workspace (the
 * first of theirs when that isn't known).
 */
export function dictationWorkspace(
  settings: Pick<DesktopDictationSettings, "workspace"> | null | undefined,
  workspaces: ReadonlyArray<DictationWorkspaceChoice>,
  defaultWorkspaceId: string | null | undefined,
): DictationWorkspace {
  const saved = settings?.workspace ?? null;
  if (saved) {
    const found = workspaces.find((workspace) => workspace.id === saved.id);
    return found
      ? {
          workspaceId: found.id,
          name: plainName(found, workspaces),
          personal: found.personal === true,
          saved: true,
          gone: false,
        }
      : { workspaceId: null, name: saved.name, personal: false, saved: true, gone: true };
  }
  const fallback =
    workspaces.find((workspace) => workspace.id === defaultWorkspaceId) ?? workspaces[0] ?? null;
  return {
    workspaceId: fallback?.id ?? null,
    name: fallback ? plainName(fallback, workspaces) : null,
    personal: fallback?.personal === true,
    saved: false,
    gone: false,
  };
}

/** "Legal", or "Legal (Acme Inc.)" while another of the person's workspaces is a "Legal" too. */
function plainName(
  choice: DictationWorkspaceChoice,
  workspaces: ReadonlyArray<DictationWorkspaceChoice>,
): string {
  const shared = workspaces.some(
    (other) => other.id !== choice.id && other.name.trim() === choice.name.trim(),
  );
  return shared && choice.organization ? `${choice.name} (${choice.organization})` : choice.name;
}
