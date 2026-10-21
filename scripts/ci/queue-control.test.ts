import { test, expect } from "bun:test";
import { disableQueue } from "./queue-control";
test("one-command rollback disables only the named main queue and verifies it", () => {
  const rule = {
    id: 42,
    name: "Main merge queue",
    target: "branch",
    conditions: { ref_name: { exclude: [], include: ["refs/heads/main"] } },
    rules: [{ type: "merge_queue" }],
    bypass_actors: [],
    enforcement: "active",
  };
  const writes: any[] = [];
  const result = disableQueue((path, method, body: any) => {
    if (path.includes("?")) return [rule];
    if (method) {
      writes.push({ path, body });
      rule.enforcement = body.enforcement;
    }
    return rule;
  });
  expect(result.enforcement).toBe("disabled");
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toEndWith("/rulesets/42");
  expect(writes[0].body.rules).toEqual(rule.rules);
});
test("dry run never writes and ambiguous targets do not mutate", () => {
  expect(() => disableQueue(() => [])).toThrow("found 0");
  expect(() =>
    disableQueue(() => [{ name: "Main merge queue" }, { name: "Main merge queue" }]),
  ).toThrow("found 2");
});
