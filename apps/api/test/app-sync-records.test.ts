import { expect, test } from "bun:test";
import { APP_SYNC_MAX_RECORDS } from "@opengeni/contracts";
import { appSyncRecords, readPath, toolResultValue } from "../src/app-sync/service";

const settings = { recordsPath: null, key: "id", fields: null } as const;

test("readPath follows objects and list indexes and ignores prototype keys", () => {
  const value = { a: { b: [{ c: 1 }, { c: 2 }] } };
  expect(readPath(value, "a.b.1.c")).toBe(2);
  expect(readPath(value, "a.missing.c")).toBeUndefined();
  expect(readPath(value, "__proto__")).toBeUndefined();
  expect(readPath({ constructor: 1 }, "constructor")).toBeUndefined();
});

test("records come from a path, a bare list, or the result's only list", () => {
  const items = [{ id: "a" }, { id: "b" }];
  expect(
    appSyncRecords({ data: { items } }, { ...settings, recordsPath: "data.items" }).records,
  ).toHaveLength(2);
  expect(appSyncRecords(items, settings).records).toHaveLength(2);
  expect(appSyncRecords({ results: items, total: 2 }, settings).records).toHaveLength(2);
  expect(appSyncRecords({ page: 1, orders: items }, settings).records).toHaveLength(2);
  expect(() => appSyncRecords({}, { ...settings, recordsPath: "data.items" })).toThrow(
    'nothing at "data.items"',
  );
});

test("kept fields, numeric keys, skipped records and duplicates", () => {
  const result = appSyncRecords(
    [
      { id: 7, name: "first", nested: { a: 1, b: 2 }, extra: true },
      { id: 7, name: "second", nested: { a: 3 } },
      { name: "no key" },
      "not an object",
      { id: "x", nested: null },
    ],
    { ...settings, fields: ["name", "nested.a"] },
  );
  expect(result).toEqual({
    records: [
      { key: "7", data: { name: "second", nested: { a: 3 } } },
      { key: "x", data: {} },
    ],
    received: 5,
    skipped: 2,
    truncated: false,
  });
});

test("a run keeps at most the record limit", () => {
  const many = Array.from({ length: APP_SYNC_MAX_RECORDS + 5 }, (_, index) => ({ id: index }));
  const result = appSyncRecords(many, settings);
  expect(result.truncated).toBe(true);
  expect(result.records).toHaveLength(APP_SYNC_MAX_RECORDS);
});

test("tool results are read from structured content or JSON text", () => {
  expect(toolResultValue({ structuredContent: { a: 1 }, content: [] } as never)).toEqual({ a: 1 });
  expect(
    toolResultValue({
      content: [
        { type: "text", text: "Here you go" },
        { type: "text", text: '[{"id":1}]' },
      ],
    } as never),
  ).toEqual([{ id: 1 }]);
  expect(() => toolResultValue({ content: [{ type: "text", text: "plain" }] } as never)).toThrow(
    "didn't return JSON",
  );
});
