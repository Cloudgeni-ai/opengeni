import { describe, expect, test } from "bun:test";
import {
  CapabilityCatalogItem,
  type CapabilityCatalogItem as CatalogItem,
} from "@opengeni/contracts";
import { searchCapabilityCatalogItems, suggestCapabilityCatalogItems } from "../src";

function item(input: Partial<CatalogItem> & Pick<CatalogItem, "id" | "name">): CatalogItem {
  return CapabilityCatalogItem.parse({
    kind: "mcp",
    source: "manual",
    category: "integrations",
    runtime: { available: true, notes: null },
    ...input,
  });
}

describe("agent capability catalog search", () => {
  test("prefers the exact built-in GitHub adapter over incidental GitHub text", () => {
    const results = searchCapabilityCatalogItems(
      [
        item({
          id: "mcp:community-docs",
          name: "Repository Docs",
          description: "Documentation hosted on GitHub.",
          source: "registry",
          providerDomain: "docs.example.com",
          authKind: "none",
          metadata: { mcpProbe: { status: "real" } },
        }),
        item({
          id: "api:github-app",
          name: "GitHub App",
          kind: "api",
          source: "built_in",
          category: "source-control",
          tags: ["github", "repositories"],
          providerDomain: "github.com",
          authKind: "oauth2",
        }),
      ],
      "GitHub repositories",
    );

    expect(results[0]?.item.id).toBe("api:github-app");
    expect(results[0]?.matchedOn).toEqual(expect.arrayContaining(["name", "provider", "tag"]));
  });

  test("finds provider capabilities by outcome and excludes untrusted registry rows", () => {
    const trusted = item({
      id: "mcp:posthog",
      name: "PostHog",
      source: "registry",
      category: "analytics",
      tags: ["product", "analytics"],
      description: "Query product analytics and feature flags.",
      providerDomain: "posthog.com",
      authKind: "oauth2",
      tier: "verified",
      metadata: { mcpProbe: { status: "real" } },
    });
    const untrusted = item({
      id: "mcp:posthog-lookalike",
      name: "PostHog Super Connector",
      source: "registry",
      providerDomain: "lookalike.example",
      authKind: "unknown",
      metadata: {},
    });

    const results = searchCapabilityCatalogItems([untrusted, trusted], "product analytics");
    expect(results.map((result) => result.item.id)).toEqual(["mcp:posthog"]);
  });

  test("ranks an exact Slack notifications capability above generic messaging", () => {
    const results = searchCapabilityCatalogItems(
      [
        item({
          id: "mcp:generic-messages",
          name: "Messages",
          description: "Read team messages and notifications.",
        }),
        item({
          id: "mcp:slack",
          name: "Slack",
          providerDomain: "slack.com",
          tags: ["notifications", "messages", "team"],
          description: "Read channels and deliver Slack notifications.",
          tier: "verified",
        }),
      ],
      "Slack notifications",
    );

    expect(results[0]?.item.id).toBe("mcp:slack");
  });

  test("is deterministic and honors the result bound", () => {
    const candidates = Array.from({ length: 25 }, (_, index) =>
      item({ id: `mcp:notify-${index}`, name: `Notify ${String(index).padStart(2, "0")}` }),
    );
    const first = searchCapabilityCatalogItems(candidates, "notify", 3);
    const second = searchCapabilityCatalogItems([...candidates].reverse(), "notify", 3);
    expect(first.map((result) => result.item.id)).toEqual(second.map((result) => result.item.id));
    expect(first).toHaveLength(3);
  });

  test("keeps ranked discovery bounded across five thousand catalog entries", () => {
    const candidates = Array.from({ length: 5_000 }, (_, index) =>
      item({
        id: `mcp:catalog-${index}`,
        name: index === 4_876 ? "Needle Incident Response" : `Catalog Service ${index}`,
        description:
          index === 4_876
            ? "Investigate production incidents and coordinate response."
            : `General service catalog row ${index}.`,
        tags: index === 4_876 ? ["needle", "incidents", "operations"] : ["catalog"],
        providerDomain: index === 4_876 ? "needle.example" : `service-${index}.example`,
        tier: "verified",
        metadata: { mcpProbe: { status: "real" } },
      }),
    );

    const startedAt = performance.now();
    const results = searchCapabilityCatalogItems(candidates, "needle incident response", 20);
    const durationMs = performance.now() - startedAt;

    expect(results[0]?.item.id).toBe("mcp:catalog-4876");
    expect(results).toHaveLength(1);
    expect(durationMs).toBeLessThan(1_000);
  });

  describe("near-spelled integration names", () => {
    // A manually added custom MCP entry whose display name is misspelled
    // relative to the vendor brand, with no description, providerDomain, or tags.
    const whisprflow = item({
      id: "mcp:whisprflow-12vcsia",
      name: "Whisprflow",
      endpointUrl: "https://api.wisprflow.ai/connect/mcp",
    });
    const unrelated = [
      item({ id: "mcp:linear", name: "Linear", providerDomain: "linear.app" }),
      item({ id: "mcp:notion", name: "Notion", providerDomain: "notion.so" }),
      item({ id: "mcp:whimsical", name: "Whimsical", providerDomain: "whimsical.com" }),
    ];

    for (const query of ["Wispr", "Wisprflow", "Wispr Flow", "wispr-flow", "Whisprflow"]) {
      test(`finds the custom MCP for ${JSON.stringify(query)}`, () => {
        const results = searchCapabilityCatalogItems([...unrelated, whisprflow], query);
        expect(results[0]?.item.id).toBe("mcp:whisprflow-12vcsia");
      });
    }

    test("derives the vendor domain from a custom endpoint host", () => {
      const results = searchCapabilityCatalogItems([whisprflow], "wisprflow.ai");
      expect(results[0]?.item.id).toBe("mcp:whisprflow-12vcsia");
      expect(results[0]?.matchedOn).toContain("provider");
      expect(results[0]?.approximate).toBe(false);
    });

    test("flags typo-only matches as approximate", () => {
      const nameOnly = item({ id: "mcp:whisprflow", name: "Whisprflow" });
      const [result] = searchCapabilityCatalogItems([nameOnly], "Wisprflow");
      expect(result?.item.id).toBe("mcp:whisprflow");
      expect(result?.approximate).toBe(true);
      expect(result?.matchedOn).toEqual(["name"]);
    });

    test("keeps exact matches above typo-tolerant ones", () => {
      const results = searchCapabilityCatalogItems(
        [item({ id: "mcp:slack", name: "Slack" }), item({ id: "mcp:slick", name: "Slick" })],
        "slack",
      );
      expect(results.map((result) => [result.item.id, result.approximate])).toEqual([
        ["mcp:slack", false],
        ["mcp:slick", true],
      ]);
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score * 3);
      const typo = searchCapabilityCatalogItems(
        [
          item({ id: "mcp:posthog", name: "PostHog" }),
          item({ id: "mcp:postman", name: "Postman" }),
        ],
        "posthgo",
      );
      expect(typo[0]?.item.id).toBe("mcp:posthog");
      expect(typo[0]?.approximate).toBe(true);
    });

    test("does not fuzz short tokens", () => {
      expect(searchCapabilityCatalogItems([item({ id: "mcp:jet", name: "Jet" })], "jex")).toEqual(
        [],
      );
    });

    test("does not derive a vendor domain for registry rows", () => {
      const hosted = item({
        id: "mcp:hosted",
        name: "Hosted Tool",
        source: "registry",
        endpointUrl: "https://server.example-host.dev/mcp",
        authKind: "none",
        metadata: { mcpProbe: { status: "real" } },
      });
      expect(searchCapabilityCatalogItems([hosted], "examplehost")).toEqual([]);
    });

    test("suggests the closest names when nothing matches", () => {
      const catalog = [...unrelated, whisprflow];
      expect(searchCapabilityCatalogItems(catalog, "Wspr Flw")).toEqual([]);
      const suggestions = suggestCapabilityCatalogItems(catalog, "Wspr Flw", 3);
      expect(suggestions).toHaveLength(3);
      expect(suggestions[0]?.item.id).toBe("mcp:whisprflow-12vcsia");
      expect(suggestions[0]!.similarity).toBeGreaterThan(suggestions[1]!.similarity);
      expect(suggestCapabilityCatalogItems([...catalog].reverse(), "Wspr Flw", 3)).toEqual(
        suggestions,
      );
    });

    test("suggestions let an empty query browse the catalog and skip untrusted rows", () => {
      const untrusted = item({
        id: "mcp:untrusted",
        name: "Aardvark",
        source: "registry",
        authKind: "unknown",
        metadata: {},
      });
      const suggestions = suggestCapabilityCatalogItems(
        [untrusted, ...unrelated, whisprflow],
        "  ",
      );
      expect(suggestions.map((suggestion) => suggestion.item.name)).toEqual([
        "Linear",
        "Notion",
        "Whimsical",
        "Whisprflow",
      ]);
    });
  });
});
