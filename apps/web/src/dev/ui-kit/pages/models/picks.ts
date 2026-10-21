import type { ChoiceCardsVariant } from "@opengeni/react/ui/choice-cards";
import type { DestructiveConfirmVariant } from "@opengeni/react/app/components/ui/destructive-confirm";
import type { DisclosureVariant } from "@opengeni/react/ui/disclosure";
import type { LineTabsVariant } from "@opengeni/react/ui/line-tabs";
import type { RowListVariant } from "@opengeni/react/ui/list-row";
import type { MetaChipVariant } from "@opengeni/react/ui/meta-chip";
import type { PageHeaderIconMode, PageHeaderVariant } from "@opengeni/react/ui/page-header";
import type { SectionVariant } from "@opengeni/react/ui/section";
import type { SegmentedControlVariant } from "@opengeni/react/ui/segmented-control";
import type { SelectMenuVariant } from "@opengeni/react/ui/select-menu";
import type { SettingRowVariant } from "@opengeni/react/ui/setting-row";
import type { StatusBadgeVariant } from "@opengeni/react/ui/status-badge";
import type { SwitchVariant } from "@opengeni/react/ui/switch";
import type { UsageMeterVariant } from "@opengeni/react/ui/usage-meter";

import { usePick } from "../../picks";

/* ----------------------------------------------------------------------------
   Every component pick the Models page follows, translated into the variant
   names the real primitives take. The page renders with Bendik's picks (or the
   recommended default), so a pick anywhere in the kit changes this page too.
   Detail and forms are decided: every account and every create or edit form
   is its own page, so they are not picks here.
   -------------------------------------------------------------------------- */

export type NavLayout = "column" | "rail" | "tabs";

export interface ModelsPicks {
  nav: NavLayout;
  headerVariant: PageHeaderVariant;
  /** Settings sub-pages drop the icon unless "Icon everywhere" is picked. */
  headerIcon: PageHeaderIconMode;
  tabs: LineTabsVariant;
  section: SectionVariant;
  list: RowListVariant;
  settingRow: SettingRowVariant;
  switchVariant: SwitchVariant;
  switchStateText: boolean;
  segmented: SegmentedControlVariant;
  choice: ChoiceCardsVariant;
  select: SelectMenuVariant;
  disclosure: DisclosureVariant;
  statusHeader: StatusBadgeVariant;
  statusRow: StatusBadgeVariant;
  /** The look of "Primary" and "Organization" chips next to a row title. */
  chip: MetaChipVariant;
  meter: UsageMeterVariant;
  destructive: DestructiveConfirmVariant;
  /** "Undo instead" was picked. Disconnect can't be undone, so it keeps the list. */
  destructiveUndo: boolean;
}

export function useModelsPicks(): ModelsPicks {
  const nav = usePick("navigation");
  const header = usePick("page-header");
  const tabs = usePick("tabs-toolbar");
  const section = usePick("section");
  const list = usePick("list-row");
  const row = usePick("setting-row");
  const toggle = usePick("switch");
  const segmented = usePick("segmented-control");
  const choice = usePick("choice-cards");
  const select = usePick("select");
  const disclosure = usePick("disclosure");
  const status = usePick("status-badge");
  const meter = usePick("usage-meter");
  const destructive = usePick("destructive-confirm");
  return {
    nav: nav === "b" ? "rail" : nav === "c" ? "tabs" : "column",
    headerVariant: header === "c" ? "large" : "default",
    headerIcon: header === "a" ? "show" : "hide",
    tabs: tabs === "b" ? "pill" : "underline",
    section: section === "b" ? "group" : section === "c" ? "tiles" : "open",
    list: list === "a" ? "catalog" : list === "c" ? "table" : "resource",
    settingRow: row === "b" ? "control-left" : row === "c" ? "stacked" : "control-right",
    switchVariant: toggle === "b" ? "neutral" : "brand",
    switchStateText: toggle === "c",
    segmented: segmented === "b" ? "outlined" : segmented === "c" ? "underline" : "filled",
    choice: choice === "b" ? "radio" : choice === "c" ? "list" : "ring",
    // Four models is a short list: the combobox pick keeps the menu here.
    select: select === "a" ? "native" : "menu",
    disclosure: disclosure === "b" ? "inline" : disclosure === "c" ? "sheet" : "row",
    statusHeader: status === "a" ? "dot" : status === "c" ? "tinted" : "outline",
    statusRow: status === "c" ? "tinted" : "dot",
    chip: status === "a" ? "text" : status === "c" ? "soft" : "outline",
    meter: meter === "b" ? "text" : meter === "c" ? "ring" : "bar",
    destructive: destructive === "b" ? "type-to-confirm" : "consequences",
    destructiveUndo: destructive === "c",
  };
}
