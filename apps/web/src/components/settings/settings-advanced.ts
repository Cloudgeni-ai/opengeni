// The settings rail's Advanced: a fixed, collapsed section at the end with the
// pages few people open (by production page views), the same for everyone.
// It opens while it holds the current page, and settings search still finds
// every entry. A layout's saved `settingsMore` (the earlier per-person More)
// is ignored.
import type { SettingsRailItem, SettingsRailSection } from "./settings-sidebar";

export const SETTINGS_ADVANCED_SECTION_ID = "advanced";

/** Rail entry ids under Advanced, in the order they show there. */
export const SETTINGS_ADVANCED_ENTRIES: readonly string[] = [
  "workspace:learning",
  "workspace:api-keys",
  "workspace:developer",
  "organization:shared",
  "organization:identity",
  "organization:security",
  "organization:developer",
];

const ADVANCED = new Set(SETTINGS_ADVANCED_ENTRIES);

/** Whether a rail entry id lives under Advanced. */
export function isAdvancedSettingsEntry(id: string): boolean {
  return ADVANCED.has(id);
}

/**
 * The rail with the Advanced entries moved into one collapsed section at the
 * end, in groups labeled with the scope they came from (both scopes have a
 * Developer); settings search names that scope as their place.
 */
export function foldAdvancedSettings(
  sections: readonly SettingsRailSection[],
): SettingsRailSection[] {
  const moved: { label: string; items: SettingsRailItem[] }[] = [];
  const folded = sections.flatMap((section): SettingsRailSection[] => {
    const taken: SettingsRailItem[] = [];
    const groups = section.groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          if (!ADVANCED.has(item.id)) return true;
          taken.push(item);
          return false;
        }),
      }))
      .filter((group) => group.items.length > 0);
    if (taken.length > 0) {
      const order = (item: SettingsRailItem) => SETTINGS_ADVANCED_ENTRIES.indexOf(item.id);
      moved.push({ label: section.label, items: taken.sort((a, b) => order(a) - order(b)) });
    }
    if (taken.length === 0 || groups.length > 0) return [{ ...section, groups }];
    // A section left empty keeps its search-only pages, without a heading.
    if (!section.searchOnly?.length) return [];
    return [{ ...section, groups, searchOnlySection: true }];
  });
  if (moved.length === 0) return folded;
  return [
    ...folded,
    {
      id: SETTINGS_ADVANCED_SECTION_ID,
      label: "Advanced",
      collapsible: true,
      groups: moved,
    },
  ];
}
