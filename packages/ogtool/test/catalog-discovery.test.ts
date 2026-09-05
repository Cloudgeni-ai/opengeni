import { describe, expect, test } from "bun:test";
import {
  createAttemptToolEnvironment,
  digestAttemptToolCatalog,
  parseVerifiedAttemptToolCatalog,
} from "@opengeni/codemode";
import { compactOutput, parseListOptions } from "../src/catalog-discovery";

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

describe("compact catalog pages", () => {
  test("default50/max100 and full4096 page walks preserve every complete path", () => {
    for (const extreme of [false, true]) {
      const frozen = catalog(4096, extreme);
      for (const json of [false, true]) {
        const seen: string[] = [];
        let offset = 0;
        for (;;) {
          const options = { ...parseListOptions([]), json, offset };
          const output = compactOutput(frozen, options);
          expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(16_384);
          let paths: string[];
          let nextOffset: number | null;
          if (json) {
            const page = JSON.parse(output);
            expect(Object.keys(page).sort()).toEqual(["catalogDigest", "nextOffset", "offset", "tools", "total"]);
            expect(page.catalogDigest).toBe(frozen.digest);
            expect(page.total).toBe(4096);
            expect(page.offset).toBe(offset);
            paths = page.tools.map((tool: { path: string }) => tool.path);
            nextOffset = page.nextOffset;
          } else {
            paths = output.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(" — ")[0]!);
            const next = /nextOffset: (none|[0-9]+)/u.exec(output)![1];
            nextOffset = next === "none" ? null : Number(next);
            if (nextOffset !== null) expect(output).toContain(`# Continue with --offset ${nextOffset}`);
          }
          expect(paths.length).toBeGreaterThan(0);
          expect(paths.length).toBeLessThanOrEqual(50);
          if (!extreme && offset === 0) expect(paths).toHaveLength(50);
          seen.push(...paths);
          if (nextOffset === null) break;
          expect(nextOffset).toBe(offset + paths.length);
          offset = nextOffset;
        }
        expect(seen).toEqual(frozen.entries.map((entry) => entry.codemodePath.join(".")));
      }
    }
    const maximum = JSON.parse(compactOutput(catalog(101), parseListOptions(["--json", "--limit", "100"])));
    expect(maximum.tools).toHaveLength(100);
    expect(maximum.nextOffset).toBe(100);
  }, 60_000);

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
      ["needle", []], [".*", []],
    ] as const) {
      const page = JSON.parse(compactOutput(frozen, parseListOptions(["--json", "--query", query])));
      expect(page.total).toBe(expected.length);
      expect(page.tools.map((tool: { path: string }) => tool.path)).toEqual(expected);
      expect(page.nextOffset).toBeNull();
    }
    const page = JSON.parse(compactOutput(frozen, parseListOptions(["--json", "--query=Needle 界", "--limit=1", "--offset=1"])));
    expect(page.total).toBe(2);
    expect(page.tools[0].path).toBe("docs.tool1");
    expect(page.nextOffset).toBeNull();
    for (const offset of [4, 5, Number.MAX_SAFE_INTEGER]) {
      const past = JSON.parse(compactOutput(frozen, parseListOptions(["--json", "--offset", String(offset)])));
      expect(past).toMatchObject({ total: 4, offset, nextOffset: null, tools: [] });
    }
  });

  test("invalid flags, conflicting full mode, duplicate values, and unsafe numbers fail", () => {
    for (const args of [
      ["--limit", "0"], ["--limit", "101"], ["--limit", "1.5"], ["--limit", ""],
      ["--offset", "-1"], ["--offset", "1e2"], ["--offset", "0x10"], ["--offset", "+1"],
      ["--offset", "9007199254740992"], ["--offset", " 1"], ["--limit", "９"],
      ["--query"], ["--limit"], ["--offset"], ["--query", "--json"],
      ["--full", "--limit", "50"], ["--full", "--offset=0"], ["--full", "--query="],
      ["--full", "--json"], ["--json=true"], ["--limit=2", "--limit", "3"],
      ["--offset=0", "--offset=1"], ["--query=a", "--query=b"], ["--bogus"],
    ]) expect(() => parseListOptions(args)).toThrow("usage:");
    expect(parseListOptions(["--query=--flag", "--limit=01", "--offset=0"])).toMatchObject({ query: "--flag", limit: 1, offset: 0 });
    expect(parseListOptions(["--full"]).full).toBe(true);
  });

  test("an impossible oversized callable path fails rather than truncating or looping", () => {
    const frozen = catalog(1);
    frozen.entries[0]!.codemodePath = ["x".repeat(20_000), "tool"];
    for (const flags of [[], ["--json"]]) {
      expect(() => compactOutput(frozen, parseListOptions(flags))).toThrow("16384-byte compact page limit");
    }
  });
});