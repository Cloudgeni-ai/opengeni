import { describe, expect, test } from "bun:test";

import {
  capabilityPresentation,
  integrationExperience,
  presentationPermissions,
} from "./integration-experience";
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

  test("a known id without server presentation renders the generic fallback (no hardcoded table)", () => {
    const definition = gmailDefinition();
    delete definition.presentation;
    const experience = integrationExperience(definition);
    expect(experience.icon).toBe("cloud");
    expect(experience.introduction).toBe("Let agents use Gmail through the account you choose.");
    expect(experience.capabilities).toEqual([
      {
        title: "Use Gmail with agents",
        description: "Gmail messages, labels, drafts, and delivery.",
      },
    ]);
    // Common scope labels stay in code; the Gmail-specific one is gone.
    expect(experience.permissions.map((item) => item.label)).toEqual([
      "Confirm your account",
      "See your account email",
      "See your basic profile",
    ]);
  });

  test("server presentation from a catalog row parses safely and drives the same permissions", () => {
    const presentation = capabilityPresentation({
      presentation: {
        providerName: "Google",
        icon: "mail",
        introduction: "Let agents work with the Gmail account you choose.",
        capabilities: [{ title: "Find mail", description: "Search messages." }],
        permissionSummary: "Google asks for mailbox access.",
        scopeLabels: {
          "https://www.googleapis.com/auth/gmail.readonly": {
            label: "Read your mail",
            description: "Search and read messages.",
          },
        },
      },
    });
    expect(presentation).toMatchObject({ providerName: "Google", icon: "mail" });
    expect(
      presentationPermissions(
        ["openid", "https://www.googleapis.com/auth/gmail.readonly", "unlabeled:scope"],
        presentation,
      ).map((item) => item.label),
    ).toEqual(["Confirm your account", "Read your mail"]);

    // Malformed shapes degrade to undefined (generic copy), never throw.
    expect(capabilityPresentation({})).toBeUndefined();
    expect(capabilityPresentation({ presentation: "junk" })).toBeUndefined();
    expect(capabilityPresentation({ presentation: { icon: "rocket" } })).toBeUndefined();
    expect(
      capabilityPresentation({ presentation: { capabilities: [{ title: "only-title" }] } }),
    ).toBeUndefined();
    expect(capabilityPresentation(null)).toBeUndefined();
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
    // The reviewed copy is server data now (INTEGRATION_DEFINITION_PRESENTATIONS
    // in @opengeni/capabilities, served on the definition). This mirrors what
    // the definitions endpoint returns for google-gmail.
    presentation: {
      providerName: "Google",
      icon: "mail",
      introduction: "Let agents work with the Gmail account you choose.",
      capabilities: [
        {
          title: "Find and understand mail",
          description: "Search messages and threads, then use them as context for your work.",
        },
        {
          title: "Draft and send messages",
          description: "Prepare replies and send mail through the reviewed Gmail tools.",
        },
        {
          title: "Organize the mailbox",
          description: "Work with labels, drafts, messages, and threads.",
        },
      ],
      permissionSummary:
        "Google grants broad mailbox access. OpenGeni still exposes only the reviewed tools configured for this integration.",
      scopeLabels: {
        "https://mail.google.com/": {
          label: "Work with your Gmail mailbox",
          description: "Read, organize, draft, and send mail for the account you approve.",
        },
      },
    },
    facets: [],
  };
}
