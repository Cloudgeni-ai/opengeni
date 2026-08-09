import { describe, expect, test } from "bun:test";
import {
  CapabilityCatalogItem,
  type CapabilityCatalogItem as CatalogItem,
} from "@opengeni/contracts";
import { searchCapabilityCatalogItems } from "../src";

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
});
