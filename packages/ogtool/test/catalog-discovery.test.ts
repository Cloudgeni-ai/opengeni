import { describe, expect, test } from "bun:test";
import {
  createAttemptToolEnvironment,
  digestAttemptToolCatalog,
  parseVerifiedAttemptToolCatalog,
} from "@opengeni/codemode";
import { compactOutput, parseListOptions, shortDescription } from "../src/catalog-discovery";

function catalog(count: number, extreme = false) {
  const base = createAttemptToolEnvironment({
    scope: {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      executionGeneration: 1,
    },
    generation: 1,
    definitions: [],
  }).catalog;
  base.entries = Array.from({ length: count }, (_, index) => ({
    identity: { serverId: "docs", toolName: `tool${index}` },
    modelName: `tool${index}`,
    codemodePath: extreme
      ? [...Array<string>(7).fill("x".repeat(128)), `t${index}`.padEnd(128, "x")]
      : ["docs", `tool${index}`],
    description: extreme ? (index % 2 ? "😀" : "\u0000").repeat(160) : `Search docs ${index}`,
    inputSchema: { type: "object" },
    source: "docs",
    approval: "none",
  }));
  const { digest: _digest, ...unsigned } = base;
  base.digest = digestAttemptToolCatalog(unsigned);
  return parseVerifiedAttemptToolCatalog(base);
}

describe("compact catalogs", () => {
  test("default output preserves all 4096 complete paths without a byte cap", () => {
    expect(parseListOptions([]).limit).toBeUndefined();
    for (const extreme of [false, true]) {
      const frozen = catalog(4096, extreme);
      for (const json of [false, true]) {
        const seen: string[] = [];
        let offset = 0;
        for (;;) {
          const options = { ...parseListOptions([]), json, offset };
          const output = compactOutput(frozen, options);
          expect(Buffer.byteLength(output, "utf8")).toBeGreaterThan(16_384);
          let paths: string[];
          let nextOffset: number | null;
          if (json) {
            const page = JSON.parse(output);
            expect(Object.keys(page).sort()).toEqual([
              "catalogDigest",
              "nextOffset",
              "offset",
              "tools",
              "total",
            ]);
            expect(page.catalogDigest).toBe(frozen.digest);
            expect(page.total).toBe(4096);
            expect(page.offset).toBe(offset);
            paths = page.tools.map((tool: { path: string }) => tool.path);
            nextOffset = page.nextOffset;
          } else {
            expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
            paths = output
              .split("\n")
              .filter((line) => line && !line.startsWith("#"))
              .map((line) => line.split(" — ")[0]!);
            const next = /nextOffset: (none|[0-9]+)/u.exec(output)![1];
            nextOffset = next === "none" ? null : Number(next);
            if (nextOffset !== null)
              expect(output).toContain(`# Continue with --offset ${nextOffset}`);
          }
          expect(paths.length).toBeGreaterThan(0);
          expect(paths).toHaveLength(4096);
          seen.push(...paths);
          if (nextOffset === null) break;
          expect(nextOffset).toBe(offset + paths.length);
          offset = nextOffset;
        }
        expect(seen).toEqual(frozen.entries.map((entry) => entry.codemodePath.join(".")));
      }
    }
    const maximum = JSON.parse(
      compactOutput(catalog(101), parseListOptions(["--json", "--limit", "100"])),
    );
    expect(maximum.tools).toHaveLength(100);
    expect(maximum.nextOffset).toBe(100);
    const remaining = JSON.parse(
      compactOutput(catalog(200), parseListOptions(["--json", "--query=docs", "--offset=7"])),
    );
    expect(remaining.tools).toHaveLength(193);
    expect(remaining.tools[0].path).toBe("docs.tool7");
    expect(remaining.tools[192].path).toBe("docs.tool199");
    expect(remaining.nextOffset).toBeNull();
  }, 60_000);

  test("text escapes terminal controls without altering JSON, filtering, or catalog content", () => {
    const frozen = catalog(1);
    const controls = String.fromCharCode(
      ...Array.from({ length: 32 }, (_, index) => index),
      ...Array.from({ length: 33 }, (_, index) => 127 + index),
    );
    const payload = `Search\u001b]52;c;VEVTVA==\u0007 CSI\u001b[2J Back\u0008 DEL\u007f C1\u009b${controls}`;
    for (const field of ["description", "title"] as const) {
      delete frozen.entries[0]!.description;
      delete frozen.entries[0]!.title;
      frozen.entries[0]![field] = payload;
      const before = JSON.stringify(frozen);
      const jsonBefore = compactOutput(frozen, parseListOptions(["--json"]));
      const text = compactOutput(frozen, parseListOptions([]));
      expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
      expect(text).toContain("Search\\u001b]52;c;VEVTVA==\\u0007");
      expect(text).toContain("CSI\\u001b[2J Back\\u0008 DEL\\u007f C1\\u009b");
      for (const character of controls) {
        if (!/\p{White_Space}/u.test(character)) {
          expect(text).toContain(`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
        }
      }
      expect(compactOutput(frozen, parseListOptions(["--json"]))).toBe(jsonBefore);
      expect(JSON.stringify(frozen)).toBe(before);
      const rawQuery = JSON.parse(
        compactOutput(frozen, parseListOptions(["--json", "--query", "\u001b]52"])),
      );
      expect(rawQuery.total).toBe(1);
      expect(rawQuery.tools[0].description).toBe(shortDescription(frozen.entries[0]!));
      const escapedQuery = JSON.parse(
        compactOutput(frozen, parseListOptions(["--json", "--query", "\\u001b]52"])),
      );
      expect(escapedQuery.total).toBe(0);
    }
  });

  test("terminal escape expansion does not drop tools", () => {
    const frozen = catalog(100);
    for (const entry of frozen.entries) entry.description = "\u001b".repeat(160);
    const output = compactOutput(frozen, parseListOptions(["--limit=100"]));
    expect(Buffer.byteLength(output, "utf8")).toBeGreaterThan(16_384);
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    const count = output.split("\n").filter((line) => line.startsWith("docs.")).length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBe(100);
    expect(output).toContain("nextOffset: none\n");
    const next = compactOutput(frozen, parseListOptions([`--offset=${count}`]));
    expect(next).not.toContain("docs.tool");
    expect(output).toContain("\\u001b".repeat(160));
  });

  test("query is literal, case-sensitive, normalized, and searches beyond displayed summaries", () => {
    const frozen = catalog(4);
    frozen.entries[0]!.description = "x".repeat(200) + " Needle\n\t界";
    frozen.entries[1]!.description = "Needle 界 and more";
    frozen.entries[2]!.description = "unrelated";
    frozen.entries[3]!.description = "";
    frozen.entries[3]!.title = "Title fallback";
    for (const [query, expected] of [
      ["Needle 界", ["docs.tool0", "docs.tool1"]],
      ["docs.tool2", ["docs.tool2"]],
      ["Title", ["docs.tool3"]],
      ["needle", []],
      [".*", []],
    ] as const) {
      const page = JSON.parse(
        compactOutput(frozen, parseListOptions(["--json", "--query", query])),
      );
      expect(page.total).toBe(expected.length);
      expect(page.tools.map((tool: { path: string }) => tool.path)).toEqual(expected);
      expect(page.nextOffset).toBeNull();
    }
    const page = JSON.parse(
      compactOutput(
        frozen,
        parseListOptions(["--json", "--query=Needle 界", "--limit=1", "--offset=1"]),
      ),
    );
    expect(page.total).toBe(2);
    expect(page.tools[0].path).toBe("docs.tool1");
    expect(page.nextOffset).toBeNull();
    for (const offset of [4, 5, Number.MAX_SAFE_INTEGER]) {
      const past = JSON.parse(
        compactOutput(frozen, parseListOptions(["--json", "--offset", String(offset)])),
      );
      expect(past).toMatchObject({ total: 4, offset, nextOffset: null, tools: [] });
    }
  });

  test("invalid flags, conflicting full mode, duplicate values, and unsafe numbers fail", () => {
    for (const args of [
      ["--limit", "0"],
      ["--limit", "101"],
      ["--limit", "1.5"],
      ["--limit", ""],
      ["--offset", "-1"],
      ["--offset", "1e2"],
      ["--offset", "0x10"],
      ["--offset", "+1"],
      ["--offset", "9007199254740992"],
      ["--offset", " 1"],
      ["--limit", "９"],
      ["--query"],
      ["--limit"],
      ["--offset"],
      ["--query", "--json"],
      ["--full", "--limit", "50"],
      ["--full", "--offset=0"],
      ["--full", "--query="],
      ["--full", "--json"],
      ["--json=true"],
      ["--limit=2", "--limit", "3"],
      ["--offset=0", "--offset=1"],
      ["--query=a", "--query=b"],
      ["--bogus"],
    ])
      expect(() => parseListOptions(args)).toThrow("usage:");
    expect(parseListOptions(["--query=--flag", "--limit=01", "--offset=0"])).toMatchObject({
      query: "--flag",
      limit: 1,
      offset: 0,
    });
    expect(parseListOptions(["--full"]).full).toBe(true);
  });

  test("the renderer never truncates a path to an aggregate output budget", () => {
    const frozen = catalog(1);
    frozen.entries[0]!.codemodePath = ["x".repeat(20_000), "tool"];
    for (const flags of [[], ["--json"]]) {
      expect(compactOutput(frozen, parseListOptions(flags))).toContain(
        "x".repeat(20_000) + ".tool",
      );
    }
  });
});
