import { describe, expect, test } from "bun:test";
import { CORE_INTEGRATION_DEFINITIONS } from "@opengeni/capabilities";
import {
  CapabilityCatalogItem,
  type CapabilityCatalogItem as CatalogItem,
} from "@opengeni/contracts";
import {
  excelAddinCatalogItem,
  integrationDefinitionIdFromCapabilityId,
  nativeConnectionCapabilityRecommendations,
  searchCapabilityCatalogItems,
  suggestCapabilityCatalogItems,
} from "../src";

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
  describe("reviewed integration definitions", () => {
    const catalog = [
      item({
        id: "mcp:gmail",
        name: "Gmail",
        source: "built_in",
        category: "communication",
        description: "Search, read and draft email in the person's Gmail.",
        tags: ["gmail", "email", "mail", "google"],
        providerDomain: "google.com",
        authKind: "oauth2",
      }),
      item({
        id: "mcp:microsoft-learn",
        name: "Microsoft Learn",
        source: "registry",
        category: "documentation",
        description: "Search Microsoft documentation and code samples.",
        tags: ["microsoft", "docs", "azure"],
        providerDomain: "microsoft.com",
        authKind: "none",
        metadata: { mcpProbe: { status: "real" } },
      }),
      excelAddinCatalogItem({ name: "Example Assistant", installUrl: null }),
      item({
        id: "mcp:google-calendar",
        name: "Google Calendar",
        source: "built_in",
        category: "productivity",
        description:
          "Read, schedule and update events and meetings in the person's Google Calendar.",
        tags: ["calendar", "events", "meetings", "schedule", "google"],
        providerDomain: "google.com",
        authKind: "oauth2",
      }),
      item({
        id: "mcp:google-drive",
        name: "Google Drive",
        source: "built_in",
        category: "productivity",
        description: "Find, read and share files and documents in the person's Google Drive.",
        tags: ["drive", "files", "documents", "google"],
        providerDomain: "google.com",
        authKind: "oauth2",
      }),
      item({
        id: "mcp:slack",
        name: "Slack",
        source: "registry",
        category: "communication",
        description: "Read channels and send chat messages in Slack.",
        tags: ["slack", "chat", "messages", "channels"],
        providerDomain: "slack.com",
        authKind: "oauth2",
        metadata: { mcpProbe: { status: "real" } },
      }),
      item({
        id: "mcp:transcriber",
        name: "Transcriber",
        source: "registry",
        category: "productivity",
        description: "Live transcription and notes for calls.",
        tags: ["transcription", "notes", "audio"],
        providerDomain: "transcriber.example",
        authKind: "oauth2",
        metadata: { mcpProbe: { status: "real" } },
      }),
      ...nativeConnectionCapabilityRecommendations({
        integrationDefinitions: CORE_INTEGRATION_DEFINITIONS,
      }),
    ];
    const top = (query: string, count = 1) =>
      searchCapabilityCatalogItems(catalog, query)
        .slice(0, count)
        .map((result) => integrationDefinitionIdFromCapabilityId(result.item.id) ?? result.item.id);

    test("Outlook, Hotmail, Live and MSN mail requests find Outlook Mail first", () => {
      for (const query of [
        "Microsoft Outlook Hotmail email",
        "Hotmail",
        "read my newest hotmail emails",
        "Outlook email",
        "outlook.com inbox",
        "live.com mail",
        "MSN email",
      ]) {
        expect({ query, top: top(query) }).toEqual({ query, top: ["microsoft-outlook-mail"] });
      }
      expect(top("Outlook", 3)).toContain("microsoft-outlook-mail");
    });

    test("calendar, contacts, OneDrive and Teams requests find their own definition", () => {
      expect(top("Outlook calendar")).toEqual(["microsoft-outlook-calendar"]);
      expect(top("my hotmail calendar")).toEqual(["microsoft-outlook-calendar"]);
      expect(top("outlook calendar meetings")).toEqual(["microsoft-outlook-calendar"]);
      expect(top("Outlook contacts")).toEqual(["microsoft-outlook-contacts"]);
      expect(top("OneDrive")).toEqual(["microsoft-onedrive"]);
      expect(top("my onedrive files")).toEqual(["microsoft-onedrive"]);
      expect(top("Teams")).toEqual(["microsoft-teams"]);
      expect(top("Microsoft Teams chat")).toEqual(["microsoft-teams"]);
    });

    test("Gmail and Excel requests are unaffected", () => {
      expect(top("Gmail")).toEqual(["mcp:gmail"]);
      expect(top("my gmail inbox")).toEqual(["mcp:gmail"]);
      expect(top("read my gmail emails")).toEqual(["mcp:gmail"]);
      expect(top("Excel")).toEqual(["api:excel-addin"]);
      expect(top("Microsoft Learn docs")).toEqual(["mcp:microsoft-learn"]);
    });

    test("generic requests that never mention Microsoft keep their usual match", () => {
      expect(top("send an email")).toEqual(["mcp:gmail"]);
      expect(top("check my email")).toEqual(["mcp:gmail"]);
      expect(top("schedule a meeting")).toEqual(["mcp:google-calendar"]);
      expect(top("calendar")).toEqual(["mcp:google-calendar"]);
      expect(top("chat")).toEqual(["mcp:slack"]);
      expect(top("send a message in a channel")).toEqual(["mcp:slack"]);
      expect(top("my files")).toEqual(["mcp:google-drive"]);
      expect(top("live transcription")).toEqual(["mcp:transcriber"]);
      // A bare "mail" names "Outlook Mail" itself, so it is not a generic request here.
      for (const query of ["inbox", "email", "messages", "events", "documents"]) {
        expect({ query, top: top(query)[0]?.startsWith("microsoft-") }).toEqual({
          query,
          top: false,
        });
      }
    });

    test("entries are agent recommendations for the Connect card", () => {
      const outlook = catalog.find(
        (entry) => entry.id === "api:integration:microsoft-outlook-mail",
      );
      expect(outlook).toMatchObject({
        name: "Outlook Mail",
        kind: "api",
        source: "built_in",
        surfaceType: "integration_definition",
        lifecycle: { readiness: "setup_required" },
        metadata: { integrationDefinitionId: "microsoft-outlook-mail", recommendationOnly: true },
      });
      expect(nativeConnectionCapabilityRecommendations().map((entry) => entry.id)).toEqual([
        "api:github-app",
      ]);
    });
  });

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
