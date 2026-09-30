import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TimelineGroup } from "../timeline/types";

/**
 * Settlement may compact history, but cannot remove prose beneath a reader.
 * Keep only progress that was already primary on the preceding commit; loading
 * settled history never expands it. An explicit work toggle or tip return ends
 * the protection. Keeping the original sibling keys also preserves selection.
 */
export function useReadingProgress(projected: TimelineGroup[], pinned: boolean) {
  const previous = useRef<TimelineGroup[]>([]);
  const [released, setReleased] = useState<ReadonlySet<string>>(() => new Set());
  const groups = useMemo(() => {
    if (pinned) return projected;
    const key = (group: TimelineGroup) => (group.kind === "item" ? group.item.id : group.id);
    const visible = new Set(previous.current.map(key));
    const retained = new Map<string, TimelineGroup>();
    const compact = projected.map((group): TimelineGroup => {
      if (group.kind !== "activity" || !group.work?.endedAt || released.has(group.id)) {
        return group;
      }
      const progress = group.work.details.filter(
        (child) =>
          child.kind === "item" &&
          child.item.kind === "agent-message" &&
          visible.has(child.item.id),
      );
      if (!progress.length) return group;
      for (const child of progress) retained.set(key(child), child);
      return {
        ...group,
        work: {
          ...group.work,
          details: group.work.details.filter((child) => !retained.has(key(child))),
        },
      };
    });
    if (!retained.size) return compact;
    // Keep prose before the same retained sibling, including attention rows.
    // Merely hoisting it before Work would still move its DOM across those rows
    // and invalidate a browser selection despite retaining React keys.
    const current = new Set(compact.map(key));
    const before = new Map<string | null, TimelineGroup[]>();
    let next: string | null = null;
    for (let index = previous.current.length - 1; index >= 0; index--) {
      const id = key(previous.current[index]!);
      const child = retained.get(id);
      if (child) before.set(next, [child, ...(before.get(next) ?? [])]);
      else if (current.has(id)) next = id;
    }
    return [
      ...compact.flatMap((group) => [...(before.get(key(group)) ?? []), group]),
      ...(before.get(null) ?? []),
    ];
  }, [projected, pinned, released]);
  useLayoutEffect(() => {
    previous.current = groups;
    if (pinned && released.size) setReleased(new Set());
  });
  const release = useCallback(
    (id: string | null) => {
      if (
        !id ||
        !projected.some(
          (group) => group.kind === "activity" && group.id === id && group.work?.endedAt,
        )
      )
        return;
      setReleased((previous) => (previous.has(id) ? previous : new Set([...previous, id])));
    },
    [projected],
  );
  return { groups, release };
}
