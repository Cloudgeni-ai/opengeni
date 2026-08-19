import { describe, expect, test } from "bun:test";

import { capabilityPresentation, presentationPermissions } from "./integration-experience";

describe("integration presentation copy", () => {
  test("server presentation from a catalog row parses safely and drives the permissions", () => {
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
  });

  test("malformed shapes degrade to the generic copy instead of throwing", () => {
    expect(capabilityPresentation({})).toBeUndefined();
    expect(capabilityPresentation({ presentation: "junk" })).toBeUndefined();
    expect(capabilityPresentation({ presentation: { icon: "rocket" } })).toBeUndefined();
    expect(
      capabilityPresentation({ presentation: { capabilities: [{ title: "only-title" }] } }),
    ).toBeUndefined();
    expect(capabilityPresentation(null)).toBeUndefined();
  });

  test("an unlabeled scope never becomes UX copy", () => {
    expect(
      presentationPermissions(["openid", "crm.objects.contacts.write"], undefined).map(
        (item) => item.label,
      ),
    ).toEqual(["Confirm your account"]);
    expect(
      JSON.stringify(presentationPermissions(["crm.objects.contacts.write"], undefined)),
    ).not.toContain("crm.objects.contacts.write");
  });
});
