import type { SFSymbol } from "sf-symbols-typescript";

/**
 * Settings as data: one model, rendered by the platform's own list (a SwiftUI
 * Form on iOS, Material list items on Android), so each feels native.
 */
export type SettingsRow =
  | {
      kind: "choice";
      id: string;
      title: string;
      subtitle?: string;
      selected: boolean;
      onPress: () => void;
    }
  | {
      kind: "action" | "external" | "destructive";
      id: string;
      title: string;
      subtitle?: string;
      symbol?: SFSymbol;
      onPress: () => void;
    }
  | {
      kind: "toggle";
      id: string;
      title: string;
      subtitle?: string;
      value: boolean;
      disabled?: boolean;
      onChange: (value: boolean) => void;
    }
  | { kind: "info"; id: string; title: string; value: string }
  /**
   * Opens another screen: a chevron, and an optional word before it
   * ("Paused"). Without `onPress` it only shows, with no chevron.
   */
  | {
      kind: "navigate";
      id: string;
      title: string;
      subtitle?: string;
      detail?: string;
      /** The detail warns ("Failed"); default quiet. */
      detailTone?: "danger";
      onPress?: (() => void) | undefined;
    }
  /** A paragraph, such as an automation's instructions; long ones fold to a few lines. */
  | { kind: "text"; id: string; text: string; lines?: number };

export interface SettingsSection {
  id: string;
  title?: string;
  footer?: string;
  rows: SettingsRow[];
}

/** What a list with nothing in it says instead (the platform's own empty view). */
export interface SettingsEmpty {
  title: string;
  description?: string;
  symbol?: SFSymbol;
}
