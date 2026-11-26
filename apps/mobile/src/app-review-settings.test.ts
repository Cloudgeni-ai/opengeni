import { describe, expect, test } from "bun:test";
import type { AccountDeletionPreview } from "./account-deletion";
import { deleteAccountSections, type DeleteAccountActions } from "./account-deletion-settings";
import type { AiConsentStatus } from "./ai-consent-gate";
import { aiProvidersRow, aiProvidersSections } from "./ai-consent-settings";
import type { SettingsSection } from "./settings-model";

const status = (required: boolean): AiConsentStatus => ({
  required,
  disclosure: {
    version: "v".repeat(64),
    title: "Allow sharing with AI providers?",
    body: "The server's own words.",
    providers: ["Provider A", "Provider B"],
    privacyUrl: "https://example.com/privacy",
  },
  consent: required
    ? null
    : { version: "v".repeat(64), grantedAt: "2026-11-26T12:00:00.000Z", platform: "ios" },
});

const consentActions = () => {
  const done: string[] = [];
  return {
    done,
    actions: {
      allow: () => done.push("allow"),
      withdraw: () => done.push("withdraw"),
      openPrivacyPolicy: (url: string) => done.push(`open ${url}`),
      busy: false,
      error: null,
    },
  };
};

const rows = (sections: SettingsSection[]) => sections.flatMap((section) => section.rows);

describe("AI providers in Settings", () => {
  test("the row says the state, and is absent where the server asks nothing", () => {
    expect(aiProvidersRow({ status: status(false), supported: true }, () => {})).toMatchObject({
      title: "AI providers",
      detail: "Allowed",
    });
    expect(aiProvidersRow({ status: status(true), supported: true }, () => {})).toMatchObject({
      detail: "Not allowed",
    });
    expect(aiProvidersRow({ status: null, supported: null }, () => {})).not.toHaveProperty(
      "detail",
    );
    expect(aiProvidersRow({ status: null, supported: false }, () => {})).toBeNull();
  });

  test("shows the server's text and providers, and withdraws what was allowed", () => {
    const { done, actions } = consentActions();
    const sections = aiProvidersSections(status(false), actions);
    expect(sections.find((section) => section.id === "disclosure")?.title).toBe(
      "Allow sharing with AI providers?",
    );
    expect(rows(sections)).toContainEqual(
      expect.objectContaining({ kind: "text", text: "The server's own words." }),
    );
    expect(
      sections.find((section) => section.id === "providers")?.rows.map((row) => row.id),
    ).toEqual(["provider-Provider A", "provider-Provider B"]);
    const choice = rows(sections).find((row) => row.id === "withdraw");
    expect(choice?.kind).toBe("destructive");
    if (choice && "onPress" in choice) choice.onPress?.();
    const privacy = rows(sections).find((row) => row.id === "privacy-policy");
    if (privacy && "onPress" in privacy) privacy.onPress?.();
    expect(done).toEqual(["withdraw", "open https://example.com/privacy"]);
  });

  test("offers Allow when not allowed", () => {
    const { done, actions } = consentActions();
    const choice = rows(aiProvidersSections(status(true), actions)).find(
      (row) => row.id === "allow",
    );
    if (choice && "onPress" in choice) choice.onPress?.();
    expect(done).toEqual(["allow"]);
  });
});

const preview = (patch: Partial<AccountDeletionPreview> = {}): AccountDeletionPreview => ({
  closeOrganizations: [{ organizationId: "p", name: "Personal" }],
  leaveOrganizations: [
    { organizationId: "o", name: "Org", retention: { mode: "delete_after", days: 30 } },
  ],
  blockers: [],
  request: null,
  ...patch,
});

const deleteActions = (patch: Partial<DeleteAccountActions> = {}): DeleteAccountActions => ({
  typed: "",
  onType: () => {},
  submitting: false,
  error: null,
  manageMembers: () => null,
  checkAgain: () => {},
  submit: () => {},
  ...patch,
});

describe("Delete account", () => {
  test("lists what closes and what you leave; Delete waits for DELETE", () => {
    const sections = deleteAccountSections(preview(), deleteActions());
    expect(sections.map((section) => section.id)).toEqual(["intro", "closes", "leaves", "confirm"]);
    expect(rows(sections).find((row) => row.id === "leave-o")).toMatchObject({
      subtitle: "What you made there is deleted after 30 days",
    });
    expect(rows(sections).find((row) => row.id === "delete")).toMatchObject({ disabled: true });
    const typed = deleteAccountSections(preview(), deleteActions({ typed: "DELETE" }));
    expect(rows(typed).find((row) => row.id === "delete")).toMatchObject({ disabled: false });
    expect(sections.find((section) => section.id === "confirm")?.footer).toContain(
      "You'll be signed out on all devices immediately.",
    );
  });

  test("an organization only you own blocks it, with a way to its members", () => {
    const opened: string[] = [];
    const sections = deleteAccountSections(
      preview({
        blockers: [{ code: "LAST_ORGANIZATION_OWNER", organizationId: "o", name: "Org" }],
      }),
      deleteActions({ typed: "DELETE", manageMembers: (id) => () => opened.push(id) }),
    );
    expect(sections.map((section) => section.id)).not.toContain("confirm");
    const blocker = rows(sections).find((row) => row.id === "blocker-o");
    expect(blocker?.kind).toBe("external");
    if (blocker && "onPress" in blocker) blocker.onPress?.();
    expect(opened).toEqual(["o"]);
  });

  test("deletion already underway says so and offers nothing more", () => {
    const sections = deleteAccountSections(
      preview({
        request: {
          id: "r",
          operationId: "op",
          status: "pending",
          requestedAt: "2026-11-26T00:00:00Z",
          completedAt: null,
        },
      }),
      deleteActions({ typed: "DELETE" }),
    );
    expect(sections.map((section) => section.id)).toEqual(["underway"]);
  });
});
