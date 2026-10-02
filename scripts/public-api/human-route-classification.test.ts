import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { z } from "zod";
import snapshot from "./human-route-classification.json";
import { inventoryHumanRoutes } from "./human-route-inventory";

const Classification = z.enum([
  "csrf_only",
  "delegable_to_user",
  "organization_allowed",
  "person_present",
]);
const Route = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "ALL", "HEAD", "OPTIONS"]),
    path: z.string().startsWith("/"),
    source: z.string().startsWith("apps/api/src/"),
    gates: z.array(z.string().min(1)).min(1),
    class: Classification,
    reason: z
      .string()
      .min(15)
      .refine((value) => !value.includes("\n")),
  })
  .strict();

describe("reviewed human-route classification", () => {
  test("every gated route is classified exactly once, with its current gate functions", () => {
    const entries = z.array(Route).parse(snapshot.routes);
    const source = inventoryHumanRoutes(resolve(import.meta.dir, "../.."));
    const key = (route: { method: string; path: string }) => `${route.method} ${route.path}`;
    const keys = entries.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(source.map(key).sort());
    const byKey = new Map(entries.map((entry) => [key(entry), entry]));
    for (const route of source) {
      const entry = byKey.get(key(route))!;
      expect(entry.source).toBe(route.source);
      expect([...entry.gates].sort()).toEqual([...route.gates].sort());
    }
  });

  test("all stricter mixed-route restrictions and missing gates are explicit", () => {
    expect(snapshot.conditionalRestrictions.length).toBeGreaterThan(0);
    for (const restriction of snapshot.conditionalRestrictions) {
      expect(Classification.safeParse(restriction.class).success).toBe(true);
      expect(restriction.when.length).toBeGreaterThan(0);
      expect(restriction.reason.length).toBeGreaterThan(0);
    }
    expect(snapshot.missingGateCandidates.length).toBeGreaterThan(0);
    expect(
      snapshot.routes
        .filter((entry) => entry.path.includes("/reset-credits/"))
        .every((entry) => entry.class === "person_present"),
    ).toBe(true);
    expect(snapshot.routes.find((entry) => entry.path.endsWith("/tools/approvals"))?.class).toBe(
      "person_present",
    );
  });
});
