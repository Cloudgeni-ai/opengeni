// Which parts of the session UI a surface shows. The web app shows everything;
// an embed picks a preset and switches single features on or off. A feature
// also needs the server and the person's permissions to allow it, which the
// components check themselves; a switch can only hide, never grant.
import { createContext, useContext, useMemo, type ReactNode } from "react";

export type SessionUiFeatures = Readonly<{
  /** The chat list: search, filters, projects, pins, archive, subagent rows. */
  chatList: boolean;
  /**
   * The session panel beside the chat: files, terminal, desktop, browser and
   * computer viewers, artifacts, the agent inspector. Loaded on demand.
   */
  dock: boolean;
  /** The workspace-admin access indicator and grant dialog in the header. */
  adminAccess: boolean;
  /** Global keyboard shortcut for a new chat (⌘/Ctrl+⇧O). */
  newChatShortcut: boolean;
  /** The Opengeni logo and wordmark at the top of the chat list. */
  brand: boolean;
}>;

export type SessionUiPreset = "app" | "companion" | "embed";

export const SESSION_UI_PRESETS: Readonly<Record<SessionUiPreset, SessionUiFeatures>> = {
  /** The web app and the desktop app. */
  app: { chatList: true, dock: true, adminAccess: true, newChatShortcut: true, brand: true },
  /**
   * First-party side panes (the Excel add-in): everything but admin access and
   * the page-wide new-chat shortcut.
   */
  companion: {
    chatList: true,
    dock: true,
    adminAccess: false,
    newChatShortcut: false,
    brand: true,
  },
  /**
   * A customer product page (the default): the chat list, chats and composer,
   * without Opengeni's brand, the session panel, admin access or page-wide
   * shortcuts until the host turns them on.
   */
  embed: { chatList: true, dock: false, adminAccess: false, newChatShortcut: false, brand: false },
};

const SessionUiFeaturesContext = createContext<SessionUiFeatures>(SESSION_UI_PRESETS.app);

export function SessionUiFeaturesProvider(props: {
  preset?: SessionUiPreset | undefined;
  features?: Partial<SessionUiFeatures> | undefined;
  children?: ReactNode;
}) {
  const preset = props.preset ?? "app";
  const overrides = props.features;
  const value = useMemo(
    () => ({ ...SESSION_UI_PRESETS[preset], ...overrides }),
    // Hosts often pass an inline object; compare by content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset, JSON.stringify(overrides ?? {})],
  );
  return (
    <SessionUiFeaturesContext.Provider value={value}>
      {props.children}
    </SessionUiFeaturesContext.Provider>
  );
}

/** Whether this surface shows a feature. Without a provider: the web app's full UI. */
export function useSessionUiFeature(feature: keyof SessionUiFeatures): boolean {
  return useContext(SessionUiFeaturesContext)[feature];
}
