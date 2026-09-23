import { describe, expect, test } from "bun:test";
import {
  readVariableSetShortlist,
  reconcileVariableSetShortlist,
  variableSetRuntimeIds,
  variableSetShortlistKey,
  writeVariableSetShortlist,
} from "./variable-set-shortlist";

describe("variable set shortlist preferences", () => {
  test("top-first roundtrip preserves collision precedence including newly enabled sets", () => {
    const runtime = ["low", "middle", "high"];
    const rows = reconcileVariableSetShortlist(runtime, [
      { id: "off", enabled: false },
      { id: "middle", enabled: true },
      { id: "low", enabled: true },
    ]);
    expect(rows.filter((row) => row.enabled).map((row) => row.id)).toEqual([
      "high",
      "middle",
      "low",
    ]);
    expect(variableSetRuntimeIds(rows)).toEqual(runtime);
    const values: Record<string, string> = {
      low: "low value",
      middle: "middle value",
      high: "winning value",
    };
    expect(variableSetRuntimeIds(rows).reduce((_, id) => values[id]!, "")).toBe("winning value");
  });

  test("off/save/reopen retains stable rows without restoring runtime authority", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    const rows = [
      { id: "high", enabled: false },
      { id: "low", enabled: true },
    ];
    const key = variableSetShortlistKey("user", "workspace", "chat");
    writeVariableSetShortlist(key, rows, storage);
    const reopened = reconcileVariableSetShortlist(
      variableSetRuntimeIds(rows),
      readVariableSetShortlist(key, storage),
    );
    expect(reopened).toEqual(rows);
    expect(variableSetRuntimeIds(reopened)).toEqual(["low"]);
    // A stale browser "on" flag cannot grant runtime membership.
    expect(
      variableSetRuntimeIds(
        reconcileVariableSetShortlist([], [{ id: "secret-set", enabled: true }]),
      ),
    ).toEqual([]);
    expect(data.get(key)).toBe(JSON.stringify(rows));
  });

  test("scopes and escapes subject, workspace and chat separately", () => {
    const keys = [
      variableSetShortlistKey("u", "w", "c"),
      variableSetShortlistKey("other", "w", "c"),
      variableSetShortlistKey("u", "other", "c"),
      variableSetShortlistKey("u", "w", "other"),
      variableSetShortlistKey("u:w", "x", "c"),
      variableSetShortlistKey("u", "w:x", "c"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("malformed, duplicate and blocked storage stay harmless", () => {
    const storage = {
      getItem: () =>
        JSON.stringify([
          { id: "a", enabled: false },
          { id: "a", enabled: true },
          { id: "b", enabled: "true" },
          null,
        ]),
      setItem: () => {
        throw Error("blocked");
      },
    };
    expect(readVariableSetShortlist("key", storage)).toEqual([{ id: "a", enabled: false }]);
    expect(() => writeVariableSetShortlist("blocked-key", [], storage)).not.toThrow();
    expect(readVariableSetShortlist("key", { ...storage, getItem: () => "{" })).toEqual([]);
  });

  test("blocked storage preserves off rows in this tab after save", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw Error("quota");
      },
    };
    const rows = [
      { id: "off", enabled: false },
      { id: "on", enabled: true },
    ];
    writeVariableSetShortlist("quota-key", rows, storage);
    expect(
      reconcileVariableSetShortlist(["on"], readVariableSetShortlist("quota-key", storage)),
    ).toEqual(rows);
  });
});
