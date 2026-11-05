import { describe, expect, test } from "bun:test";
import {
  integrationMentionsIn,
  integrationNamesAgree,
  integrationVendorWord,
  isDistinctiveIntegrationMention,
  isIntegrationNearSpelling,
  registrableHostDomain,
  sharedVendorDomains,
} from "../src";

const kinds = (query: string, name: string, providerDomain?: string) =>
  integrationMentionsIn(query, { name, providerDomain }).map((mention) => mention.kind);

describe("integration names in a query", () => {
  test("the vendor word is the label before the public suffix", () => {
    expect(registrableHostDomain("api.example.co.uk")).toBe("example.co.uk");
    expect(integrationVendorWord("jira.com")).toBe("jira");
    expect(integrationVendorWord("docs.synthflow.ai")).toBe("synthflow");
    expect(integrationVendorWord("developers.intercom.com")).toBe("intercom");
    expect(integrationVendorWord("mcp.example.co.uk")).toBe("example");
    // Shared hosting says nothing about the vendor; short labels are not words.
    expect(integrationVendorWord("acme-mcp.vercel.app")).toBeNull();
    expect(integrationVendorWord("x.ai")).toBeNull();
  });

  test("a subdomain word is never the vendor's word", () => {
    expect(kinds("read the docs for this API", "Voice Agents", "docs.synthflow.ai")).toEqual([]);
    expect(kinds("ask the developers", "Intercom", "developers.intercom.com")).toEqual([]);
    expect(kinds("call them with synthflow", "Voice Agents", "docs.synthflow.ai")).toEqual([
      "domain",
    ]);
  });

  test("spacing, case and near spellings name the integration", () => {
    for (const query of [
      "dictate with whisperflow",
      "dictate with Whisper Flow",
      "use wisprflow",
      "send it to WisprFlow",
      "send it to wipsr flow",
    ])
      expect(kinds(query, "Wispr Flow").length).toBeGreaterThan(0);
    expect(kinds("add the lead to hub spot", "HubSpot")).toEqual(["joined"]);
    expect(kinds("update HUBSPOT", "HubSpot")).toEqual(["name"]);
    expect(kinds("find my jira tickets", "Atlassian", "jira.com")).toEqual(["domain"]);
  });

  test("swapped neighbouring letters name a name of five or more letters", () => {
    for (const [word, name] of [
      ["hubsopt", "hubspot"],
      ["slakc", "slack"],
      ["notoin", "notion"],
      ["atlasisan", "atlassian"],
    ] as const)
      expect(isIntegrationNearSpelling(word, name)).toBe(true);
    // Any other change to a short name meets common words.
    for (const [word, name] of [
      ["email", "gmail"],
      ["slick", "slack"],
      ["strike", "stripe"],
      ["discard", "discord"],
      ["motion", "notion"],
      ["bxo", "box"],
    ] as const)
      expect(isIntegrationNearSpelling(word, name)).toBe(false);
  });

  test("a plural of a name is the ordinary word", () => {
    expect(kinds("draw snowflakes", "Snowflake")).toEqual([]);
    expect(kinds("list the mailchimps", "Mailchimp")).toEqual([]);
    expect(kinds("query snowflake", "Snowflake")).toEqual(["name"]);
  });

  test("a vendor domain several differently named products share is no one's", () => {
    const products = [
      { name: "Microsoft Teams", providerDomain: "microsoft.com" },
      { name: "OneDrive", providerDomain: "microsoft.com" },
      { name: "Atlassian", providerDomain: "jira.com" },
      { name: "Atlassian (v1)", providerDomain: "jira.com" },
    ];
    const sharedDomains = sharedVendorDomains(products);
    expect([...sharedDomains]).toEqual(["microsoft.com"]);
    expect(integrationNamesAgree("Atlassian (v1)", "Atlassian")).toBe(true);
    expect(integrationNamesAgree("Microsoft Teams", "Microsoft Excel")).toBe(false);
    const named = (query: string) =>
      products
        .filter((product) => integrationMentionsIn(query, product, { sharedDomains }).length)
        .map((product) => product.name);
    expect(named("check my Microsoft account settings")).toEqual([]);
    expect(named("post in Microsoft Teams")).toEqual(["Microsoft Teams"]);
    expect(named("find my jira tickets")).toEqual(["Atlassian", "Atlassian (v1)"]);
  });

  test("words never join across function words, determiners or other parts", () => {
    for (const [query, name] of [
      ["issues linked in this PR", "LinkedIn"],
      ["on the last pass", "LastPass"],
      ["plan my work day", "Workday"],
      ["add one note", "OneNote"],
      ["follow up work", "Upwork"],
    ] as const)
      expect(kinds(query, name)).toEqual([]);
  });

  test("an ordinary word is a mention, but not a distinctive one unless capitalised", () => {
    const distinctive = (query: string, name: string, providerDomain?: string) =>
      integrationMentionsIn(query, { name, providerDomain }).some((mention) =>
        isDistinctiveIntegrationMention(mention, name),
      );
    for (const [query, name] of [
      ["close the ticket", "Close"],
      ["linear regression on the data", "Linear"],
      ["the box is empty", "Box"],
      ["front page news", "Front"],
      ["Close the ticket", "Close"],
    ] as const) {
      expect(kinds(query, name)).toEqual(["name"]);
      expect(distinctive(query, name)).toBe(false);
    }
    expect(distinctive("add the lead to hub spot", "HubSpot")).toBe(false);
    for (const [query, name, domain] of [
      ["Search Linear issues", "Linear", undefined],
      ["post it on Slack", "Slack", undefined],
      ["add the lead in hubspot", "HubSpot", undefined],
      ["dictate with whisperflow", "Wispr Flow", undefined],
      ["find my jira tickets", "Atlassian", "jira.com"],
      ["update the google calendar", "Google Calendar", undefined],
    ] as const)
      expect(distinctive(query, name, domain)).toBe(true);
  });
});
