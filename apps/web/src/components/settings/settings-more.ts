// The settings rail's More (docs/sidebar-layout.md, `settingsShown`): a
// person keeps the settings they use at the top, and the rest fold under one
// More at the end. Unset (the default) keeps every entry at the top. Search
// still finds everything.
import type { SettingsRailItem, SettingsRailSection } from "./settings-sidebar";

export const SETTINGS_MORE_SECTION_ID = "more";

/**
 * The rail with the entries outside `shown` moved under More, each with a
 * menu that moves it (Move to More, Show at top). `save` stores the new list.
 */
export function foldSettingsRail(
  sections: readonly SettingsRailSection[],
  shown: readonly string[] | null,
  save: (shown: string[]) => void,
): SettingsRailSection[] {
  const all = sections.flatMap((section) =>
    section.groups.flatMap((group) => group.items.map((item) => item.id)),
  );
  const top = new Set(shown ?? all);
  const toMore = (id: string) => save(all.filter((each) => top.has(each) && each !== id));
  const toTop = (id: string) => save(all.filter((each) => top.has(each) || each === id));
  const more: SettingsRailItem[] = [];
  const folded = sections.flatMap((section): SettingsRailSection[] => {
    const groups = section.groups
      .map((group) => ({
        ...group,
        items: group.items.flatMap((item) => {
          if (top.has(item.id))
            return [{ ...item, place: { label: "Move to More", run: () => toMore(item.id) } }];
          more.push({ ...item, place: { label: "Show at top", run: () => toTop(item.id) } });
          return [];
        }),
      }))
      .filter((group) => group.items.length > 0);
    // A section left empty keeps its search-only pages, without a heading.
    if (groups.length > 0 || section.groups.length === 0) return [{ ...section, groups }];
    if (!section.searchOnly?.length) return [];
    return [{ ...section, groups, searchOnlySection: true }];
  });
  if (more.length === 0) return folded;
  return [
    ...folded,
    {
      id: SETTINGS_MORE_SECTION_ID,
      label: "More",
      collapsible: true,
      groups: [{ items: more }],
    },
  ];
}
