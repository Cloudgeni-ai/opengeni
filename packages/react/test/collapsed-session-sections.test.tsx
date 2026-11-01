import { describe, expect, test } from "bun:test";
import {
  readCollapsedSessionSections,
  sessionBrowsePreferenceStorageId,
  useCollapsedSessionSections,
  writeCollapsedSessionSections,
} from "../src/app/lib/session-browse-preferences";
import { actRun, registerDom, renderHook } from "./render-hook";

registerDom();

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const toggle = (key: string) => (current: ReadonlySet<string>) => {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

describe("collapsed chat list sections", () => {
  const first = sessionBrowsePreferenceStorageId("user:one", "workspace:one");
  const second = sessionBrowsePreferenceStorageId("user:one", "workspace:two");

  test("a collapsed project stays collapsed after the list mounts again", async () => {
    const storage = memoryStorage();
    const before = await renderHook(
      (id: string) => useCollapsedSessionSections(id, storage),
      first,
    );
    expect([...before.result.current[0]]).toEqual([]);
    await actRun(() => before.result.current[1](toggle("project-a")));
    await actRun(() => before.result.current[1](toggle("default")));
    expect([...before.result.current[0]]).toEqual(["project-a", "default"]);
    await before.unmount();

    // A reload: a fresh list reads what the person collapsed.
    const after = await renderHook((id: string) => useCollapsedSessionSections(id, storage), first);
    expect([...after.result.current[0]]).toEqual(["project-a", "default"]);
    // Opening a project again is remembered too.
    await actRun(() => after.result.current[1](toggle("project-a")));
    await after.unmount();
    expect([...readCollapsedSessionSections(first, storage)]).toEqual(["default"]);
  });

  test("each workspace keeps its own collapsed projects", async () => {
    const storage = memoryStorage();
    writeCollapsedSessionSections(second, new Set(["project-b"]), storage);
    const list = await renderHook((id: string) => useCollapsedSessionSections(id, storage), first);
    await actRun(() => list.result.current[1](toggle("project-a")));
    await list.rerender(second);
    expect([...list.result.current[0]]).toEqual(["project-b"]);
    await actRun(() => list.result.current[1](toggle("project-c")));
    await list.unmount();
    expect([...readCollapsedSessionSections(first, storage)]).toEqual(["project-a"]);
    expect([...readCollapsedSessionSections(second, storage)]).toEqual(["project-b", "project-c"]);
  });

  test("unreadable or blocked storage falls back to everything open", () => {
    const storage = memoryStorage();
    storage.values.set(`${first}:collapsed-sections`, "{not json");
    expect([...readCollapsedSessionSections(first, storage)]).toEqual([]);
    storage.values.set(`${first}:collapsed-sections`, JSON.stringify({ a: 1 }));
    expect([...readCollapsedSessionSections(first, storage)]).toEqual([]);
    storage.values.set(`${first}:collapsed-sections`, JSON.stringify(["ok", 7, "", null]));
    expect([...readCollapsedSessionSections(first, storage)]).toEqual(["ok"]);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect([...readCollapsedSessionSections(first, blocked)]).toEqual([]);
    expect(() => writeCollapsedSessionSections(first, new Set(["a"]), blocked)).not.toThrow();
  });
});
