// The order of the rail's built-in entries (docs/sidebar-layout.md,
// `navOrder` and `navSetup`): a person drags them, or moves them with
// Alt+Arrow, and their own order is kept in their personal layout.

/** The folded group ("Setup", or "Advanced" in the simplified interface) as an entry of the top. */
export const NAV_GROUP_KEY = "setup";

/** The entries at the top, in order (the group among them), and the entries inside the group. */
export type NavArrangement = { top: string[]; group: string[] };

/**
 * The rail's entries in a person's order. Entries their order doesn't name
 * (one the rail added later, or one it doesn't show) keep their own place,
 * just after the entry before them in the rail's own order; names the rail
 * doesn't have are skipped.
 */
export function arrangeNav(
  defaults: NavArrangement,
  order: readonly string[] | null | undefined,
  group: readonly string[] | null | undefined,
): NavArrangement {
  if (!order && !group) return { top: [...defaults.top], group: [...defaults.group] };
  const known = new Set([...defaults.top, ...defaults.group]);
  const placed = new Set<string>();
  const top: string[] = [];
  const inside: string[] = [];
  for (const key of order ?? [])
    if (known.has(key) && !placed.has(key)) {
      top.push(key);
      placed.add(key);
    }
  for (const key of group ?? [])
    if (known.has(key) && !placed.has(key) && key !== NAV_GROUP_KEY) {
      inside.push(key);
      placed.add(key);
    }
  const fill = (list: string[], own: readonly string[]) =>
    own.forEach((key, index) => {
      if (placed.has(key)) return;
      let at = 0;
      for (let before = index - 1; before >= 0; before--) {
        const found = list.indexOf(own[before]!);
        if (found >= 0) {
          at = found + 1;
          break;
        }
      }
      list.splice(at, 0, key);
      placed.add(key);
    });
  fill(top, defaults.top);
  fill(inside, defaults.group);
  return { top, group: inside };
}

/**
 * The arrangement after `key` is dropped before or after `target`, or into
 * the group (`target` the group, `at` "into"). Null when nothing changes.
 * The group itself stays at the top.
 */
export function moveNavEntry(
  arrangement: NavArrangement,
  key: string,
  target: string,
  at: "before" | "after" | "into",
): NavArrangement | null {
  if (key === target) return null;
  const top = arrangement.top.filter((entry) => entry !== key);
  const group = arrangement.group.filter((entry) => entry !== key);
  if (top.length + group.length === arrangement.top.length + arrangement.group.length) return null;
  if (at === "into") {
    if (target !== NAV_GROUP_KEY || key === NAV_GROUP_KEY) return null;
    group.push(key);
  } else {
    // The group can't go inside itself: next to one of its entries is next to it.
    const inGroup = group.includes(target) && key !== NAV_GROUP_KEY;
    const list = inGroup ? group : top;
    const anchor = list.indexOf(inGroup || top.includes(target) ? target : NAV_GROUP_KEY);
    if (anchor < 0) return null;
    list.splice(at === "before" ? anchor : anchor + 1, 0, key);
  }
  const next = { top, group };
  return sameArrangement(next, arrangement) ? null : next;
}

/**
 * The arrangement after `key` moves one place up (-1) or down (1) in the rail
 * as shown: past the group's name it goes into the group while it's open, and
 * out of it from its first or last entry. Null at the ends.
 */
export function stepNavEntry(
  arrangement: NavArrangement,
  key: string,
  direction: -1 | 1,
  groupOpen: boolean,
): NavArrangement | null {
  const top = [...arrangement.top];
  const group = [...arrangement.group];
  const inGroup = group.indexOf(key);
  if (inGroup >= 0) {
    const next = inGroup + direction;
    if (next >= 0 && next < group.length) {
      [group[inGroup], group[next]] = [group[next]!, group[inGroup]!];
    } else {
      group.splice(inGroup, 1);
      const at = top.indexOf(NAV_GROUP_KEY);
      top.splice(direction < 0 ? at : at + 1, 0, key);
    }
    return { top, group };
  }
  const index = top.indexOf(key);
  if (index < 0) return null;
  const neighbour = top[index + direction];
  if (neighbour === undefined) return null;
  if (neighbour === NAV_GROUP_KEY && key !== NAV_GROUP_KEY && groupOpen) {
    top.splice(index, 1);
    if (direction < 0) group.push(key);
    else group.unshift(key);
    return { top, group };
  }
  [top[index], top[index + direction]] = [neighbour, key];
  return { top, group };
}

function sameArrangement(a: NavArrangement, b: NavArrangement): boolean {
  return (
    a.top.length === b.top.length &&
    a.group.length === b.group.length &&
    a.top.every((entry, index) => entry === b.top[index]) &&
    a.group.every((entry, index) => entry === b.group[index])
  );
}
