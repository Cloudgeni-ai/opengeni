import type { CadencePickerVariant } from "@/components/ui/cadence-picker";
import type { DestructiveConfirmVariant } from "@/components/ui/destructive-confirm";
import type { DisclosureVariant } from "@/components/ui/disclosure";
import type { EmptyStateVariant } from "@/components/ui/empty-state";
import type { RowListVariant } from "@/components/ui/list-row";
import type { PageHeaderIconMode, PageHeaderVariant } from "@/components/ui/page-header";
import type { SegmentedControlVariant } from "@/components/ui/segmented-control";
import type { SelectMenuVariant } from "@/components/ui/select-menu";
import type { SettingRowVariant } from "@/components/ui/setting-row";
import type { NavItemSize } from "@/components/ui/settings-nav";
import type { SwitchVariant } from "@/components/ui/switch";

import { usePick } from "../../picks";

export type DetailPresentationPick = "sheet" | "page" | "inline";
export type FormPresentationPick = "sheet" | "page" | "inline";

export interface SchedulePicks {
  headerVariant: PageHeaderVariant;
  headerIcon: PageHeaderIconMode;
  navItemSize: NavItemSize;
  rowList: RowListVariant;
  detail: DetailPresentationPick;
  /** Page (A, C) shows the templates on Schedules; inline (B) is one line. */
  emptyState: EmptyStateVariant;
  switchVariant: SwitchVariant;
  switchStateText: boolean;
  segmented: SegmentedControlVariant;
  /** Value pickers in forms. */
  select: SelectMenuVariant;
  /** Chips in the composer row can't be native selects, so A falls back to the menu. */
  chipSelect: Exclude<SelectMenuVariant, "native">;
  disclosure: DisclosureVariant;
  form: FormPresentationPick;
  confirm: DestructiveConfirmVariant | "undo";
  cadence: CadencePickerVariant;
  settingRow: SettingRowVariant;
}

/** Bendik's picks (or the recommended defaults), as the props each primitive takes. */
export function useSchedulePicks(): SchedulePicks {
  const header = usePick("page-header");
  const navigation = usePick("navigation");
  const listRow = usePick("list-row");
  const detail = usePick("detail-sheet");
  const empty = usePick("empty-state");
  const switchPick = usePick("switch");
  const segmented = usePick("segmented-control");
  const select = usePick("select");
  const disclosure = usePick("disclosure");
  const form = usePick("form-dialog");
  const confirm = usePick("destructive-confirm");
  const cadence = usePick("cadence-picker");
  const settingRow = usePick("setting-row");

  const selectVariant: SelectMenuVariant =
    select === "a" ? "native" : select === "c" ? "combobox" : "menu";

  const rowList: RowListVariant =
    listRow === "a" ? "catalog" : listRow === "c" ? "table" : "resource";
  const detailPick: DetailPresentationPick =
    detail === "b" ? "page" : detail === "c" ? "inline" : "sheet";

  return {
    headerVariant: header === "c" ? "large" : "default",
    // Schedules is a main-rail page, so it keeps its icon in A and B.
    headerIcon: header === "c" ? "hide" : "show",
    navItemSize: navigation === "b" ? "comfortable" : "default",
    rowList,
    // Table rows can't expand in place (ListRow limitation), so C falls back to the sheet there.
    detail: detailPick === "inline" && rowList === "table" ? "sheet" : detailPick,
    emptyState: empty === "b" ? "inline" : "page",
    switchVariant: switchPick === "b" ? "neutral" : "brand",
    switchStateText: switchPick === "c",
    segmented: segmented === "b" ? "outlined" : segmented === "c" ? "underline" : "filled",
    select: selectVariant,
    chipSelect: selectVariant === "combobox" ? "combobox" : "menu",
    disclosure: disclosure === "b" ? "inline" : disclosure === "c" ? "sheet" : "row",
    form: form === "b" ? "page" : form === "c" ? "inline" : "sheet",
    confirm: confirm === "b" ? "type-to-confirm" : confirm === "c" ? "undo" : "consequences",
    cadence: cadence === "b" ? "presets" : cadence === "c" ? "text" : "sentence",
    settingRow:
      settingRow === "b" ? "control-left" : settingRow === "c" ? "stacked" : "control-right",
  };
}
