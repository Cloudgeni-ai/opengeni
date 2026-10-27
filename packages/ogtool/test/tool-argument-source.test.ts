import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readToolArguments } from "../src/tool-argument-source";

const encode = (text: string) => new TextEncoder().encode(text);

describe("ogtool call argument sources", () => {
  test("inline JSON and omitted arguments behave as before", async () => {
    expect(await readToolArguments(`{"query":"x"}`)).toEqual({ query: "x" });
    expect(await readToolArguments(undefined)).toEqual({});
  });

  test("@path reads one JSON object from a file, including paths with spaces", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ogtool-args-"));
    try {
      const path = join(directory, "large arguments.json");
      const payload = "a".repeat(300_000);
      await writeFile(path, JSON.stringify({ data: payload }));
      expect(await readToolArguments(`@${path}`)).toEqual({ data: payload });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("- reads one JSON object from stdin through EOF", async () => {
    let reads = 0;
    const value = await readToolArguments("-", {
      readStdin: async () => {
        reads += 1;
        return encode(`{"to":"me","body":"hi"}\n`);
      },
    });
    expect(value).toEqual({ to: "me", body: "hi" });
    expect(reads).toBe(1);
  });

  test("inline arguments and omitted arguments never read stdin", async () => {
    const readStdin = async () => {
      throw new Error("stdin must not be read");
    };
    expect(await readToolArguments(undefined, { readStdin })).toEqual({});
    expect(await readToolArguments(`{}`, { readStdin })).toEqual({});
  });

  test("unreadable, empty or non-UTF-8 sources fail without echoing input", async () => {
    await expect(readToolArguments("@")).rejects.toThrow(
      /^tool arguments file path is required after @$/u,
    );
    await expect(
      readToolArguments("@missing.json", {
        readFile: async () => {
          throw new Error("ENOENT secret-looking path");
        },
      }),
    ).rejects.toThrow(/^tool arguments file could not be read as UTF-8$/u);
    await expect(
      readToolArguments("@bad.json", { readFile: async () => new Uint8Array([0xff, 0xfe]) }),
    ).rejects.toThrow(/^tool arguments file could not be read as UTF-8$/u);
    await expect(
      readToolArguments("-", { readStdin: async () => new Uint8Array([0xc3]) }),
    ).rejects.toThrow(/^tool arguments could not be read as UTF-8 from stdin$/u);
    await expect(
      readToolArguments("-", { readStdin: async () => encode(`{"token":"not closed`) }),
    ).rejects.toThrow(/^tool arguments must be valid JSON$/u);
    await expect(
      readToolArguments("-", { readStdin: async () => encode(`["not","an","object"]`) }),
    ).rejects.toThrow(/^tool arguments must be a JSON object$/u);
  });
});
