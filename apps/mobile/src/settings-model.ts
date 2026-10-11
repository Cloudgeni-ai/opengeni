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
  | { kind: "info"; id: string; title: string; value: string };

export interface SettingsSection {
  id: string;
  title?: string;
  footer?: string;
  rows: SettingsRow[];
}
