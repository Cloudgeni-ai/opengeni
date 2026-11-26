/*
 * The Delete account screen as settings data (see account-deletion.ts for
 * the server's side): what closes, what the person leaves, what blocks it,
 * and the typed confirmation.
 */
import {
  ACCOUNT_DELETION_CONFIRMATION,
  ACCOUNT_DELETION_STARTED_COPY,
  canRequestDeletion,
  deletionUnderway,
  retentionText,
  type AccountDeletionPreview,
} from "@/account-deletion";
import type { SettingsRow, SettingsSection } from "@/settings-model";

export type DeleteAccountActions = {
  typed: string;
  onType: (text: string) => void;
  submitting: boolean;
  /** Why the last request didn't go through. */
  error: string | null;
  /** Opens the organization's members on the web, or null when the app can't find it. */
  manageMembers: (organizationId: string) => (() => void) | null;
  checkAgain: () => void;
  submit: () => void;
};

export function deleteAccountSections(
  preview: AccountDeletionPreview,
  actions: DeleteAccountActions,
): SettingsSection[] {
  if (deletionUnderway(preview)) {
    return [
      {
        id: "underway",
        title: "Your account is being deleted",
        rows: [{ kind: "text", id: "underway", text: ACCOUNT_DELETION_STARTED_COPY, lines: 12 }],
      },
    ];
  }
  const sections: SettingsSection[] = [
    {
      id: "intro",
      rows: [
        {
          kind: "text",
          id: "intro",
          text: "Your Opengeni account and your personal data are deleted. This can't be undone.",
          lines: 12,
        },
      ],
    },
  ];
  if (preview.blockers.length) {
    sections.push({
      id: "blockers",
      title: "Before you can delete your account",
      footer:
        "Transfer ownership before deleting your account: make another member an owner, then check again.",
      rows: [
        ...preview.blockers.map((blocker): SettingsRow => {
          const open = actions.manageMembers(blocker.organizationId);
          return open
            ? {
                kind: "external",
                id: `blocker-${blocker.organizationId}`,
                title: blocker.name,
                subtitle: "You're its only owner · Manage members",
                symbol: "person.2",
                onPress: open,
              }
            : {
                kind: "navigate",
                id: `blocker-${blocker.organizationId}`,
                title: blocker.name,
                subtitle:
                  "You're its only owner · Transfer ownership in its People settings on the web",
              };
        }),
        {
          kind: "action",
          id: "check-again",
          title: "Check again",
          symbol: "arrow.clockwise",
          onPress: actions.checkAgain,
        },
      ],
    });
  }
  if (preview.closeOrganizations.length) {
    sections.push({
      id: "closes",
      title: "Closed with your account",
      footer:
        "Deleted with everything in them. Billing records the law requires us to keep are kept.",
      rows: preview.closeOrganizations.map((organization) => ({
        kind: "navigate" as const,
        id: `close-${organization.organizationId}`,
        title: organization.name,
      })),
    });
  }
  if (preview.leaveOrganizations.length) {
    sections.push({
      id: "leaves",
      title: "You'll leave",
      rows: preview.leaveOrganizations.map((organization) => ({
        kind: "navigate" as const,
        id: `leave-${organization.organizationId}`,
        title: organization.name,
        subtitle: retentionText(organization.retention),
      })),
    });
  }
  if (!preview.blockers.length) {
    sections.push({
      id: "confirm",
      title: `Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm`,
      footer: actions.error
        ? `${actions.error}\n\n${ACCOUNT_DELETION_STARTED_COPY}`
        : ACCOUNT_DELETION_STARTED_COPY,
      rows: [
        {
          kind: "field",
          id: "confirmation",
          placeholder: ACCOUNT_DELETION_CONFIRMATION,
          capitalization: "characters",
          onChange: actions.onType,
        },
        {
          kind: "destructive",
          id: "delete",
          title: actions.submitting ? "Deleting…" : "Delete account",
          disabled: !canRequestDeletion({
            preview,
            typed: actions.typed,
            submitting: actions.submitting,
          }),
          onPress: actions.submit,
        },
      ],
    });
  } else if (actions.error) {
    sections.push({ id: "error", footer: actions.error, rows: [] });
  }
  return sections;
}
