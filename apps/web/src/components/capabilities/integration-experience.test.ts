import { describe, expect, test } from "bun:test";

import { integrationExperience } from "./integration-experience";
import type { IntegrationDefinitionSummary } from "@/types";

describe("integration experience descriptors", () => {
  test("presents reviewed Gmail capabilities without using raw scopes as the interface", () => {
    const experience = integrationExperience(gmailDefinition());

    expect(experience).toMatchObject({
      serviceName: "Gmail",
      providerName: "Google",
      icon: "mail",
    });
    expect(experience.capabilities.map((item) => item.title)).toEqual([
      "Find and understand mail",
      "Draft and send messages",
      "Organize the mailbox",
    ]);
    expect(experience.permissions.map((item) => item.label)).toContain(
      "Work with your Gmail mailbox",
    );

    const defaultCopy = JSON.stringify({
      introduction: experience.introduction,
      capabilities: experience.capabilities,
      permissionSummary: experience.permissionSummary,
      permissions: experience.permissions,
    });
    expect(defaultCopy).not.toContain("https://mail.google.com/");
    expect(experience.technicalDetails.oauthScopes).toContain("https://mail.google.com/");
  });

  test("falls back safely for a future provider without turning its schema into UX copy", () => {
    const experience = integrationExperience({
      id: "hubspot-crm-v3",
      name: "HubSpot CRM",
      summary: "Find and update customer records through reviewed tools.",
      provider: { id: "hubspot", domain: "api.hubapi.com" },
      authentication: {
        scopes: ["openid", "crm.objects.contacts.write"],
      },
    } as Parameters<typeof integrationExperience>[0]);

    expect(experience.providerName).toBe("HubSpot");
    expect(experience.icon).toBe("cloud");
    expect(experience.capabilities).toEqual([
      {
        title: "Use HubSpot CRM with agents",
        description: "Find and update customer records through reviewed tools.",
      },
    ]);
    expect(experience.permissions.map((item) => item.label)).toEqual(["Confirm your account"]);
    expect(JSON.stringify(experience.permissions)).not.toContain("crm.objects.contacts.write");
    expect(experience.technicalDetails).toEqual({
      providerDomain: "api.hubapi.com",
      oauthScopes: ["openid", "crm.objects.contacts.write"],
    });
  });
});

function gmailDefinition(): IntegrationDefinitionSummary {
  return {
    id: "google-gmail",
    name: "Gmail",
    summary: "Gmail messages, labels, drafts, and delivery.",
    protocol: "openapi",
    provider: { id: "google", domain: "gmail.googleapis.com" },
    authentication: {
      kind: "oauth2",
      scopes: ["openid", "email", "profile", "https://mail.google.com/"],
    },
    facets: [],
  };
}
