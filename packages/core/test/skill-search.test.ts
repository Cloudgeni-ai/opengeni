import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  createPublicSkillSearchClient,
  PublicSkillSearchError,
  type PublicSkillSearchInput,
} from "../src/domain/skill-search";

// Fixture based on the official CLI-used endpoint observed 2026-09-08.
const skill = {
  id: "vercel-labs/agent-skills/vercel-react-best-practices",
  skillId: "vercel-react-best-practices",
  name: "vercel-react-best-practices",
  source: "vercel-labs/agent-skills",
  installs: 697179,
};
const fixture = {
  query: "react",
  searchType: "fuzzy",
  searchVersion: "legacy",
  skills: [skill],
  count: 1,
  duration_ms: 242,
};
const settings = testSettings();

describe("public Skill search", () => {
  test("makes exactly one credential-free bounded search request and normalizes metadata", async () => {
    let calls = 0;
    const client = createPublicSkillSearchClient(
      settings,
      async (url, init, actualSettings, options) => {
        calls++;
        expect(String(url)).toBe(
          "https://skills.sh/api/search?q=react+%26+native&limit=2&owner=vercel-labs",
        );
        expect(init?.headers).toEqual({ accept: "application/json" });
        expect(init?.credentials).toBe("omit");
        expect(init?.redirect).toBe("manual");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(actualSettings).toBe(settings);
        expect(options?.requireHttpsOutsideLocalTest).toBe(true);
        return Response.json(fixture);
      },
    );
    const result = await client.search({
      query: " react & native ",
      limit: 2,
      owner: "VERCEL-LABS",
    });
    expect(calls).toBe(1);
    expect(result).toEqual({
      provider: "skills_sh",
      query: "react & native",
      nextCursor: null,
      items: [{ ...skill, url: `https://skills.sh/${skill.id}` }],
    });
  });

  test("accepts genuine empty results and tolerates additive upstream fields", async () => {
    const client = createPublicSkillSearchClient(settings, async () =>
      Response.json({ skills: [], futureField: true }),
    );
    expect((await client.search({ query: "no match" })).items).toEqual([]);
  });

  test("validates input locally before any fetch", async () => {
    let calls = 0;
    const client = createPublicSkillSearchClient(settings, async () => {
      calls++;
      return Response.json(fixture);
    });
    const invalid: PublicSkillSearchInput[] = [
      { query: " " },
      { query: "r" },
      { query: "x".repeat(201) },
      { query: "re\u001bact" },
      { query: "react", limit: 0 },
      { query: "react", limit: 21 },
      { query: "react", limit: 1.5 },
      { query: "react", owner: "" },
      { query: "react", owner: "a/b" },
    ];
    for (const input of invalid)
      await expect(client.search(input)).rejects.toMatchObject({ code: "invalid_query" });
    expect(calls).toBe(0);
  });

  test("preserves ranking, deduplicates, caps output, and does not trust upstream URLs", async () => {
    const second = {
      ...skill,
      id: "acme/skills/second",
      source: "acme/skills",
      skillId: "second",
      installs: 9999999,
      url: "http://127.0.0.1/secret",
    };
    const client = createPublicSkillSearchClient(settings, async () =>
      Response.json({ skills: [skill, skill, second] }),
    );
    const result = await client.search({ query: "react", limit: 2 });
    expect(result.items.map((item) => item.id)).toEqual([skill.id, second.id]);
    expect(result.items[1]!.url).toBe("https://skills.sh/acme/skills/second");
    expect((await client.search({ query: "react", limit: 1 })).items).toHaveLength(1);
  });

  test("rejects malformed identities, owner leakage, unsupported sources, and schema drift", async () => {
    const payloads = [
      {},
      { skills: null },
      { data: [skill] },
      { skills: Array(21).fill(skill) },
      ...[
        { id: "https://evil.example/x" },
        { source: "different/repo" },
        { skillId: "different" },
        { id: "vercel-labs/agent-skills/.." },
        { installs: -1 },
        { installs: 0.5 },
        { name: "name\u001b[0m" },
        { name: " " },
        { source: "example.com" },
      ].map((patch) => ({ skills: [{ ...skill, ...patch }] })),
    ];
    for (const payload of payloads) {
      const client = createPublicSkillSearchClient(settings, async () => Response.json(payload));
      await expect(client.search({ query: "react" })).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
    const client = createPublicSkillSearchClient(settings, async () => Response.json(fixture));
    await expect(client.search({ query: "react", owner: "acme" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  test("returns typed rate limits with delta/date Retry-After and cancels error bodies", async () => {
    let canceled = false;
    const client = createPublicSkillSearchClient(
      settings,
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
          { status: 429, headers: { "retry-after": "42" } },
        ),
    );
    await expect(client.search({ query: "react" })).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 42,
    });
    expect(canceled).toBe(true);
    for (const retryAfter of ["garbage", new Date(Date.now() + 120_000).toUTCString()]) {
      const dated = createPublicSkillSearchClient(
        settings,
        async () => new Response(null, { status: 429, headers: { "retry-after": retryAfter } }),
      );
      try {
        await dated.search({ query: "react" });
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(PublicSkillSearchError);
        const seconds = (error as PublicSkillSearchError).retryAfterSeconds;
        if (retryAfter === "garbage") expect(seconds).toBeNull();
        else {
          expect(seconds).toBeGreaterThan(110);
          expect(seconds).toBeLessThanOrEqual(120);
        }
      }
    }
  });

  test("does not follow redirects or collapse upstream failures into empty results", async () => {
    for (const status of [301, 307, 400, 401, 403, 500, 503]) {
      let calls = 0;
      const client = createPublicSkillSearchClient(settings, async () => {
        calls++;
        return new Response("secret upstream text", {
          status,
          headers: { location: "http://127.0.0.1" },
        });
      });
      await expect(client.search({ query: "react" })).rejects.toMatchObject({
        code: "unavailable",
        message: "Public Skill search is unavailable",
      });
      expect(calls).toBe(1);
    }
    const client = createPublicSkillSearchClient(settings, async () => {
      throw new Error("secret transport detail");
    });
    await expect(client.search({ query: "react" })).rejects.toMatchObject({
      code: "unavailable",
      message: "Public Skill search is unavailable",
    });
  });

  test("bounds bytes including bodies without Content-Length and rejects non-JSON", async () => {
    for (const body of ["not JSON", "x".repeat(256 * 1024 + 1)]) {
      const client = createPublicSkillSearchClient(settings, async () => new Response(body));
      await expect(client.search({ query: "react" })).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });

  test("aborts a stalled body at the total request deadline", async () => {
    let canceled = false;
    let signal: AbortSignal | null | undefined;
    const client = createPublicSkillSearchClient(settings, async (_url, init) => {
      signal = init?.signal;
      return new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
      );
    });
    await expect(client.search({ query: "react" })).rejects.toMatchObject({ code: "timeout" });
    expect(signal?.aborted).toBe(true);
    expect(canceled).toBe(true);
  }, 15_000);
});
