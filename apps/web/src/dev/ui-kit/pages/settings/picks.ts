import type { DisclosureVariant } from "@opengeni/react/ui/disclosure";
import type { EmptyStateVariant } from "@opengeni/react/ui/empty-state";
import type { RowListVariant } from "@opengeni/react/ui/list-row";
import type { PageHeaderIconMode, PageHeaderVariant } from "@opengeni/react/ui/page-header";
import type { SectionVariant } from "@opengeni/react/ui/section";
import type { SegmentedControlVariant } from "@opengeni/react/ui/segmented-control";
import type { SelectMenuVariant } from "@opengeni/react/ui/select-menu";
import type { SettingRowVariant } from "@opengeni/react/ui/setting-row";
import type { StatusBadgeVariant } from "@opengeni/react/ui/status-badge";
import type { SwitchVariant } from "@opengeni/react/ui/switch";
import type { AccessListVariant } from "@opengeni/react/ui/access-list";

import { usePick } from "../../picks";

export type SettingsNavLayout = "column" | "rail" | "tabs";
export type DestructiveLayout = "consequences" | "type" | "undo";

export interface SettingsPicks {
  nav: SettingsNavLayout;
  headerVariant: PageHeaderVariant;
  headerIcon: PageHeaderIconMode;
  section: SectionVariant;
  settingRow: SettingRowVariant;
  switchVariant: SwitchVariant;
  switchStateText: boolean;
  segmented: SegmentedControlVariant;
  select: SelectMenuVariant;
  list: RowListVariant;
  empty: EmptyStateVariant;
  emptyTemplates: boolean;
  /** Status look in headers and sheets. */
  statusHeader: StatusBadgeVariant;
  /** Status look inside rows. */
  statusRow: StatusBadgeVariant;
  destructive: DestructiveLayout;
  access: AccessListVariant;
  disclosure: DisclosureVariant;
}

/**
 * Every component pick the settings pages follow, mapped to the real
 * primitive's variant names. The pages render with whatever Bendik picked (or
 * the decided default), so decisions are judged in context. Detail views and
 * create/edit forms are always pages (decided), so they have no pick here.
 */
export function useSettingsPicks(): SettingsPicks {
  const nav = usePick("navigation");
  const header = usePick("page-header");
  const section = usePick("section");
  const row = usePick("setting-row");
  const toggle = usePick("switch");
  const segmented = usePick("segmented-control");
  const select = usePick("select");
  const list = usePick("list-row");
  const empty = usePick("empty-state");
  const status = usePick("status-badge");
  const destructive = usePick("destructive-confirm");
  const access = usePick("access-list");
  const disclosure = usePick("disclosure");
  return {
    nav: nav === "b" ? "rail" : nav === "c" ? "tabs" : "column",
    headerVariant: header === "c" ? "large" : "default",
    headerIcon: header === "a" ? "show" : "hide",
    section: section === "b" ? "group" : section === "c" ? "tiles" : "open",
    settingRow: row === "b" ? "control-left" : row === "c" ? "stacked" : "control-right",
    switchVariant: toggle === "b" ? "neutral" : "brand",
    switchStateText: toggle === "c",
    segmented: segmented === "b" ? "outlined" : segmented === "c" ? "underline" : "filled",
    select: select === "a" ? "native" : select === "c" ? "combobox" : "menu",
    list: list === "a" ? "catalog" : list === "c" ? "table" : "resource",
    empty: empty === "b" ? "inline" : "page",
    emptyTemplates: empty === "c",
    statusHeader: status === "a" ? "dot" : status === "c" ? "tinted" : "outline",
    statusRow: status === "c" ? "tinted" : "dot",
    destructive: destructive === "b" ? "type" : destructive === "c" ? "undo" : "consequences",
    access: access === "b" ? "text" : access === "c" ? "matrix" : "inline",
    disclosure: disclosure === "b" ? "inline" : disclosure === "c" ? "sheet" : "row",
  };
}
