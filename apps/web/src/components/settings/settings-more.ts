// The settings rail's More (docs/sidebar-layout.md, `settingsMore`): a
// person moves the settings they rarely use under one More at the end; every
// other entry, including ones a later release adds, stays at the top. Unset
// (the default) keeps every entry at the top. Search still finds everything.
import type { SettingsRailItem, SettingsRailSection } from "./settings-sidebar";

export const SETTINGS_MORE_SECTION_ID = "more";

/**
 * The rail with the entries in `moved` under More, each with one button that
 * moves it (Move to More, Show at top). `save` stores the new list.
 */
export function foldSettingsRail(
  sections: readonly SettingsRailSection[],
  moved: readonly string[] | null,
  save: (moved: string[]) => void,
): SettingsRailSection[] {
  const under = new Set(moved ?? []);
  // Saved entries this rail doesn't list right now (another role, flag or
  // release) keep their place.
  const toMore = (id: string) => save([...under, id]);
  const toTop = (id: string) => save([...under].filter((each) => each !== id));
  const more: SettingsRailItem[] = [];
  const folded = sections.flatMap((section): SettingsRailSection[] => {
    const groups = section.groups
      .map((group) => ({
        ...group,
        items: group.items.flatMap((item) => {
          if (!under.has(item.id))
            return [
              {
                ...item,
                place: { label: "Move to More", toMore: true, run: () => toMore(item.id) },
              },
            ];
          more.push({
            ...item,
            place: { label: "Show at top", toMore: false, run: () => toTop(item.id) },
          });
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
