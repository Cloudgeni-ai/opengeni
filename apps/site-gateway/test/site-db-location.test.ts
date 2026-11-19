/**
 * Unit: which namespace Site databases live in, and how two copies are
 * compared (the workerd suite site-db-relocation.miniflare.test.ts runs the
 * whole move).
 */
import { describe, expect, test } from "bun:test";
import {
  primarySiteDbNamespace,
  SITE_DB_JURISDICTION,
  type DurableObjectNamespaceLike,
} from "../src/site-db-location";
import { compareStates, type RelocationState } from "../src/site-db-relocation";

function fakeNamespace(jurisdiction?: (name: string) => DurableObjectNamespaceLike) {
  const names: string[] = [];
  const namespace: DurableObjectNamespaceLike = {
    idFromName: (name) => {
      names.push(name);
      return name;
    },
    get: () => ({ fetch: async () => new Response("{}") }),
    ...(jurisdiction ? { jurisdiction } : {}),
  };
  return { namespace, names };
}

describe("primarySiteDbNamespace", () => {
  test("restricts the binding to the EU jurisdiction", () => {
    const eu = fakeNamespace().namespace;
    const asked: string[] = [];
    const { namespace } = fakeNamespace((name) => {
      asked.push(name);
      return eu;
    });
    expect(SITE_DB_JURISDICTION).toBe("eu");
    expect(primarySiteDbNamespace(namespace)).toBe(eu);
    expect(primarySiteDbNamespace(namespace)).toBe(eu);
    expect(asked).toEqual(["eu"]);
  });

  test("refuses a binding it cannot restrict, and any other jurisdiction failure", () => {
    expect(() => primarySiteDbNamespace(fakeNamespace().namespace)).toThrow(/jurisdiction/u);
    const failing = fakeNamespace(() => {
      throw new Error("Invalid jurisdiction");
    }).namespace;
    expect(() => primarySiteDbNamespace(failing)).toThrow("Invalid jurisdiction");
  });

  test("emulates the EU namespace by name only where workerd has no jurisdictions", () => {
    const { namespace, names } = fakeNamespace(() => {
      throw new Error("Jurisdiction restrictions are not implemented in workerd.");
    });
    const primary = primarySiteDbNamespace(namespace);
    primary.idFromName("33333333-3333-4333-8333-333333333333");
    expect(names).toEqual(["eu:33333333-3333-4333-8333-333333333333"]);
  });
});

function state(overrides: Partial<RelocationState> = {}): RelocationState {
  return {
    schema: [
      { type: "table", name: "a", tbl: "a", sql: "CREATE TABLE a (x)" },
      { type: "index", name: "a_x", tbl: "a", sql: "CREATE INDEX a_x ON a (x)" },
    ],
    tables: [{ name: "a", virtual: false, alias: "rowid", columns: ["x"], rows: 2, digest: "d1" }],
    sequences: [{ name: "a", seq: "9" }],
    migrations: [["mig:one", { checksum: "c", appliedAt: "t", position: 0 }]],
    requests: [["rq:1", 1]],
    ...overrides,
  };
}

describe("compareStates", () => {
  test("accepts an equal copy, whatever order the schema was created in and whatever request ids it has", () => {
    const source = state();
    expect(
      compareStates(source, state({ schema: [...source.schema].reverse(), requests: [] })),
    ).toBeNull();
  });

  test("names the first difference", () => {
    const source = state();
    const table = source.tables[0]!;
    expect(compareStates(source, state({ schema: source.schema.slice(0, 1) }))).toContain("schema");
    expect(compareStates(source, state({ tables: [] }))).toContain("set of tables");
    expect(compareStates(source, state({ tables: [{ ...table, rows: 1 }] }))).toContain(
      "1 rows in the copy, 2 in the source",
    );
    expect(compareStates(source, state({ tables: [{ ...table, digest: "d2" }] }))).toContain(
      "rows of table a differ",
    );
    expect(compareStates(source, state({ tables: [{ ...table, alias: null }] }))).toContain(
      "different columns",
    );
    expect(compareStates(source, state({ sequences: [] }))).toContain("AUTOINCREMENT");
    expect(compareStates(source, state({ migrations: [] }))).toContain("migration records");
  });
});
