/*
 * Settings for the AI-provider permission (see ai-consent-gate.ts), as
 * settings data: the Settings row and the AI providers screen.
 */
import type { AiConsentSnapshot, AiConsentStatus } from "@/ai-consent-gate";
import type { SettingsRow, SettingsSection } from "@/settings-model";

function grantedOn(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/** The Settings row, or none where the server asks for no permission. */
export function aiProvidersRow(
  snapshot: Pick<AiConsentSnapshot, "status" | "supported">,
  onPress: () => void,
): SettingsRow | null {
  if (snapshot.supported === false) return null;
  const status = snapshot.status;
  return {
    kind: "navigate",
    id: "ai-providers",
    title: "AI providers",
    ...(status ? { detail: status.required ? "Not allowed" : "Allowed" } : {}),
    onPress,
  };
}

/**
 * What the AI providers get, in the server's words, and the person's choice:
 * allowed (since when) with a way to withdraw it, or not allowed with a way
 * to allow it here.
 */
export function aiProvidersSections(
  status: AiConsentStatus,
  actions: {
    allow: () => void;
    withdraw: () => void;
    openPrivacyPolicy: (url: string) => void;
    busy: boolean;
    error: string | null;
  },
): SettingsSection[] {
  const { disclosure, consent } = status;
  const allowed = !status.required;
  const since = allowed && consent ? grantedOn(consent.grantedAt) : "";
  const sections: SettingsSection[] = [
    {
      id: "state",
      footer: allowed
        ? "You can withdraw this at any time. Opengeni then asks again before it sends anything."
        : consent
          ? "What's shared has changed since you allowed it. Read it and allow it again to keep using chats, calls and dictation."
          : "Chats, calls and dictation ask for this permission before they send anything.",
      rows: [
        {
          kind: "info",
          id: "state",
          title: "Sharing with AI providers",
          value: allowed ? "Allowed" : "Not allowed",
        },
        ...(since
          ? [{ kind: "info" as const, id: "since", title: "Allowed on", value: since }]
          : []),
      ],
    },
    {
      id: "disclosure",
      title: disclosure.title,
      rows: [{ kind: "text", id: "body", text: disclosure.body, lines: 40 }],
    },
  ];
  if (disclosure.providers.length) {
    sections.push({
      id: "providers",
      title: "Shared with",
      rows: disclosure.providers.map((provider) => ({
        kind: "navigate" as const,
        id: `provider-${provider}`,
        title: provider,
      })),
    });
  }
  const privacyUrl = disclosure.privacyUrl;
  if (privacyUrl) {
    sections.push({
      id: "privacy",
      rows: [
        {
          kind: "external",
          id: "privacy-policy",
          title: "Privacy policy",
          symbol: "hand.raised",
          onPress: () => actions.openPrivacyPolicy(privacyUrl),
        },
      ],
    });
  }
  sections.push({
    id: "choice",
    ...(actions.error ? { footer: actions.error } : {}),
    rows: [
      allowed
        ? {
            kind: "destructive",
            id: "withdraw",
            title: "Withdraw permission",
            disabled: actions.busy,
            onPress: actions.withdraw,
          }
        : {
            kind: "action",
            id: "allow",
            title: "Allow",
            symbol: "checkmark.circle",
            disabled: actions.busy,
            onPress: actions.allow,
          },
    ],
  });
  return sections;
}
