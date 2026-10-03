import type { ChoiceCardsVariant } from "@/components/ui/choice-cards";
import type { DestructiveConfirmVariant } from "@/components/ui/destructive-confirm";
import type { AccessListVariant } from "@/components/ui/access-list";
import type { LineTabsVariant } from "@/components/ui/line-tabs";
import type { RowListVariant } from "@/components/ui/list-row";
import type { PageHeaderVariant } from "@/components/ui/page-header";
import type { SectionVariant } from "@/components/ui/section";
import type { SegmentedControlVariant } from "@/components/ui/segmented-control";
import type { SelectMenuVariant } from "@/components/ui/select-menu";
import type { SettingRowVariant } from "@/components/ui/setting-row";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";
import type { SwitchVariant } from "@/components/ui/switch";
import type { EmptyStateVariant } from "@/components/ui/empty-state";

import { storedPick, usePickState, type PickState } from "../../picks";
import { getSection, type AlternativeId, type SectionKey } from "../../sections/registry";

/* ----------------------------------------------------------------------------
   Bendik's picks, translated into the variants the primitives take. The page
   previews read everything through here, so one pick changes every place the
   component shows up on the page. Detail and form presentation are decided
   (pages, never side sheets), so they are not picks here any more.
   -------------------------------------------------------------------------- */

export type NavigationPick = "column" | "rail" | "tabs";
export type TabsPick = "underline" | "pill" | "filter-menu";

export interface PagePicks {
  letters: Record<PickedKey, AlternativeId>;
  header: { variant: PageHeaderVariant; railPageIcon: boolean; settingsIcon: boolean };
  navigation: NavigationPick;
  section: SectionVariant;
  tabs: TabsPick;
  /** Line tabs look for places on a page (the filter-menu pick keeps underline tabs). */
  tabVariant: LineTabsVariant;
  list: RowListVariant;
  empty: { variant: EmptyStateVariant; templates: boolean };
  settingRow: SettingRowVariant;
  switch: { variant: SwitchVariant; showStateText: boolean };
  segmented: SegmentedControlVariant;
  choice: ChoiceCardsVariant;
  select: SelectMenuVariant;
  status: { header: StatusBadgeVariant; row: StatusBadgeVariant };
  destructive: DestructiveConfirmVariant | "undo";
  access: AccessListVariant;
}

export const PICKED_KEYS = [
  "page-header",
  "navigation",
  "section",
  "tabs-toolbar",
  "list-row",
  "detail-sheet",
  "empty-state",
  "setting-row",
  "switch",
  "segmented-control",
  "choice-cards",
  "select",
  "status-badge",
  "form-dialog",
  "destructive-confirm",
  "access-list",
] as const satisfies readonly SectionKey[];

export type PickedKey = (typeof PICKED_KEYS)[number];

function pickOf(state: PickState, key: PickedKey): AlternativeId {
  return storedPick(state, key) ?? getSection(key).recommended ?? "a";
}

/** Every pick the two page previews use, as primitive variants. */
export function usePagePicks(): PagePicks {
  const state = usePickState();
  const letters = Object.fromEntries(PICKED_KEYS.map((key) => [key, pickOf(state, key)])) as Record<
    PickedKey,
    AlternativeId
  >;
  const by = <T>(key: PickedKey, map: Record<AlternativeId, T>): T => map[letters[key]];

  return {
    letters,
    header: by("page-header", {
      a: { variant: "default", railPageIcon: true, settingsIcon: true },
      b: { variant: "default", railPageIcon: true, settingsIcon: false },
      c: { variant: "large", railPageIcon: false, settingsIcon: false },
    }),
    navigation: by<NavigationPick>("navigation", { a: "column", b: "rail", c: "tabs" }),
    section: by<SectionVariant>("section", { a: "open", b: "group", c: "tiles" }),
    tabs: by<TabsPick>("tabs-toolbar", { a: "underline", b: "pill", c: "filter-menu" }),
    tabVariant: by<LineTabsVariant>("tabs-toolbar", { a: "underline", b: "pill", c: "underline" }),
    list: by<RowListVariant>("list-row", { a: "catalog", b: "resource", c: "table" }),
    empty: by("empty-state", {
      a: { variant: "page" as EmptyStateVariant, templates: false },
      b: { variant: "inline" as EmptyStateVariant, templates: false },
      c: { variant: "page" as EmptyStateVariant, templates: true },
    }),
    settingRow: by<SettingRowVariant>("setting-row", {
      a: "control-right",
      b: "control-left",
      c: "stacked",
    }),
    switch: by("switch", {
      a: { variant: "brand" as SwitchVariant, showStateText: false },
      b: { variant: "neutral" as SwitchVariant, showStateText: false },
      c: { variant: "brand" as SwitchVariant, showStateText: true },
    }),
    segmented: by<SegmentedControlVariant>("segmented-control", {
      a: "filled",
      b: "outlined",
      c: "underline",
    }),
    choice: by<ChoiceCardsVariant>("choice-cards", { a: "ring", b: "radio", c: "list" }),
    select: by<SelectMenuVariant>("select", { a: "native", b: "menu", c: "combobox" }),
    status: by("status-badge", {
      a: { header: "dot" as StatusBadgeVariant, row: "dot" as StatusBadgeVariant },
      b: { header: "outline" as StatusBadgeVariant, row: "dot" as StatusBadgeVariant },
      c: { header: "tinted" as StatusBadgeVariant, row: "tinted" as StatusBadgeVariant },
    }),
    destructive: by<DestructiveConfirmVariant | "undo">("destructive-confirm", {
      a: "consequences",
      b: "type-to-confirm",
      c: "undo",
    }),
    access: by<AccessListVariant>("access-list", { a: "inline", b: "text", c: "matrix" }),
  };
}

/** A promise that settles after `ms`, to make saves feel like saves. */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
